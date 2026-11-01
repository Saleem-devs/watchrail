import { Button } from '../../components/ui/button';
import { AssertionDiagnostics } from './assertion-diagnostics';
import { formatMilliseconds, humanize } from './formatting';
import type { ConfigurationTestResult, ManualRoundResultRedirect } from './types';
import { TlsCertificateEvidencePanel } from './tls-certificate-evidence';

type SignalOutcome = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_EVALUATED' | 'DISABLED';

const tone: Record<SignalOutcome, string> = {
  PASS: 'border-rail-success/35 bg-rail-success/10 text-rail-success',
  FAIL: 'border-rail-danger/35 bg-rail-danger/10 text-rail-danger',
  UNKNOWN: 'border-rail-warning/35 bg-rail-warning/10 text-rail-warning',
  NOT_EVALUATED: 'border-rail-border-strong bg-rail-surface text-rail-subtle',
  DISABLED: 'border-rail-border-strong bg-rail-surface text-rail-muted',
};

export function ConfigurationTestPanel({
  result,
  error,
  onDismiss,
}: {
  result?: ConfigurationTestResult | undefined;
  error?: string | undefined;
  onDismiss: () => void;
}) {
  if (!result && !error) return null;
  if (error) {
    return (
      <section
        className="mt-6 rounded-rail-panel border border-rail-danger/35 bg-rail-danger/5 px-5 py-4"
        role="alert"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="m-0 text-sm font-semibold text-rail-danger">
              Configuration test failed
            </h2>
            <p className="mt-1 mb-0 text-sm leading-6 text-rail-subtle">{error}</p>
          </div>
          <Button variant="quiet" size="compact" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </section>
    );
  }

  const data = result!;
  const summaryOutcome = configurationTestOutcome(data.signals);
  return (
    <section
      className="mt-6 overflow-hidden rounded-rail-panel border border-rail-border bg-rail-raised"
      aria-live="polite"
      aria-label="Configuration test result"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rail-border px-5 py-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 text-sm font-semibold text-rail-text">Configuration test</h2>
            <SignalBadge outcome={summaryOutcome} />
          </div>
          <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
            Transient result only — no check, incident, uptime, or schedule data was changed.
          </p>
        </div>
        <Button variant="quiet" size="compact" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>

      <dl className="grid grid-cols-2 gap-px bg-rail-border sm:grid-cols-4">
        <Metric label="HTTP status" value={data.result.statusCode?.toString() ?? 'No response'} />
        <Metric label="Response" value={formatMilliseconds(data.result.responseTimeMs)} />
        <Metric label="Attempt" value={formatMilliseconds(data.result.attemptDurationMs)} />
        <Metric label="Checked" value={new Date(data.result.checkedAt).toLocaleTimeString()} />
      </dl>
      <dl className="grid gap-px border-t border-rail-border bg-rail-border sm:grid-cols-2 lg:grid-cols-4">
        <Signal label="Transport" outcome={data.signals.transport} />
        <Signal label="Status policy" outcome={data.signals.statusPolicy} />
        <Signal label="Assertions" outcome={data.signals.assertions} />
        <Signal label="TLS expiry" outcome={data.signals.tlsCertificate ?? 'NOT_EVALUATED'} />
      </dl>

      <div className="border-t border-rail-border px-5 py-3 text-xs">
        <p className="m-0 font-medium text-rail-text">{humanize(data.result.reason)}</p>
        <p className="mt-1 mb-0 text-rail-muted">{humanize(data.result.stage)} stage</p>
      </div>
      <AssertionDiagnostics evaluation={data.result.assertionEvaluation} />
      <TlsCertificateEvidencePanel
        certificates={data.result.tlsCertificates}
        observedAt={data.result.checkedAt}
      />
      {data.result.redirects.length > 0 ? (
        <RedirectEvidence redirects={data.result.redirects} />
      ) : null}

      <div className="grid border-t border-rail-border lg:grid-cols-2 lg:divide-x lg:divide-rail-border">
        <ResponseHeaders result={data} />
        <ResponseBody result={data} />
      </div>
    </section>
  );
}

function configurationTestOutcome(signals: ConfigurationTestResult['signals']): SignalOutcome {
  const outcomes = [signals.transport, signals.statusPolicy, signals.assertions];
  if (signals.tlsCertificate && signals.tlsCertificate !== 'DISABLED') {
    outcomes.push(signals.tlsCertificate);
  }
  if (outcomes.includes('FAIL')) return 'FAIL';
  if (outcomes.every((outcome) => outcome === 'PASS')) return 'PASS';
  return 'UNKNOWN';
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

function Signal({ label, outcome }: { label: string; outcome: SignalOutcome }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-rail-header px-4 py-3">
      <dt className="text-xs text-rail-muted">{label}</dt>
      <dd className="m-0">
        <SignalBadge outcome={outcome} />
      </dd>
    </div>
  );
}

