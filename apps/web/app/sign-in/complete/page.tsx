'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '../../../components/ui/button';
import { SignInBrand } from '../../../features/auth/sign-in-brand';
import { ensureActiveOrganization } from '../../../lib/auth-client';
import { commitAuthMethod } from '../../../lib/auth-method-preference';
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
        commitAuthMethod();
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
      <SignInBrand />
      {error ? (
        <>
          <p className="sign-in-error" role="alert">
            {error}
          </p>
          <Button
            variant="primary"
            className="mt-3 w-full"
            onClick={() => router.replace('/sign-in')}
          >
            Return to sign in
          </Button>
        </>
      ) : (
        <p className="sign-in-subheading">Preparing your workspace…</p>
      )}
    </div>
  );
}
