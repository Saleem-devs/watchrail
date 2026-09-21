'use client';

import { useEffect, useState, type FormEvent } from 'react';

interface Monitor {
  id: string;
  name: string;
  url: string;
  method: string;
  lifecycleState: string;
  timeoutMs: number;
  locations: string[];
  createdAt: string;
}

interface FieldErrors {
  name?: string[];
  url?: string[];
}

interface ApiError {
  message?: string;
  fields?: FieldErrors;
}

export function Dashboard() {
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pageError, setPageError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  useEffect(() => {
    void loadMonitors();
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

    try {
      const response = await fetch('/api/monitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ name: formData.get('name'), url: formData.get('url') }),
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
            Create the endpoint record now. Watchrail will add durable checks, incidents, and
            regional evidence in the slices that follow.
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
                  <div className="monitor-status" aria-label="Awaiting first check">
                    <span aria-hidden="true" />
                  </div>
                  <div className="monitor-main">
                    <div className="monitor-title-row">
                      <h3>{monitor.name}</h3>
                      <span className="status-pill">Awaiting first check</span>
                    </div>
                    <a href={monitor.url} target="_blank" rel="noreferrer">
                      {monitor.url}
                    </a>
                    <div className="monitor-meta">
                      <span>{monitor.method}</span>
                      <span>{monitor.timeoutMs / 1000}s timeout</span>
                      <span>{monitor.locations.join(', ')}</span>
                      <span>{monitor.lifecycleState.toLowerCase()}</span>
                    </div>
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

function Default({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
