import { Button } from '../../components/ui/button';
import { classifyScheduledObservation } from '@watchrail/domain';
import type {
  AssertionEvaluation,
  HistoryPage,
  IncidentHistoryPage,
  IncidentState,
  ManualRound,
  Monitor,
} from './types';
import { formatMilliseconds, formatRatio, humanize } from './formatting';
import { AssertionDiagnostics, diagnosticFailureLabel } from './assertion-diagnostics';
import { TlsCertificateEvidencePanel } from './tls-certificate-evidence';

type DiagnosticOutcome =
  | 'PASS'
  | 'FAIL'
  | 'NOT_EVALUATED'
  | 'NO_RESPONSE'
  | 'HEALTHY'
  | 'UNHEALTHY'
  | 'INDETERMINATE'
  | 'UNKNOWN'
  | 'UP'
  | 'DEGRADED'
  | 'DOWN';

const outcomeTone: Record<DiagnosticOutcome, string> = {
  PASS: 'border-rail-success/35 bg-rail-success/10 text-rail-success',
  HEALTHY: 'border-rail-success/35 bg-rail-success/10 text-rail-success',
  UP: 'border-rail-success/35 bg-rail-success/10 text-rail-success',
  FAIL: 'border-rail-danger/35 bg-rail-danger/10 text-rail-danger',
  UNHEALTHY: 'border-rail-danger/35 bg-rail-danger/10 text-rail-danger',
  INDETERMINATE: 'border-rail-warning/35 bg-rail-warning/10 text-rail-warning',
  DOWN: 'border-rail-danger/35 bg-rail-danger/10 text-rail-danger',
  DEGRADED: 'border-rail-warning/35 bg-rail-warning/10 text-rail-warning',
  NOT_EVALUATED: 'border-rail-border-strong bg-rail-surface text-rail-subtle',
  NO_RESPONSE: 'border-rail-border-strong bg-rail-surface text-rail-subtle',
  UNKNOWN: 'border-rail-border-strong bg-rail-surface text-rail-subtle',
};

const outcomeLabel: Record<DiagnosticOutcome, string> = {
  PASS: 'Passed',
  FAIL: 'Failed',
  NOT_EVALUATED: 'Not evaluated',
  NO_RESPONSE: 'No response',
  HEALTHY: 'Healthy',
  UNHEALTHY: 'Unhealthy',
  INDETERMINATE: 'Indeterminate',
  UNKNOWN: 'Unknown',
  UP: 'Up',
  DEGRADED: 'Degraded',
  DOWN: 'Down',
};

function OutcomeBadge({ outcome }: { outcome: DiagnosticOutcome }) {
  return (
    <span
      className={`inline-flex min-h-7 items-center rounded-rail-control border px-2 py-1 text-xs font-semibold ${outcomeTone[outcome]}`}
    >
      {outcomeLabel[outcome]}
    </span>
  );
}

function singleLocationHealth(
  outcome: 'PASS' | 'FAIL' | 'UNKNOWN',
  reason: string,
  assertionOutcome: AssertionEvaluation['outcome'],
  protocol: Monitor['type'] = 'HTTP',
): 'HEALTHY' | 'UNHEALTHY' | 'INDETERMINATE' {
  return classifyScheduledObservation({
    outcome,
    reason,
    assertionOutcome: protocol === 'HTTP' ? assertionOutcome : 'PASS',
  });
}

