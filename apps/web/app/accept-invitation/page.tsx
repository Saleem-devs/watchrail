'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { authClient } from '../../lib/auth-client';

function InvitationAcceptance() {
  const params = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const invitationId = params.get('id');

  async function accept() {
    if (!invitationId) return;
    setBusy(true);
    const result = await authClient.organization.acceptInvitation({ invitationId });
    if (result.error) {
      setError('This invitation is invalid, expired, or has been revoked.');
      setBusy(false);
      return;
    }
    if (result.data?.member.organizationId) {
      await authClient.organization.setActive({
        organizationId: result.data.member.organizationId,
      });
    }
    router.push('/');
    router.refresh();
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <h1>Join this workspace</h1>
        {!invitationId && <p className="auth-error">The invitation link is incomplete.</p>}
        {error && <p className="auth-error">{error}</p>}
        <button
          className="auth-submit"
          type="button"
          disabled={!invitationId || busy}
          onClick={() => void accept()}
        >
          {busy ? 'Joining…' : 'Accept invitation'}
        </button>
      </section>
    </main>
  );
}

export default function AcceptInvitationPage() {
  return (
    <Suspense
      fallback={
        <main className="auth-page">
          <p>Loading invitation…</p>
        </main>
      }
    >
      <InvitationAcceptance />
    </Suspense>
  );
}
