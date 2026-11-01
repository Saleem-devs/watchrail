import type { AssertionDiagnostic, AssertionEvaluation } from './types';
import { humanize } from './formatting';

const sourceLabels: Record<AssertionDiagnostic['source'], string> = {
  HEADER: 'Response header',
  TEXT_BODY: 'Text body',
  JSON_BODY: 'JSON body',
};

const outcomeTone: Record<AssertionDiagnostic['outcome'], string> = {
  PASS: 'border-rail-success/35 bg-rail-success/10 text-rail-success',
  FAIL: 'border-rail-danger/35 bg-rail-danger/10 text-rail-danger',
  NOT_EVALUATED: 'border-rail-border-strong bg-rail-surface text-rail-subtle',
};

export function diagnosticFailureLabel({
  outcome,
  stage,
  reason,
  statusCode,
  assertionEvaluation,
}: {
  outcome: 'PASS' | 'FAIL' | 'UNKNOWN';
  stage: string;
  reason?: string;
  statusCode: number | null;
  assertionEvaluation: AssertionEvaluation;
}): string {
  if (assertionEvaluation.outcome === 'FAIL') return 'Response assertion failed';
  if (reason === 'CERTIFICATE_EXPIRING') return 'Certificate expiry policy failed';
  if (outcome === 'UNKNOWN' || stage !== 'HTTP' || statusCode === null) {
    return 'Transport failure — no response was available to evaluate';
  }
  if (outcome === 'FAIL') return 'HTTP response failed before assertions';
  return 'Response assertions passed';
}

export function AssertionDiagnostics({
  evaluation,
  context,
}: {
  evaluation: AssertionEvaluation;
  context?: string;
}) {
  if (evaluation.diagnostics.length === 0) return null;
  return (
    <section className="border-t border-rail-border" aria-label="Response assertion diagnostics">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <div>
          <h5 className="m-0 text-xs font-semibold text-rail-text">Response assertions</h5>
          {context ? <p className="mt-1 mb-0 text-xs text-rail-muted">{context}</p> : null}
        </div>
        <AssertionOutcome outcome={evaluation.outcome} />
      </div>
      <ol className="m-0 grid list-none divide-y divide-rail-border border-t border-rail-border p-0">
        {evaluation.diagnostics.map((diagnostic) => (
          <li
            key={`${diagnostic.source}-${diagnostic.index}`}
            className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <strong className="text-xs font-semibold text-rail-text">
                  {sourceLabels[diagnostic.source]}
                </strong>
                <code className="break-all text-xs text-rail-subtle">
                  {diagnostic.subject ?? 'response body'}
                </code>
              </div>
              <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
                {humanize(diagnostic.operator)} · {humanize(diagnostic.reason)}
              </p>
            </div>
            <AssertionOutcome outcome={diagnostic.outcome} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function AssertionOutcome({ outcome }: { outcome: AssertionDiagnostic['outcome'] }) {
  return (
    <span
      className={`inline-flex min-h-7 shrink-0 items-center rounded-rail-control border px-2 py-1 text-xs font-semibold ${outcomeTone[outcome]}`}
    >
      {outcome === 'NOT_EVALUATED' ? 'Not evaluated' : outcome}
    </span>
  );
}