function DiagnosticOutcomeSummary({
  outcome,
  reason,
  stage,
  statusCode,
  assertionEvaluation,
  protocol = 'HTTP',
}: {
  outcome: 'PASS' | 'FAIL' | 'UNKNOWN';
  reason: string;
  stage: string;
  statusCode: number | null;
  assertionEvaluation: AssertionEvaluation;
  protocol?: Monitor['type'];
}) {
  const executionOutcome: DiagnosticOutcome =
    protocol !== 'HTTP'
      ? outcome
      : (reason === 'CERTIFICATE_EXPIRING' || reason === 'CERTIFICATE_EVIDENCE_UNAVAILABLE') &&
          statusCode !== null
        ? 'PASS'
        : stage !== 'HTTP' || statusCode === null
          ? 'NO_RESPONSE'
          : outcome;
  const health = singleLocationHealth(outcome, reason, assertionEvaluation.outcome, protocol);
  return (
    <dl
      className={`grid gap-px border-t border-rail-border bg-rail-border ${protocol === 'HTTP' ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}
    >
      <DiagnosticSignal
        label={
          protocol === 'HTTP'
            ? 'HTTP execution'
            : protocol === 'TCP'
              ? 'TCP connection'
              : 'DNS lookup'
        }
        outcome={executionOutcome}
      />
      {protocol === 'HTTP' ? (
        <DiagnosticSignal label="Response validation" outcome={assertionEvaluation.outcome} />
      ) : null}
      <DiagnosticSignal label="Monitoring health" outcome={health} />
    </dl>
  );
}

function DiagnosticSignal({ label, outcome }: { label: string; outcome: DiagnosticOutcome }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 bg-rail-header px-4 py-3">
      <dt className="text-xs text-rail-muted">{label}</dt>
      <dd className="m-0">
        <OutcomeBadge outcome={outcome} />
      </dd>
    </div>
  );
}

export function ManualDiagnostic({
  round,
  error,
  protocol = 'HTTP',
}: {
  round: ManualRound | undefined;
  error: string | undefined;
  protocol?: Monitor['type'];
}) {
  if (error) {
    return (
      <p
        className="mt-4 mb-0 rounded-lg border border-rail-danger/30 bg-rail-danger/5 px-4 py-3 text-sm text-rail-danger"
        role="alert"
      >
        {error}
      </p>
    );
  }

  if (!round) {
    return (
      <p className="mt-4 mb-0 border-t border-rail-border pt-4 text-xs text-rail-muted">
        No manual diagnostic started.
      </p>
    );
  }

  if (!round.result) {
    const pendingLabel = round.assignmentStatus === 'RUNNING' ? 'Executing check' : 'Queued';
    return (
      <section
        className="manual-diagnostic mt-4 rounded-rail-panel border border-rail-border bg-rail-sidebar/45 p-4"
        aria-live="polite"
        aria-label="Latest manual diagnostic"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="m-0 text-sm font-semibold text-rail-text">Latest manual diagnostic</h4>
          <span className="inline-flex min-h-7 items-center rounded-rail-control border border-rail-warning/35 bg-rail-warning/10 px-2 py-1 text-xs font-semibold text-rail-warning">
            {pendingLabel}
          </span>
        </div>
      </section>
    );
  }

  const { result } = round;
  if (result.kind === 'MULTI_LOCATION') {
    return (
      <MultiLocationDiagnostic
        result={result}
        label="Latest manual diagnostic"
        protocol={protocol}
      />
    );
  }
  const assertionEvaluation = result.assertionEvaluation ?? {
    contractVersion: 1,
    outcome: result.assertionOutcome ?? 'NOT_EVALUATED',
    diagnostics: [],
  };
  const monitoringHealth = singleLocationHealth(
    result.outcome,
    result.reason,
    assertionEvaluation.outcome,
    protocol,
  );

  return (
    <section
      className="manual-diagnostic mt-4 overflow-hidden rounded-rail-panel border border-rail-border bg-rail-sidebar/45"
      aria-live="polite"
      aria-label="Latest manual diagnostic"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rail-border px-4 py-3">
        <h4 className="m-0 text-sm font-semibold text-rail-text">Latest manual diagnostic</h4>
        <OutcomeBadge outcome={monitoringHealth} />
      </div>
      <dl className="grid grid-cols-2 gap-px bg-rail-border sm:grid-cols-4">
        <Metric
          label={protocol === 'HTTP' ? 'HTTP' : protocol === 'TCP' ? 'Connection' : 'DNS lookup'}
          value={
            protocol === 'HTTP'
              ? (result.statusCode?.toString() ?? 'No response')
              : protocol === 'TCP'
                ? tcpConnectionState(result.outcome, result.reason)
                : dnsLookupState(result.outcome, result.reason)
          }
        />
        <Metric
          label={
            protocol === 'HTTP'
              ? 'Response'
              : protocol === 'TCP'
                ? 'Connect latency'
                : 'Query latency'
          }
          value={formatMilliseconds(result.responseTimeMs)}
        />
        <Metric label="Attempt" value={formatMilliseconds(result.attemptDurationMs)} />
        <Metric label="Checked" value={new Date(result.checkedAt).toLocaleTimeString()} />
      </dl>
      <DiagnosticOutcomeSummary
        outcome={result.outcome}
        reason={result.reason}
        stage={result.stage}
        statusCode={result.statusCode}
        assertionEvaluation={assertionEvaluation}
        protocol={protocol}
      />
      <div className="border-t border-rail-border px-4 py-3 text-xs">
        <p className="m-0 font-medium text-rail-text">
          {protocol === 'TCP'
            ? tcpDiagnosticLabel(result.reason)
            : protocol === 'DNS'
              ? dnsDiagnosticLabel(result.reason)
              : diagnosticFailureLabel({
                  outcome: result.outcome,
                  stage: result.stage,
                  reason: result.reason,
                  statusCode: result.statusCode,
                  assertionEvaluation,
                })}
        </p>
        <p className="mt-1 mb-0 text-rail-subtle">
          {humanize(result.stage)} · {humanize(result.reason)}
        </p>
      </div>
      {protocol === 'HTTP' ? (
        <>
          <AssertionDiagnostics evaluation={assertionEvaluation} />
          <TlsCertificateEvidencePanel
            certificates={result.tlsCertificates}
            observedAt={result.checkedAt}
          />
          {result.redirects.length > 0 ? <RedirectPath redirects={result.redirects} /> : null}
          <EvidenceRetentionNotice />
        </>
      ) : protocol === 'DNS' ? (
        <DnsAnswerEvidence answers={result.dnsAnswers} />
      ) : null}
    </section>
  );
}

function RedirectPath({
  redirects,
}: {
  redirects: Extract<NonNullable<ManualRound['result']>, { kind?: 'SINGLE_LOCATION' }>['redirects'];
}) {
  return (
    <div className="border-t border-rail-border px-4 py-3">
      <h5 className="m-0 text-xs font-semibold text-rail-text">Redirect path</h5>
      <ol className="mt-3 mb-0 grid list-decimal gap-3 pl-5" aria-label="Redirect chain">
        {redirects.map((hop) => (
          <li key={hop.sequence} className="pl-1 text-xs text-rail-muted">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <code className="break-all text-rail-text">
                #{hop.source.targetId} {hop.source.origin}
              </code>
              <span aria-hidden="true">→</span>
              <code className="break-all text-rail-text">
                {hop.destination
                  ? `#${hop.destination.targetId} ${hop.destination.origin}`
                  : 'No valid destination'}
              </code>
            </div>
            <small className="mt-1 block text-xs text-rail-muted">
              {hop.statusCode} · {formatMilliseconds(hop.responseTimeMs)} · {humanize(hop.headers)}
            </small>
          </li>
        ))}
      </ol>
    </div>
  );
}

