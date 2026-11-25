'use client';

import { Suspense, type FormEvent, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '../../../components/ui/button';
import { Form } from '../../../components/ui/form';
import { Input } from '../../../components/ui/form-control';
import { SignInBrand } from '../../../features/auth/sign-in-brand';
import { authClient, ensureActiveOrganization } from '../../../lib/auth-client';
import { commitAuthMethod } from '../../../lib/auth-method-preference';
import { safeNextPath } from '../../../lib/safe-next-path';

const RESEND_COOLDOWN_SECONDS = 60;

function OtpVerifyForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const email = searchParams.get('email') ?? '';
  const nextPath = safeNextPath(searchParams.get('next'));

  const [otp, setOtp] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendCountdown, setResendCountdown] = useState(RESEND_COOLDOWN_SECONDS);

  // Count down the resend cooldown timer.
  useEffect(() => {
    if (resendCountdown <= 0) return;
    const id = setTimeout(() => setResendCountdown((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [resendCountdown]);

  // Redirect if no email was passed.
  useEffect(() => {
    if (!email) router.replace('/sign-in');
  }, [email, router]);

  async function handleVerify(e: FormEvent) {
    e.preventDefault();
    const code = otp.trim();
    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
      setError('Please enter the 6-digit code from your email.');
      return;
    }
    setVerifying(true);
    setError(null);
    try {
      const result = await authClient.signIn.emailOtp({
        email,
        otp: code,
      });
      if (result.error) {
        setError(result.error.message ?? 'Invalid or expired code. Please try again.');
        return;
      }
      if (!(await ensureActiveOrganization())) {
        setError('Your workspace could not be selected. Please try signing in again.');
        return;
      }
      commitAuthMethod('email');
      router.push(nextPath);
    } catch {
      setError('Verification failed. Please try again.');
    } finally {
      setVerifying(false);
    }
  }

  async function handleResend() {
    if (resendCountdown > 0 || resending) return;
    setResending(true);
    setError(null);
    try {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: 'sign-in',
      });
      if (result.error) {
        setError(result.error.message ?? 'Could not resend the code. Please try again.');
        return;
      }
      setResendCountdown(RESEND_COOLDOWN_SECONDS);
      setOtp('');
    } catch {
      setError('Could not resend the code. Please try again.');
    } finally {
      setResending(false);
    }
  }

  if (!email) return null;

  return (
    <div className="sign-in-panel">
      <SignInBrand />

      <h1 className="sign-in-heading">Check your email</h1>
      <p className="sign-in-subheading">
        We sent a 6-digit code to <strong>{email}</strong>. Enter it below to sign in.
      </p>

      <Form onSubmit={(e) => void handleVerify(e)} noValidate>
        <label className="sign-in-label" htmlFor="otp">
          Verification code
        </label>
        <Input
          id="otp"
          type="text"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          className="sign-in-otp-input"
          placeholder="000000"
          value={otp}
          autoComplete="one-time-code"
          autoFocus
          disabled={verifying}
          onChange={(e) => {
            // Only accept digits.
            const val = e.target.value.replace(/\D/g, '').slice(0, 6);
            setOtp(val);
            if (error) setError(null);
          }}
        />

        {error != null && (
          <p className="sign-in-error" role="alert">
            {error}
          </p>
        )}

        <Button
          type="submit"
          variant="primary"
          className="mt-3 w-full"
          disabled={verifying || otp.length !== 6}
        >
          {verifying ? 'Verifying…' : 'Verify code'}
        </Button>
      </Form>

      <div className="sign-in-resend">
        {resendCountdown > 0 ? (
          <span className="sign-in-resend-timer">Resend available in {resendCountdown}s</span>
        ) : (
          <span className="inline-flex items-center justify-center gap-2">
            <span>Didn’t receive it?</span>
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-rail-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-rail-accent disabled:cursor-not-allowed disabled:opacity-50"
              disabled={resending}
              onClick={() => void handleResend()}
            >
              {resending ? 'Sending…' : 'Resend code'}
            </button>
          </span>
        )}
      </div>

      <div className="sign-in-back">
        <a href="/sign-in">← Use a different email or sign-in method</a>
      </div>
    </div>
  );
}

export default function OtpVerifyPage() {
  return (
    <Suspense fallback={<div className="sign-in-panel" aria-busy="true" />}>
      <OtpVerifyForm />
    </Suspense>
  );
}
