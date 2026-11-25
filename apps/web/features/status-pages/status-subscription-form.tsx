'use client';

import { useSyncExternalStore, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/form-control';

export function StatusSubscriptionForm({ slug }: { slug: string }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await subscriptionRequest('', { slug, email });
      setMessage(result.message);
      setEmail('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }
  return message ? (
    <p role="status" className="text-sm text-rail-subtle">
      {message}
    </p>
  ) : (
    <form onSubmit={(event) => void submit(event)} className="!p-0">
      <label htmlFor="subscriber-email" className="mb-2 block text-xs font-medium text-rail-subtle">
        Email address
      </label>
      <Input
        id="subscriber-email"
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
        maxLength={320}
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        disabled={busy}
        aria-describedby="subscription-help"
      />
      <p id="subscription-help" className="mt-2 text-xs text-rail-muted">
        Confirm your email before receiving updates. Unsubscribe at any time.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-rail-danger">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" className="mt-5 w-full" disabled={busy}>
        {busy ? 'Sending…' : 'Subscribe to updates'}
      </Button>
    </form>
  );
}

export function StatusSubscriptionAction() {
  const hash = useSyncExternalStore(
    subscribeHash,
    () => window.location.hash,
    () => '',
  );
  return <SubscriptionAction key={hash} hash={hash} />;
}

function SubscriptionAction({ hash }: { hash: string }) {
  const [statusPageSlug, setStatusPageSlug] = useState<string | null>(null);
  const params = new URLSearchParams(hash.slice(1));
  const kind = params.has('verify') ? 'verify' : 'unsubscribe';
  const token = params.get(kind);
  const action = token && /^[\w-]{43}$/u.test(token) ? { kind, token } : null;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function submit() {
    if (!action || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await subscriptionRequest(`/${action.kind}`, { token: action.token });
      setMessage(result.message);
      setStatusPageSlug(result.statusPageSlug ?? null);
      window.history.replaceState(null, '', window.location.pathname);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main
      data-watchrail-workspace
      className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-5 px-6 py-12"
    >
      <h1 className="text-2xl font-semibold text-rail-text">
        {action?.kind === 'unsubscribe' ? 'Unsubscribe from updates' : 'Confirm your subscription'}
      </h1>
      {message ? (
        <p role="status" className="text-sm text-rail-subtle">
          {message}
        </p>
      ) : (
        <>
          <p className="text-sm text-rail-subtle">
            {!action
              ? 'This link is incomplete. Open the link from your subscription email.'
              : action.kind === 'verify'
                ? 'Receive future incident and maintenance updates for this status page.'
                : 'Stop email updates for this status page. You can subscribe again later.'}
          </p>
          {error && (
            <p role="alert" className="text-sm text-rail-danger">
              {error}
            </p>
          )}
          {action && (
            <Button variant="primary" disabled={busy} onClick={() => void submit()}>
              {busy ? 'Saving…' : action.kind === 'verify' ? 'Confirm subscription' : 'Unsubscribe'}
            </Button>
          )}
        </>
      )}
      {statusPageSlug && (
        <Link
          href={`/status/${encodeURIComponent(statusPageSlug)}`}
          className="text-sm text-rail-subtle underline underline-offset-4"
        >
          Back to status page
        </Link>
      )}
    </main>
  );
}

async function subscriptionRequest(
  path: string,
  body: Record<string, string>,
): Promise<{ message: string; statusPageSlug?: string | null }> {
  const response = await fetch(`/api/public/status-subscriptions${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'omit',
    cache: 'no-store',
  });
  const result = (await response.json()) as { message?: string; statusPageSlug?: string | null };
  if (!response.ok)
    throw new Error(
      typeof result.message === 'string'
        ? result.message
        : 'Unable to save your subscription. Please try again.',
    );
  return { ...result, message: result.message ?? 'Saved.' };
}

function subscribeHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}