function EvidenceRetentionNotice() {
  return (
    <p className="m-0 border-t border-rail-border px-4 py-3 text-xs leading-5 text-rail-muted">
      Response headers and body were not retained for this check. Run a configuration test to
      inspect bounded, redacted response evidence.
    </p>
  );
}

function tcpDiagnosticLabel(reason: string): string {
  switch (reason) {
    case 'CONNECTED':
      return 'TCP connection established.';
    case 'CONNECTION_REFUSED':
      return 'The target actively refused the TCP connection.';
    case 'HOST_UNREACHABLE':
      return 'The target network or host could not be reached.';
    case 'CONNECTION_TIMEOUT':
      return 'The TCP connection did not complete before the timeout.';
    case 'NAME_NOT_FOUND':
      return 'The target hostname could not be resolved.';
    case 'PROHIBITED_DESTINATION':
      return 'The resolved target is blocked by Watchrail network safety policy.';
    default:
      return 'The TCP check could not produce authoritative connection evidence.';
  }
}

function tcpConnectionState(
  outcome: 'PASS' | 'FAIL' | 'UNKNOWN',
  reason: string,
): 'Established' | 'Failed' | 'Indeterminate' {
  if (outcome === 'UNKNOWN') return 'Indeterminate';
  return outcome === 'PASS' && reason === 'CONNECTED' ? 'Established' : 'Failed';
}

function regionalTcpConnectionState(reason: string): 'Established' | 'Failed' | 'Indeterminate' {
  if (reason === 'CONNECTED') return 'Established';
  if (
    ['CONNECTION_REFUSED', 'HOST_UNREACHABLE', 'CONNECTION_TIMEOUT', 'NAME_NOT_FOUND'].includes(
      reason,
    )
  ) {
    return 'Failed';
  }
  return 'Indeterminate';
}

