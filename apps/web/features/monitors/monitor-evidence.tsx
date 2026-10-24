import type { HistoryPage, IncidentHistoryPage, IncidentState, ManualRound } from './types';
import { formatMilliseconds, formatRatio, humanize } from './formatting';

export function ManualDiagnostic({
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
  if (result.kind === 'MULTI_LOCATION') {
    return <MultiLocationDiagnostic result={result} label="Latest manual diagnostic" />;
  }
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
      {result.redirects.length > 0 ? (
        <ol className="redirect-chain" aria-label="Redirect chain">
          {result.redirects.map((hop) => (
            <li key={hop.sequence}>
              <code>
                #{hop.source.targetId} {hop.source.origin}
              </code>
              <span aria-hidden="true"> → </span>
              <code>
                {hop.destination
                  ? `#${hop.destination.targetId} ${hop.destination.origin}`
                  : 'No valid destination'}
              </code>
              <small>
                {hop.statusCode} · {formatMilliseconds(hop.responseTimeMs)} ·{' '}
                {humanize(hop.headers)}
              </small>
            </li>
          ))}
        </ol>
      ) : null}
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

function MultiLocationDiagnostic({
  result,
  label,
}: {
  result: Extract<NonNullable<ManualRound['result']>, { kind: 'MULTI_LOCATION' }>;
  label: string;
}) {
  return (
    <div className="manual-diagnostic" aria-live="polite">
      <div className="diagnostic-heading">
        <span className="diagnostic-label">{label}</span>
        <strong className={`diagnostic-outcome diagnostic-${result.outcome.toLowerCase()}`}>
          {result.outcome}
        </strong>
      </div>
      <dl className="diagnostic-metrics">
        <Metric label="Evidence coverage" value={formatRatio(result.coverage)} />
        <Metric label="Reachability" value={formatRatio(result.reachability)} />
        <Metric label="Regions" value={String(result.counts.selected)} />
        <Metric label="Finalized" value={new Date(result.finalizedAt).toLocaleTimeString()} />
      </dl>
      {result.regions ? (
        <ul aria-label="Regional evidence">
          {result.regions.map((region) => (
            <li key={region.location}>
              <strong>{region.location}</strong> —{' '}
              {region.outcome === 'CONFIRMED_FAIL'
                ? 'Confirmed failure'
                : region.outcome === 'PASS'
                  ? 'Pass'
                  : region.outcome === 'UNKNOWN'
                    ? 'Unknown'
                    : 'Pending'}
              {region.executions.map((execution) =>
                execution.diagnosticSummary ? (
                  <small key={execution.id}>
                    {' '}
                    · {execution.role.toLowerCase()} ·{' '}
                    {execution.diagnosticSummary.statusCode ?? 'no HTTP'} ·{' '}
                    {formatMilliseconds(execution.diagnosticSummary.responseTimeMs)}
                  </small>
                ) : null,
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function CheckHistory({
  page,
  loading,
  onLoadMore,
  details,
  expandedRoundIds,
  loadingRoundIds,
  onToggleRound,
}: {
  page: HistoryPage | undefined;
  loading: boolean;
  onLoadMore: () => void;
  details: Record<string, ManualRound>;
  expandedRoundIds: Set<string>;
  loadingRoundIds: Set<string>;
  onToggleRound: (roundId: string) => void;
}) {
  if (!page && loading) return <p role="status">Loading check history…</p>;
  if (!page || page.items.length === 0) return <p>No checks recorded yet.</p>;
  return (
    <section aria-label="Check history">
      <ol>
        {page.items.map((round) => {
          const regionalResult = round.result?.kind === 'MULTI_LOCATION' ? round.result : null;
          const singleResult =
            round.result && round.result.kind !== 'MULTI_LOCATION' ? round.result : null;
          const isRegional = regionalResult !== null;
          const isExpanded = expandedRoundIds.has(round.id);
          const detail = details[round.id];
          return (
            <li key={round.id}>
              <strong>{round.trigger}</strong>{' '}
              {round.result
                ? isRegional
                  ? `${regionalResult.outcome} · ${formatRatio(regionalResult.coverage)}`
                  : `${singleResult!.outcome} · ${singleResult!.reason}`
                : round.assignmentStatus}
              {' · '}
              <time dateTime={round.createdAt}>{new Date(round.createdAt).toLocaleString()}</time>
              {isRegional ? (
                <>
                  {' '}
                  <button
                    className="quiet-button"
                    type="button"
                    disabled={loadingRoundIds.has(round.id)}
                    onClick={() => onToggleRound(round.id)}
                  >
                    {loadingRoundIds.has(round.id)
                      ? 'Loading evidence…'
                      : isExpanded
                        ? 'Hide regional evidence'
                        : 'Show regional evidence'}
                  </button>
                  {isExpanded && detail?.result?.kind === 'MULTI_LOCATION' ? (
                    <MultiLocationDiagnostic
                      result={detail.result}
                      label="Historical regional evidence"
                    />
                  ) : null}
                </>
              ) : null}
            </li>
          );
        })}
      </ol>
      {page.nextCursor ? (
        <button className="quiet-button" type="button" disabled={loading} onClick={onLoadMore}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </section>
  );
}

export function IncidentSummary({ state }: { state: IncidentState | undefined }) {
  if (state?.currentIncident) {
    if (state.multiLocationIncident) {
      const label =
        state.multiLocationIncident.severity === 'DOWN' ? 'MAJOR OUTAGE' : 'PARTIAL OUTAGE';
      return (
        <p aria-label="Incident state">
          <strong>Incident: {label}</strong> · Started{' '}
          {new Date(state.currentIncident.startedAt).toLocaleString()} · detected{' '}
          {new Date(state.currentIncident.openedAt).toLocaleString()}
          {state.multiLocationIncident.healthyRecoveryStreak > 0
            ? ` · Recovery ${state.multiLocationIncident.healthyRecoveryStreak}/${state.multiLocationIncident.healthyRecoveryThreshold} healthy rounds`
            : ''}
        </p>
      );
    }
    return (
      <p aria-label="Incident state">
        <strong>Incident: OPEN</strong> · Started{' '}
        {new Date(state.currentIncident.startedAt).toLocaleString()} · detected{' '}
        {new Date(state.currentIncident.openedAt).toLocaleString()} ·{' '}
        {state.failureStreak?.count ?? 0} consecutive failures
      </p>
    );
  }
  if (state?.failureStreak) {
    return (
      <p aria-label="Incident state">
        Incident watch: Failure {state.failureStreak.count}/{state.failureStreak.threshold}
      </p>
    );
  }
  return <p aria-label="Incident state">Incident: No active incident</p>;
}

export function IncidentHistory({
  page,
  loading,
  error,
  onRetry,
  onLoadMore,
}: {
  page: IncidentHistoryPage | undefined;
  loading: boolean;
  error: string | undefined;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  if (error) {
    return (
      <p role="alert">
        {error}{' '}
        <button className="quiet-button" type="button" onClick={onRetry}>
          Retry
        </button>
      </p>
    );
  }
  if (!page) return <p role="status">Loading incident history…</p>;
  if (page.items.length === 0) return <p>No incidents recorded yet.</p>;
  return (
    <section aria-label="Incident history">
      <ol>
        {page.items.map((incident) => (
          <li key={incident.id}>
            <strong>{incident.status}</strong> · Started{' '}
            {new Date(incident.startedAt).toLocaleString()}
            {incident.resolvedAt
              ? ` · Resolved ${new Date(incident.resolvedAt).toLocaleString()}`
              : ''}
          </li>
        ))}
      </ol>
      {page.nextCursor ? (
        <button className="quiet-button" type="button" disabled={loading} onClick={onLoadMore}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </section>
  );
}