function SignalBadge({ outcome }: { outcome: SignalOutcome }) {
  return (
    <span
      className={`inline-flex min-h-7 items-center rounded-rail-control border px-2 py-1 text-xs font-semibold ${tone[outcome]}`}
    >
      {outcome === 'NOT_EVALUATED'
        ? 'Not evaluated'
        : outcome === 'DISABLED'
          ? 'Disabled'
          : humanize(outcome)}
    </span>
  );
}

function ResponseHeaders({ result }: { result: ConfigurationTestResult }) {
  return (
    <section className="min-w-0 px-5 py-4" aria-label="Response headers">
      <div className="flex items-center justify-between gap-3">
        <h3 className="m-0 text-xs font-semibold text-rail-text">Response headers</h3>
        <span className="text-xs text-rail-muted tabular-nums">
          {result.response.headers.length}
        </span>
      </div>
      {result.response.headers.length === 0 ? (
        <p className="mt-3 mb-0 text-xs leading-5 text-rail-muted">
          No response headers were available.
        </p>
      ) : (
        <dl className="mt-3 mb-0 grid gap-2">
          {result.response.headers.map((header) => (
            <div key={header.name} className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)]">
              <dt className="truncate font-mono text-xs text-rail-subtle">{header.name}</dt>
              <dd className="m-0 break-all font-mono text-xs leading-5 text-rail-text">
                {header.values.join(', ')}
                {header.redacted ? (
                  <span className="sr-only"> Sensitive value redacted.</span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {result.response.withheldHeaderCount > 0 ? (
        <p className="mt-3 mb-0 text-xs text-rail-muted">
          {result.response.withheldHeaderCount} additional headers withheld by the display limit.
        </p>
      ) : null}
    </section>
  );
}

function ResponseBody({ result }: { result: ConfigurationTestResult }) {
  const body = result.response.body;
  return (
    <section className="min-w-0 px-5 py-4" aria-label="Response body preview">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="m-0 text-xs font-semibold text-rail-text">Body preview</h3>
        {body.state === 'PREVIEW' ? (
          <span className="text-xs text-rail-muted">{body.contentType}</span>
        ) : null}
      </div>
      {body.state === 'PREVIEW' ? (
        <>
          <pre className="mt-3 mb-0 max-h-80 overflow-auto rounded-rail-control border border-rail-border bg-rail-input p-3 text-xs leading-5 whitespace-pre-wrap text-rail-subtle">
            <code>{body.text || '(empty body)'}</code>
          </pre>
          {body.truncated ? (
            <p className="mt-2 mb-0 text-xs text-rail-warning">
              Preview truncated at the secure 8 KB display limit.
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-3 mb-0 text-xs leading-5 text-rail-muted">
          {bodyUnavailableCopy(body.reason)}
        </p>
      )}
    </section>
  );
}

function RedirectEvidence({ redirects }: { redirects: ManualRoundResultRedirect[] }) {
  return (
    <section className="border-t border-rail-border px-5 py-4" aria-label="Redirect chain">
      <h3 className="m-0 text-xs font-semibold text-rail-text">Redirect path</h3>
      <ol className="mt-3 mb-0 grid list-decimal gap-2 pl-5">
        {redirects.map((hop) => (
          <li key={hop.sequence} className="pl-1 text-xs leading-5 text-rail-muted">
            <code className="break-all text-rail-text">{hop.source.origin}</code> →{' '}
            <code className="break-all text-rail-text">
              {hop.destination?.origin ?? 'Unavailable destination'}
            </code>
            <span className="ml-2">
              {hop.statusCode} · {formatMilliseconds(hop.responseTimeMs)} · {humanize(hop.headers)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function bodyUnavailableCopy(reason: string): string {
  const copy: Record<string, string> = {
    NO_RESPONSE: 'No HTTP response was available to inspect.',
    HEAD_REQUEST: 'HEAD responses do not include a body.',
    NOT_CAPTURED: 'The response ended before a body preview could be captured.',
    UNSUPPORTED_CONTENT_TYPE: 'This content type is not eligible for a safe text preview.',
    BODY_TOO_LARGE: 'The response exceeded the bounded capture limit.',
    UNSUPPORTED_CONTENT_ENCODING: 'The response uses an unsupported content encoding.',
    UNSUPPORTED_CHARSET: 'The response uses an unsupported character set.',
    BODY_READ_FAILED: 'The response body could not be read safely.',
  };
  return copy[reason] ?? 'Response evidence was unavailable.';
}
