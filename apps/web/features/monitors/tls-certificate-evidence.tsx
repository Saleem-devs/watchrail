import type { TlsCertificateEvidence } from './types';

export function TlsCertificateEvidencePanel({
  certificates,
  observedAt,
}: {
  certificates: readonly TlsCertificateEvidence[] | undefined;
  observedAt: string;
}) {
  if (!certificates?.length) return null;

  return (
    <section className="border-t border-rail-border px-5 py-4" aria-label="TLS certificates">
      <div className="flex items-center justify-between gap-3">
        <h3 className="m-0 text-xs font-semibold text-rail-text">TLS certificates</h3>
        <span className="text-xs text-rail-muted tabular-nums">{certificates.length}</span>
      </div>
      <ol className="mt-3 mb-0 grid list-none gap-3 p-0">
        {certificates.map((certificate) => {
          const validTo = new Date(certificate.validTo);
          const daysRemaining = Math.ceil(
            (validTo.getTime() - new Date(observedAt).getTime()) / 86_400_000,
          );
          return (
            <li
              key={`${certificate.origin}:${certificate.fingerprint256}`}
              className="grid gap-2 rounded-rail-control border border-rail-border bg-rail-surface px-3 py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <code className="break-all text-xs font-medium text-rail-text">
                  {certificate.hostname}
                </code>
                <span
                  className={`text-xs font-medium tabular-nums ${daysRemaining <= 30 ? 'text-rail-warning' : 'text-rail-success'}`}
                >
                  {daysRemaining} {daysRemaining === 1 ? 'day' : 'days'} remaining
                </span>
              </div>
              <dl className="m-0 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[7rem_minmax(0,1fr)]">
                <dt className="text-rail-muted">Valid until</dt>
                <dd className="m-0 text-rail-subtle tabular-nums">{validTo.toLocaleString()}</dd>
                <dt className="text-rail-muted">Issued by</dt>
                <dd className="m-0 break-words text-rail-subtle">{certificate.issuer}</dd>
                <dt className="text-rail-muted">Connection</dt>
                <dd className="m-0 break-words text-rail-subtle">
                  {certificate.protocol} · {certificate.cipher}
                </dd>
                <dt className="text-rail-muted">SHA-256</dt>
                <dd className="m-0 break-all font-mono text-[11px] leading-5 text-rail-muted">
                  {certificate.fingerprint256}
                </dd>
              </dl>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
