'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

interface Monitor {
  id: string;
  name: string;
  url: string;
  method: string;
  lifecycleState: string;
  timeoutMs: number;
  statusPolicy: { type: 'ANY_2XX' } | { type: 'EXACT'; statusCodes: number[] };
  locations: string[];
  createdAt: string;
}

interface FieldErrors {
  name?: string[];
  url?: string[];
  statusPolicy?: string[];
}

interface ApiError {
  message?: string;
  fields?: FieldErrors;
}

interface ManualRound {
  id: string;
  monitorId: string;
  status: 'PENDING' | 'COMPLETED';
  assignmentStatus: 'PENDING' | 'RUNNING' | 'COMPLETED';
  createdAt: string;
  result: {
    outcome: 'PASS' | 'FAIL' | 'UNKNOWN';
    stage: 'DNS' | 'CONNECT' | 'TLS' | 'HTTP' | 'PROBE';
    reason: string;
    statusCode: number | null;
    responseTimeMs: number | null;
    attemptDurationMs: number;
    checkedAt: string;
  } | null;
}

export function Dashboard() {
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [updatingPolicyIds, setUpdatingPolicyIds] = useState<Set<string>>(() => new Set());
  const [pageError, setPageError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [manualRounds, setManualRounds] = useState<Record<string, ManualRound>>({});
  const [runningMonitorIds, setRunningMonitorIds] = useState<Set<string>>(() => new Set());
  const [runErrors, setRunErrors] = useState<Record<string, string>>({});
  const pollTimeouts = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    void loadMonitors();

    const timeouts = pollTimeouts.current;
    return () => {
      for (const timeout of timeouts.values()) clearTimeout(timeout);
      timeouts.clear();
    };
  }, []);

  async function loadMonitors(): Promise<void> {
    setIsLoading(true);
    setPageError(undefined);

    try {
      const response = await fetch('/api/monitors', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Could not load monitors.');
      const body = (await response.json()) as { data: Monitor[] };
      setMonitors(body.data);
    } catch {
      setPageError(
        'Watchrail could not load your monitors. Check that the API and database are running.',
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function createMonitor(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setIsSubmitting(true);
    setPageError(undefined);
    setFieldErrors({});

    const form = event.currentTarget;
    const formData = new FormData(form);
    const statusPolicy = statusPolicyFromForm(formData);

    try {
      const response = await fetch('/api/monitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          name: formData.get('name'),
          url: formData.get('url'),
          statusPolicy,
        }),
      });

      const body = (await response.json()) as { data?: Monitor } & ApiError;
      if (!response.ok) {
        if (response.status === 400 && body.fields) setFieldErrors(body.fields);
        else setPageError('Watchrail could not save this monitor. Try again.');
        return;
      }

      if (!body.data) throw new Error('The API returned no monitor.');
      setMonitors((current) => [body.data as Monitor, ...current]);
      form.reset();
    } catch {
      setPageError('Watchrail could not reach the API. Check the local services and try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function runNow(monitorId: string): Promise<void> {
    setMonitorRunning(monitorId, true);
    setRunErrors((current) => omitKey(current, monitorId));

    try {
      const response = await fetch(`/api/monitors/${monitorId}/check-rounds`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Could not start the manual check.');

      const body = (await response.json()) as { data?: ManualRound };
      if (!body.data) throw new Error('The API returned no check round.');

      setManualRounds((current) => ({ ...current, [monitorId]: body.data as ManualRound }));
      schedulePoll(monitorId, body.data.id);
    } catch {
      setMonitorRunning(monitorId, false);
      setRunErrors((current) => ({
        ...current,
        [monitorId]: 'Watchrail could not start this diagnostic check. Try again.',
      }));
    }
  }

  async function updateStatusPolicy(
    monitorId: string,
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const statusPolicy = statusPolicyFromForm(formData);

    setUpdatingPolicyIds((current) => new Set(current).add(monitorId));
    setPageError(undefined);

    try {
      const response = await fetch(`/api/monitors/${monitorId}/status-policy`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ statusPolicy }),
      });
      const body = (await response.json()) as { data?: Monitor } & ApiError;
      if (!response.ok || !body.data) {
        throw new Error(body.fields?.statusPolicy?.[0] ?? 'Could not update status policy.');
      }
      setMonitors((current) =>
        current.map((monitor) => (monitor.id === monitorId ? (body.data as Monitor) : monitor)),
      );
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Could not update status policy.');
    } finally {
      setUpdatingPolicyIds((current) => {
        const next = new Set(current);
        next.delete(monitorId);
        return next;
      });
    }
  }

  function schedulePoll(monitorId: string, roundId: string): void {
    const existing = pollTimeouts.current.get(monitorId);
    if (existing) clearTimeout(existing);

    pollTimeouts.current.set(
      monitorId,
      setTimeout(() => void pollManualRound(monitorId, roundId), 750),
    );
  }

  async function pollManualRound(monitorId: string, roundId: string): Promise<void> {
    try {
      const response = await fetch(`/api/monitors/${monitorId}/check-rounds/${roundId}`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Could not load the manual check.');

      const body = (await response.json()) as { data?: ManualRound };
      if (!body.data) throw new Error('The API returned no check round.');

      setManualRounds((current) => ({ ...current, [monitorId]: body.data as ManualRound }));

      if (body.data.status === 'COMPLETED') {
        pollTimeouts.current.delete(monitorId);
        setMonitorRunning(monitorId, false);
        return;
      }

      schedulePoll(monitorId, roundId);
    } catch {
      pollTimeouts.current.delete(monitorId);
      setMonitorRunning(monitorId, false);
      setRunErrors((current) => ({
        ...current,
        [monitorId]: 'Watchrail lost contact while waiting for this diagnostic result.',
      }));
    }
  }

  function setMonitorRunning(monitorId: string, running: boolean): void {
    setRunningMonitorIds((current) => {
      const next = new Set(current);
      if (running) next.add(monitorId);
      else next.delete(monitorId);
      return next;
    });
  }

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Watchrail dashboard">
          <span className="brand-mark" aria-hidden="true">
            W
          </span>
          <span>Watchrail</span>
        </a>
        <span className="mode-badge">Local development identity</span>
      </header>

      <section className="hero" id="top">
        <div>
          <p className="eyebrow">MONITORING CONTROL PLANE</p>
          <h1>Know what is reachable.</h1>
          <p className="hero-copy">
            Create an endpoint, run a durable diagnostic check, and inspect the evidence without
            tying network work to the API request.
          </p>
        </div>
        <div className="hero-stat" aria-label={`${monitors.length} monitors configured`}>
          <span>{monitors.length}</span>
          <small>{monitors.length === 1 ? 'monitor' : 'monitors'}</small>
        </div>
      </section>

      {pageError ? (
        <div className="alert" role="alert">
          <span>{pageError}</span>
          <button type="button" onClick={() => void loadMonitors()}>
            Retry
          </button>
        </div>
      ) : null}

      <div className="dashboard-grid">
        <section className="panel form-panel" aria-labelledby="create-heading">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">NEW MONITOR</p>
              <h2 id="create-heading">Add an endpoint</h2>
            </div>

            <fieldset className="field">
              <legend>Expected status</legend>
              <label>
                <input name="statusPolicyMode" type="radio" value="ANY_2XX" defaultChecked />
                Any 2xx response
              </label>
              <label>
                <input name="statusPolicyMode" type="radio" value="EXACT" />
                Specific status codes
              </label>
              <input
                name="statusCodes"
                type="text"
                inputMode="numeric"
                placeholder="200, 204"
                aria-describedby={fieldErrors.statusPolicy ? 'status-policy-error' : undefined}
                aria-invalid={Boolean(fieldErrors.statusPolicy)}
              />
              {fieldErrors.statusPolicy ? (
                <p className="field-error" id="status-policy-error">
                  {fieldErrors.statusPolicy[0]}
                </p>
              ) : null}
            </fieldset>
            <span className="step">01</span>
          </div>

          <form onSubmit={(event) => void createMonitor(event)} noValidate>
            <div className="field">
              <label htmlFor="name">Monitor name</label>
              <input
                id="name"
                name="name"
                type="text"
                placeholder="Production API"
                maxLength={120}
                aria-describedby={fieldErrors.name ? 'name-error' : undefined}
                aria-invalid={Boolean(fieldErrors.name)}
              />
              {fieldErrors.name ? (
                <p className="field-error" id="name-error">
                  {fieldErrors.name[0]}
                </p>
              ) : null}
            </div>

            <div className="field">
              <label htmlFor="url">HTTP(S) URL</label>
              <input
                id="url"
                name="url"
                type="url"
                placeholder="https://api.example.com/health"
                aria-describedby={fieldErrors.url ? 'url-error' : 'url-help'}
                aria-invalid={Boolean(fieldErrors.url)}
              />
              {fieldErrors.url ? (
                <p className="field-error" id="url-error">
                  {fieldErrors.url[0]}
                </p>
              ) : (
                <p className="field-help" id="url-help">
                  Watchrail stores this configuration but does not call it during creation.
                </p>
              )}
            </div>

            <div className="defaults" aria-label="Initial monitor defaults">
              <Default label="Method" value="GET" />
              <Default label="Timeout" value="10 seconds" />
              <Default label="Location" value="Local" />
              <Default label="Lifecycle" value="Enabled" />
            </div>

            <button className="primary-button" type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create monitor'}
            </button>
          </form>
        </section>

        <section className="panel monitors-panel" aria-labelledby="monitors-heading">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">INVENTORY</p>
              <h2 id="monitors-heading">Configured monitors</h2>
            </div>
            <button className="quiet-button" type="button" onClick={() => void loadMonitors()}>
              Refresh
            </button>
          </div>

          {isLoading ? (
            <div className="state" role="status">
              <span className="spinner" aria-hidden="true" />
              Loading monitors…
            </div>
          ) : monitors.length === 0 ? (
            <div className="empty-state">
              <span className="empty-glyph" aria-hidden="true">
                +
              </span>
              <h3>No monitors yet</h3>
              <p>Create the first endpoint record with the form.</p>
            </div>
          ) : (
            <ul className="monitor-list">
              {monitors.map((monitor) => (
                <li key={monitor.id} className="monitor-card">
                  <div
                    className={`monitor-status monitor-status-${monitorState(manualRounds[monitor.id])}`}
                    aria-label={monitorStateLabel(manualRounds[monitor.id])}
                  >
                    <span aria-hidden="true" />
                  </div>
                  <div className="monitor-main">
                    <div className="monitor-title-row">
                      <h3>{monitor.name}</h3>
                      <button
                        className="run-button"
                        type="button"
                        disabled={runningMonitorIds.has(monitor.id)}
                        onClick={() => void runNow(monitor.id)}
                      >
                        {runningMonitorIds.has(monitor.id) ? 'Checking…' : 'Run now'}
                      </button>
                    </div>
                    <a href={monitor.url} target="_blank" rel="noreferrer">
                      {monitor.url}
                    </a>
                    <div className="monitor-meta">
                      <span>{monitor.method}</span>
                      <span>{monitor.timeoutMs / 1000}s timeout</span>
                      <span>{statusPolicyLabel(monitor.statusPolicy)}</span>
                      <span>{monitor.locations.join(', ')}</span>
                      <span>{monitor.lifecycleState.toLowerCase()}</span>
                    </div>
                    <form
                      className="status-policy-form"
                      onSubmit={(event) => void updateStatusPolicy(monitor.id, event)}
                    >
                      <label>
                        Expected status
                        <select name="statusPolicyMode" defaultValue={monitor.statusPolicy.type}>
                          <option value="ANY_2XX">Any 2xx response</option>
                          <option value="EXACT">Specific status codes</option>
                        </select>
                      </label>
                      <input
                        name="statusCodes"
                        type="text"
                        inputMode="numeric"
                        placeholder="200, 204"
                        defaultValue={
                          monitor.statusPolicy.type === 'EXACT'
                            ? monitor.statusPolicy.statusCodes.join(', ')
                            : ''
                        }
                        aria-label={`Specific status codes for ${monitor.name}`}
                      />
                      <button
                        className="quiet-button"
                        type="submit"
                        disabled={updatingPolicyIds.has(monitor.id)}
                      >
                        {updatingPolicyIds.has(monitor.id) ? 'Saving…' : 'Save policy'}
                      </button>
                    </form>
                    <ManualDiagnostic
                      round={manualRounds[monitor.id]}
                      error={runErrors[monitor.id]}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function statusPolicyLabel(policy: Monitor['statusPolicy']): string {
  return policy.type === 'ANY_2XX' ? 'any 2xx' : `status ${policy.statusCodes.join(', ')}`;
}

function statusPolicyFromForm(formData: FormData): Monitor['statusPolicy'] {
  if (formData.get('statusPolicyMode') !== 'EXACT') return { type: 'ANY_2XX' };

  const rawCodes = formData.get('statusCodes');
  const codes = typeof rawCodes === 'string' ? rawCodes : '';
  return {
    type: 'EXACT',
    statusCodes: codes.split(',').map((value) => Number(value.trim())),
  };
}

function ManualDiagnostic({
  round,
  error,
}: {
  round: ManualRound | undefined;
  error: string | undefined;
}) {
  if (error) {
    return (
      <p className="diagnostic-error" role="alert">
        {error}
      </p>
    );
  }

  if (!round) {
    return <p className="diagnostic-empty">No manual diagnostic started.</p>;
  }

  if (!round.result) {
    const pendingLabel = round.assignmentStatus === 'RUNNING' ? 'Executing check' : 'Queued';
    return (
      <div className="manual-diagnostic" aria-live="polite">
        <span className="diagnostic-label">Latest manual diagnostic</span>
        <strong className="diagnostic-pending">{pendingLabel}</strong>
      </div>
    );
  }

  const { result } = round;
  return (
    <div className="manual-diagnostic" aria-live="polite">
      <div className="diagnostic-heading">
        <span className="diagnostic-label">Latest manual diagnostic</span>
        <strong className={`diagnostic-outcome diagnostic-${result.outcome.toLowerCase()}`}>
          {result.outcome}
        </strong>
      </div>
      <dl className="diagnostic-metrics">
        <Metric label="HTTP" value={result.statusCode?.toString() ?? 'No response'} />
        <Metric label="Response" value={formatMilliseconds(result.responseTimeMs)} />
        <Metric label="Attempt" value={formatMilliseconds(result.attemptDurationMs)} />
        <Metric label="Checked" value={new Date(result.checkedAt).toLocaleTimeString()} />
      </dl>
      <p className="diagnostic-reason">
        {humanize(result.stage)} · {humanize(result.reason)}
      </p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatMilliseconds(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)} ms`;
}

function humanize(value: string): string {
  return value.toLowerCase().replaceAll('_', ' ');
}

function monitorState(
  round: ManualRound | undefined,
): 'awaiting' | 'pending' | 'pass' | 'fail' | 'unknown' {
  if (!round) return 'awaiting';
  if (!round.result) return 'pending';
  return round.result.outcome.toLowerCase() as 'pass' | 'fail' | 'unknown';
}

function monitorStateLabel(round: ManualRound | undefined): string {
  const state = monitorState(round);
  if (state === 'awaiting') return 'Awaiting manual diagnostic';
  if (state === 'pending') return 'Manual diagnostic in progress';
  return `Latest manual diagnostic: ${state}`;
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function Default({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
