'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ensureActiveOrganization } from '../../../lib/auth-client';
import { safeNextPath } from '../../../lib/safe-next-path';

export default function CompleteSignInPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    void ensureActiveOrganization()
      .then((ready) => {
        if (!active) return;
        if (!ready) {
          setError('Your workspace could not be selected. Please sign in again.');
          return;
        }
        const nextPath = safeNextPath(new URLSearchParams(window.location.search).get('next'));
        router.replace(nextPath);
        router.refresh();
      })
      .catch(() => {
        if (active) setError('Sign-in could not be completed. Please try again.');
      });

    return () => {
      active = false;
    };
  }, [router]);

  return (
    <div className="sign-in-panel" aria-live="polite" aria-busy={error == null}>
      <div className="sign-in-brand">
        <span className="sign-in-logo" aria-hidden="true">
          ◈
        </span>
        <span className="sign-in-product">Watchrail</span>
      </div>
      {error ? (
        <>
          <p className="sign-in-error" role="alert">
            {error}
          </p>
          <button
            type="button"
            className="sign-in-primary-btn"
            onClick={() => router.replace('/sign-in')}
          >
            Return to sign in
          </button>
        </>
      ) : (
        <p className="sign-in-subheading">Preparing your workspace…</p>
      )}
    </div>
  );
}