function dnsDiagnosticLabel(reason: string): string {
  switch (reason) {
    case 'RECORDS_MATCHED':
      return 'DNS response matched the configured expectation.';
    case 'NO_RECORDS':
      return 'The lookup completed without an answer for this record type.';
    case 'RECORD_MISMATCH':
      return 'The DNS response did not contain every expected answer.';
    case 'NAME_NOT_FOUND':
      return 'The DNS name does not exist.';
    case 'DNS_TIMEOUT':
      return 'The DNS lookup did not complete before the timeout.';
    case 'PROHIBITED_DESTINATION':
      return 'The lookup was blocked by Watchrail network safety policy.';
    default:
      return 'The DNS check could not produce authoritative answer evidence.';
  }
}

function dnsLookupState(
  outcome: 'PASS' | 'FAIL' | 'UNKNOWN',
  reason: string,
): 'Matched' | 'Failed' | 'Indeterminate' {
  if (outcome === 'UNKNOWN') return 'Indeterminate';
  return outcome === 'PASS' && reason === 'RECORDS_MATCHED' ? 'Matched' : 'Failed';
}

function regionalDnsLookupState(reason: string): 'Matched' | 'Failed' | 'Indeterminate' {
  if (reason === 'RECORDS_MATCHED') return 'Matched';
  if (['NO_RECORDS', 'RECORD_MISMATCH', 'NAME_NOT_FOUND', 'DNS_TIMEOUT'].includes(reason)) {
    return 'Failed';
  }
  return 'Indeterminate';
}

