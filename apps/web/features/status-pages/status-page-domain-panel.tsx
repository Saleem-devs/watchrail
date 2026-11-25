'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Circle, ExternalLink, RefreshCw } from 'lucide-react';
import { Button, actionClassName } from '../../components/ui/button';
import { Input } from '../../components/ui/form-control';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog';

type DomainState = {
  cnameTarget: string | null;
  ownershipVerified: boolean;
  routingVerified: boolean;
  httpsReady: boolean;
  domain: null | {
    hostname: string;
    verificationToken: string;
    lastCheckedAt: string | null;
  };
};

export function StatusPageDomainPanel({
  pageId,
  published,
}: {
  pageId: string;
  published: boolean;
}) {
  const [state, setState] = useState<DomainState>();
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const requestSequence = useRef(0);
  const endpoint = `/api/status-pages/${pageId}/domain`;
  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    const response = await fetch(endpoint, { cache: 'no-store' });
    const body = (await response.json()) as { data?: DomainState; message?: string };
    if (!response.ok || !body.data)
      throw new Error(body.message ?? 'Could not load custom domain.');
    if (sequence === requestSequence.current) {
      setState(body.data);
      setError('');
    }
  }, [endpoint]);
  useEffect(() => {
    const refresh = () =>
      void load().catch(() => {
        setState(undefined);
        setError('Could not refresh custom domain. Try again.');
      });
    const initial = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [load, published]);
  async function act(action: 'add' | 'verify' | 'remove') {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${endpoint}${action === 'verify' ? '/verify' : ''}`, {
        method: action === 'remove' ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(action === 'add' ? { body: JSON.stringify({ hostname }) } : {}),
      });
      const body = (await response.json()) as { message?: string };
      if (!response.ok) throw new Error(body.message ?? 'Could not update custom domain.');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update custom domain.');
    } finally {
      setBusy(false);
    }
  }
  const domain = state?.domain;
  const ready = published && state?.httpsReady;
  return (
    <section
      className="min-w-0 overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface xl:col-span-2"
      aria-labelledby="custom-domain-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rail-border p-5">
        <div>
          <h2 id="custom-domain-title" className="m-0 text-base font-medium text-rail-text">
            Custom domain
          </h2>
          <p className="mt-1 mb-0 text-sm text-rail-subtle">
            Serve this status page on your own subdomain.
          </p>
        </div>
        {domain ? (
          <span
            className={`text-sm font-medium ${ready ? 'text-rail-success' : 'text-rail-subtle'}`}
          >
            {ready ? 'Ready' : !published ? 'Page unpublished' : 'Setup pending'}
          </span>
        ) : null}
      </div>
      <div className="grid gap-5 p-5">
        {!state ? (
          <p className="m-0 text-sm text-rail-subtle" role="status">
            {error
              ? 'Custom domain unavailable. Refresh this page to try again.'
              : 'Loading custom domain…'}
          </p>
        ) : !state.cnameTarget ? (
          <p className="m-0 text-sm text-rail-subtle">
            Custom domains are not configured on this installation.
          </p>
        ) : !domain ? (
          <form
            className="flex max-w-xl flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void act('add');
            }}
          >
            <label className="grid min-w-0 flex-1 basis-64 gap-2 text-sm text-rail-subtle">
              Hostname
              <Input
                required
                value={hostname}
                onChange={(event) => setHostname(event.target.value)}
                placeholder="status.example.com"
                autoCapitalize="none"
                spellCheck={false}
                disabled={busy}
              />
            </label>
            <Button type="submit" disabled={busy || !hostname.trim()}>
              {busy ? 'Adding…' : 'Add domain'}
            </Button>
            <p className="m-0 basis-full text-xs text-rail-muted">
              Use a subdomain. Apex and wildcard domains are not supported.
            </p>
          </form>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="m-0 min-w-0 break-all font-mono text-sm text-rail-text">
                {domain.hostname}
              </p>
              <div className="flex flex-wrap gap-2">
                {ready ? (
                  <a
                    href={`https://${domain.hostname}`}
                    target="_blank"
                    rel="noreferrer"
                    className={actionClassName()}
                  >
                    <ExternalLink size={14} aria-hidden />
                    Open page
                  </a>
                ) : null}
                <Button disabled={busy} onClick={() => void act('verify')}>
                  <RefreshCw size={14} aria-hidden />
                  {busy ? 'Checking…' : 'Check connection'}
                </Button>
                <Button variant="quiet" disabled={busy} onClick={() => setConfirmRemove(true)}>
                  Remove
                </Button>
              </div>
            </div>
            <ol
              className="m-0 grid list-none gap-3 p-0 sm:grid-cols-3"
              aria-label="Domain setup status"
            >
              <Step
                label="Ownership"
                done={state.ownershipVerified}
                pending="TXT record not verified"
              />
              <Step label="DNS routing" done={state.routingVerified} pending="CNAME not verified" />
              <Step
                label="HTTPS"
                done={!!ready}
                pending={
                  published ? 'Secure page not verified' : 'Publish the page to enable HTTPS'
                }
              />
            </ol>
            <div>
              <p className="mt-0 mb-3 text-sm text-rail-subtle">
                Add these records at your DNS provider, then check the connection. Keep both records
                in place.
              </p>
              <div className="hidden overflow-x-auto rounded-rail-control border border-rail-border sm:block">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Required DNS records</caption>
                  <thead className="border-b border-rail-border text-xs text-rail-muted">
                    <tr>
                      <th className="px-3 py-2 font-normal">Type</th>
                      <th className="px-3 py-2 font-normal">Name</th>
                      <th className="px-3 py-2 font-normal">Value</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rail-border text-rail-text">
                    <DnsRecord type="CNAME" name={domain.hostname} value={state.cnameTarget} />
                    <DnsRecord
                      type="TXT"
                      name={`_watchrail.${domain.hostname}`}
                      value={`watchrail-verification=${domain.verificationToken}`}
                    />
                  </tbody>
                </table>
              </div>
              <div className="grid gap-3 sm:hidden">
                <MobileDnsRecord type="CNAME" name={domain.hostname} value={state.cnameTarget} />
                <MobileDnsRecord
                  type="TXT"
                  name={`_watchrail.${domain.hostname}`}
                  value={`watchrail-verification=${domain.verificationToken}`}
                />
              </div>
            </div>
            <p className="m-0 text-xs leading-5 text-rail-muted">
              DNS changes can take time to propagate. Ready means Watchrail verified a secure HTTPS
              connection to this page. Checks repeat automatically; unpublishing disables the custom
              address.{' '}
              {domain.lastCheckedAt
                ? `Last checked ${new Date(domain.lastCheckedAt).toLocaleString()}.`
                : 'Not checked yet.'}
            </p>
          </>
        )}
        {error ? (
          <p role="alert" className="m-0 text-sm text-rail-danger">
            {error}
          </p>
        ) : null}
      </div>
      <ConfirmationDialog
        open={confirmRemove}
        title="Remove custom domain?"
        description="This address will stop serving the status page. The shared Watchrail address and subscriptions remain available. Remove the DNS records at your provider afterward."
        confirmLabel="Remove domain"
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false);
          void act('remove');
        }}
      />
    </section>
  );
}
function Step({ label, done, pending }: { label: string; done: boolean; pending: string }) {
  const Icon = done ? Check : Circle;
  return (
    <li className="flex items-start gap-2 text-sm">
      <Icon
        size={16}
        aria-hidden
        className={`mt-0.5 shrink-0 ${done ? 'text-rail-success' : 'text-rail-muted'}`}
      />
      <div>
        <p className="m-0 font-medium text-rail-text">{label}</p>
        <p className="mt-1 mb-0 text-xs text-rail-subtle">{done ? 'Verified' : pending}</p>
      </div>
    </li>
  );
}
function DnsRecord({ type, name, value }: { type: string; name: string; value: string }) {
  return (
    <tr>
      <td className="px-3 py-3 align-top text-xs">{type}</td>
      <td className="px-3 py-3 align-top">
        <code className="break-all text-xs">{name}</code>
      </td>
      <td className="px-3 py-3 align-top">
        <code className="break-all text-xs">{value}</code>
      </td>
    </tr>
  );
}

function MobileDnsRecord({ type, name, value }: { type: string; name: string; value: string }) {
  return (
    <div className="rounded-rail-control border border-rail-border p-3">
      <p className="mt-0 mb-3 text-xs font-medium text-rail-text">{type}</p>
      <dl className="m-0 grid gap-3 text-xs">
        <div>
          <dt className="mb-1 text-rail-muted">Name</dt>
          <dd className="m-0 break-all font-mono text-rail-text">{name}</dd>
        </div>
        <div>
          <dt className="mb-1 text-rail-muted">Value</dt>
          <dd className="m-0 break-all font-mono text-rail-text">{value}</dd>
        </div>
      </dl>
    </div>
  );
}