function DnsAnswerEvidence({ answers }: { answers?: string[] | undefined }) {
  return (
    <div className="border-t border-rail-border px-4 py-3">
      <h5 className="m-0 text-xs font-semibold text-rail-text">Observed answers</h5>
      {answers && answers.length > 0 ? (
        <ul className="mt-2 mb-0 grid list-none gap-1.5 p-0" aria-label="Observed DNS answers">
          {answers.map((answer, index) => (
            <li
              key={`${answer}-${index}`}
              className="break-all rounded-rail-control border border-rail-border bg-rail-header px-2.5 py-2 font-mono text-xs text-rail-subtle"
            >
              {answer}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
          No bounded DNS answer evidence was retained for this execution.
        </p>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-rail-header px-4 py-3">
      <dt className="text-xs text-rail-muted">{label}</dt>
      <dd className="mt-1 mb-0 truncate text-sm font-semibold text-rail-text tabular-nums">
        {value}
      </dd>
    </div>
  );
}

function MultiLocationDiagnostic({
  result,
  label,
  protocol,
}: {
  result: Extract<NonNullable<ManualRound['result']>, { kind: 'MULTI_LOCATION' }>;
  label: string;
  protocol: Monitor['type'];
}) {
  return (
    <section
      className="manual-diagnostic mt-4 overflow-hidden rounded-rail-panel border border-rail-border bg-rail-sidebar/45"
      aria-live="polite"
      aria-label={label}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rail-border px-4 py-3">
        <h4 className="m-0 text-sm font-semibold text-rail-text">{label}</h4>
        <OutcomeBadge outcome={result.outcome} />
      </div>
      <dl className="grid grid-cols-2 gap-px bg-rail-border sm:grid-cols-4">
        <Metric label="Evidence coverage" value={formatRatio(result.coverage)} />
        <Metric label="Reachability" value={formatRatio(result.reachability)} />
        <Metric label="Regions" value={String(result.counts.selected)} />
        <Metric label="Finalized" value={new Date(result.finalizedAt).toLocaleTimeString()} />
      </dl>
      {result.regions ? (
        <ul
          className="m-0 grid list-none divide-y divide-rail-border p-0"
          aria-label="Regional evidence"
        >
          {result.regions.map((region) => (
            <li key={region.location} className="px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-sm text-rail-text">{region.location}</strong>
                <span className="sr-only"> — </span>
                <span className="text-xs font-medium text-rail-subtle">
                  {region.outcome === 'CONFIRMED_FAIL'
                    ? 'Confirmed failure'
                    : region.outcome === 'PASS'
                      ? 'Pass'
                      : region.outcome === 'UNKNOWN'
                        ? 'Unknown'
                        : 'Pending'}
                </span>
              </div>
              {region.executions.map((execution) =>
                execution.diagnosticSummary ? (
                  <div
                    key={execution.id}
                    className="mt-2 overflow-hidden rounded-rail-control border border-rail-border"
                  >
                    {protocol === 'TCP' ? (
                      <dl className="m-0 grid grid-cols-2 gap-px bg-rail-border">
                        <Metric
                          label={
                            execution.role === 'PRIMARY'
                              ? 'Primary connection'
                              : 'Confirmation connection'
                          }
                          value={regionalTcpConnectionState(execution.diagnosticSummary.reason)}
                        />
                        <Metric
                          label="Connect latency"
                          value={formatMilliseconds(execution.diagnosticSummary.responseTimeMs)}
                        />
                      </dl>
                    ) : protocol === 'DNS' ? (
                      <>
                        <dl className="m-0 grid grid-cols-2 gap-px bg-rail-border">
                          <Metric
                            label={
                              execution.role === 'PRIMARY'
                                ? 'Primary lookup'
                                : 'Confirmation lookup'
                            }
                            value={regionalDnsLookupState(execution.diagnosticSummary.reason)}
                          />
                          <Metric
                            label="Query latency"
                            value={formatMilliseconds(execution.diagnosticSummary.responseTimeMs)}
                          />
                        </dl>
                        <DnsAnswerEvidence answers={execution.diagnosticSummary.dnsAnswers} />
                      </>
                    ) : (
                      <p className="m-0 px-3 py-2 text-xs text-rail-muted">
                        {execution.role.toLowerCase()} · HTTP{' '}
                        {execution.diagnosticSummary.statusCode ?? 'response unavailable'} ·{' '}
                        {formatMilliseconds(execution.diagnosticSummary.responseTimeMs)}
                        <span className="mt-1 block">
                          Response validation:{' '}
                          {execution.diagnosticSummary.assertionEvaluation
                            ? outcomeLabel[execution.diagnosticSummary.assertionEvaluation.outcome]
                            : 'Not reported'}
                        </span>
                      </p>
                    )}
                    {protocol === 'HTTP' && execution.diagnosticSummary.assertionEvaluation ? (
                      <AssertionDiagnostics
                        evaluation={execution.diagnosticSummary.assertionEvaluation}
                      />
                    ) : null}
                    {protocol === 'HTTP' ? (
                      <TlsCertificateEvidencePanel
                        certificates={execution.diagnosticSummary.tlsCertificates}
                        observedAt={execution.diagnosticSummary.checkedAt}
                      />
                    ) : null}
                  </div>
                ) : null,
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {protocol === 'HTTP' ? <EvidenceRetentionNotice /> : null}
    </section>
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
  protocol = 'HTTP',
}: {
  page: HistoryPage | undefined;
  loading: boolean;
  onLoadMore: () => void;
  details: Record<string, ManualRound>;
  expandedRoundIds: Set<string>;
  loadingRoundIds: Set<string>;
  onToggleRound: (roundId: string) => void;
  protocol?: Monitor['type'];
}) {
  if (!page && loading) {
    return (
      <p className="mt-3 mb-0 text-xs text-rail-muted" role="status">
        Loading check history…
      </p>
    );
  }
  if (!page || page.items.length === 0) {
    return <p className="mt-3 mb-0 text-xs text-rail-muted">No checks recorded yet.</p>;
  }

  return (
    <section
      className="mt-3 overflow-hidden rounded-rail-panel border border-rail-border"
      aria-label="Check history"
    >
      <div className="border-b border-rail-border bg-rail-sidebar/45 px-4 py-3">
        <h4 className="m-0 text-sm font-semibold text-rail-text">Check history</h4>
      </div>
      <ol className="m-0 grid list-none divide-y divide-rail-border p-0">
        {page.items.map((round) => {
          const regionalResult = round.result?.kind === 'MULTI_LOCATION' ? round.result : null;
          const singleResult =
            round.result && round.result.kind !== 'MULTI_LOCATION' ? round.result : null;
          const singleHealth = singleResult
            ? singleLocationHealth(
                singleResult.outcome,
                singleResult.reason,
                singleResult.assertionOutcome ??
                  singleResult.assertionEvaluation?.outcome ??
                  'NOT_EVALUATED',
                protocol,
              )
            : null;
          const singleAssertionFailed =
            (singleResult?.assertionOutcome ?? singleResult?.assertionEvaluation?.outcome) ===
            'FAIL';
          const isRegional = regionalResult !== null;
          const isExpanded = expandedRoundIds.has(round.id);
          const detail = details[round.id];
          return (
            <li key={round.id} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold text-rail-text">
                    {round.trigger}{' '}
                    {round.result
                      ? isRegional
                        ? `${regionalResult.outcome} · ${formatRatio(regionalResult.coverage)}`
                        : `${outcomeLabel[singleHealth!]} · ${
                            singleAssertionFailed ? 'assertion failed' : singleResult!.reason
                          }`
                      : round.assignmentStatus}
                  </div>
                  <time className="mt-1 block text-xs text-rail-muted" dateTime={round.createdAt}>
                    {new Date(round.createdAt).toLocaleString()}
                  </time>
                </div>
                {round.result ? (
                  <Button
                    variant="quiet"
                    size="compact"
                    disabled={loadingRoundIds.has(round.id)}
                    aria-expanded={isExpanded}
                    onClick={() => onToggleRound(round.id)}
                  >
                    {loadingRoundIds.has(round.id)
                      ? 'Loading evidence…'
                      : isExpanded
                        ? 'Hide diagnostic evidence'
                        : 'Show diagnostic evidence'}
                  </Button>
                ) : null}
              </div>
              {isExpanded && detail?.result?.kind === 'MULTI_LOCATION' ? (
                <MultiLocationDiagnostic
                  result={detail.result}
                  label="Historical regional evidence"
                  protocol={protocol}
                />
              ) : null}
              {isExpanded && detail?.result && detail.result.kind !== 'MULTI_LOCATION' ? (
                <HistoricalSingleLocationEvidence result={detail.result} protocol={protocol} />
              ) : null}
            </li>
          );
        })}
      </ol>
      {page.nextCursor ? (
        <div className="border-t border-rail-border px-4 py-3">
          <Button variant="secondary" size="compact" disabled={loading} onClick={onLoadMore}>
            {loading ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function HistoricalSingleLocationEvidence({
  result,
  protocol,
}: {
  result: Extract<NonNullable<ManualRound['result']>, { kind?: 'SINGLE_LOCATION' }>;
  protocol: Monitor['type'];
}) {
  const assertionEvaluation = result.assertionEvaluation ?? {
    contractVersion: 1 as const,
    outcome: result.assertionOutcome ?? ('NOT_EVALUATED' as const),
    diagnostics: [],
  };
  return (
    <div className="mt-3 overflow-hidden rounded-rail-panel border border-rail-border bg-rail-sidebar/45">
      <dl className="grid grid-cols-2 gap-px bg-rail-border sm:grid-cols-4">
        <Metric
          label={protocol === 'HTTP' ? 'HTTP' : protocol === 'TCP' ? 'Connection' : 'DNS lookup'}
          value={
            protocol === 'HTTP'
              ? (result.statusCode?.toString() ?? 'No response')
              : protocol === 'TCP'
                ? tcpConnectionState(result.outcome, result.reason)
                : dnsLookupState(result.outcome, result.reason)
          }
        />
        <Metric
          label={
            protocol === 'HTTP'
              ? 'Response'
              : protocol === 'TCP'
                ? 'Connect latency'
                : 'Query latency'
          }
          value={formatMilliseconds(result.responseTimeMs)}
        />
        <Metric label="Attempt" value={formatMilliseconds(result.attemptDurationMs)} />
        <Metric label="Checked" value={new Date(result.checkedAt).toLocaleTimeString()} />
      </dl>
      <DiagnosticOutcomeSummary
        outcome={result.outcome}
        reason={result.reason}
        stage={result.stage}
        statusCode={result.statusCode}
        assertionEvaluation={assertionEvaluation}
        protocol={protocol}
      />
      <p className="m-0 border-t border-rail-border px-4 py-3 text-xs text-rail-subtle">
        {protocol === 'TCP'
          ? tcpDiagnosticLabel(result.reason)
          : protocol === 'DNS'
            ? dnsDiagnosticLabel(result.reason)
            : diagnosticFailureLabel({
                outcome: result.outcome,
                stage: result.stage,
                reason: result.reason,
                statusCode: result.statusCode,
                assertionEvaluation,
              })}
      </p>
      {protocol === 'HTTP' ? (
        <>
          <AssertionDiagnostics evaluation={assertionEvaluation} />
          <TlsCertificateEvidencePanel
            certificates={result.tlsCertificates}
            observedAt={result.checkedAt}
          />
          {result.redirects.length > 0 ? <RedirectPath redirects={result.redirects} /> : null}
          <EvidenceRetentionNotice />
        </>
      ) : protocol === 'DNS' ? (
        <DnsAnswerEvidence answers={result.dnsAnswers} />
      ) : null}
    </div>
  );
}

export function IncidentSummary({ state }: { state: IncidentState | undefined }) {
  if (state?.currentIncident) {
    const isMultiLocation = Boolean(state.multiLocationIncident);
    const label = isMultiLocation
      ? state.multiLocationIncident!.severity === 'DOWN'
        ? 'MAJOR OUTAGE'
        : 'PARTIAL OUTAGE'
      : 'OPEN';
    return (
      <section
        className="mt-4 rounded-rail-panel border border-rail-danger/30 bg-rail-danger/5 px-4 py-3"
        aria-label="Incident state"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong className="text-sm text-rail-danger">Incident: {label}</strong>
          {state.multiLocationIncident?.healthyRecoveryStreak ? (
            <span className="text-xs font-medium text-rail-warning">
              Recovery {state.multiLocationIncident.healthyRecoveryStreak}/
              {state.multiLocationIncident.healthyRecoveryThreshold} healthy rounds
            </span>
          ) : null}
        </div>
        <p className="mt-1 mb-0 text-xs leading-5 text-rail-subtle">
          Started {new Date(state.currentIncident.startedAt).toLocaleString()} · detected{' '}
          {new Date(state.currentIncident.openedAt).toLocaleString()}
          {!isMultiLocation ? ` · ${state.failureStreak?.count ?? 0} consecutive failures` : ''}
        </p>
      </section>
    );
  }

  if (state?.failureStreak) {
    return (
      <p
        className="mt-4 mb-0 rounded-lg border border-rail-warning/30 bg-rail-warning/5 px-4 py-3 text-sm text-rail-warning"
        aria-label="Incident state"
      >
        Incident watch: Failure {state.failureStreak.count}/{state.failureStreak.threshold}
      </p>
    );
  }

  return (
    <p className="mt-4 mb-0 text-xs text-rail-muted" aria-label="Incident state">
      Incident: No active incident
    </p>
  );
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
      <div
        className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rail-danger/30 bg-rail-danger/5 px-4 py-3 text-sm text-rail-danger"
        role="alert"
      >
        <span>{error}</span>
        <Button variant="quiet" size="compact" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  if (!page) {
    return (
      <p className="mt-3 mb-0 text-xs text-rail-muted" role="status">
        Loading incident history…
      </p>
    );
  }
  if (page.items.length === 0) {
    return <p className="mt-3 mb-0 text-xs text-rail-muted">No incidents recorded yet.</p>;
  }

  return (
    <section
      className="mt-3 overflow-hidden rounded-rail-panel border border-rail-border"
      aria-label="Incident history"
    >
      <div className="border-b border-rail-border bg-rail-sidebar/45 px-4 py-3">
        <h4 className="m-0 text-sm font-semibold text-rail-text">Incident history</h4>
      </div>
      <ol className="m-0 grid list-none divide-y divide-rail-border p-0">
        {page.items.map((incident) => (
          <li
            key={incident.id}
            className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
          >
            <strong
              className={
                incident.status === 'OPEN'
                  ? 'text-xs text-rail-danger'
                  : 'text-xs text-rail-success'
              }
            >
              {incident.status}
            </strong>
            <p className="m-0 text-right text-xs leading-5 text-rail-muted">
              Started {new Date(incident.startedAt).toLocaleString()}
              {incident.resolvedAt
                ? ` · Resolved ${new Date(incident.resolvedAt).toLocaleString()}`
                : ''}
            </p>
          </li>
        ))}
      </ol>
      {page.nextCursor ? (
        <div className="border-t border-rail-border px-4 py-3">
          <Button variant="secondary" size="compact" disabled={loading} onClick={onLoadMore}>
            {loading ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
