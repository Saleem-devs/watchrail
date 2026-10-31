'use client';

import { Suspense, type FormEvent, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Form } from '../../../components/ui/form';
import { authClient, ensureActiveOrganization } from '../../../lib/auth-client';
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
      <div className="sign-in-brand">
        <span className="sign-in-logo" aria-hidden="true">
          ◈
        </span>
        <span className="sign-in-product">Watchrail</span>
      </div>

      <h1 className="sign-in-heading">Check your email</h1>
      <p className="sign-in-subheading">
        We sent a 6-digit code to <strong>{email}</strong>. Enter it below to sign in.
      </p>

      <Form onSubmit={(e) => void handleVerify(e)} noValidate>
        <label className="sign-in-label" htmlFor="otp">
          Verification code
        </label>
        <input
          id="otp"
          type="text"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          className="sign-in-input sign-in-otp-input"
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

        <button
          type="submit"
          className="sign-in-primary-btn"
          disabled={verifying || otp.length !== 6}
        >
          {verifying ? 'Verifying…' : 'Verify code'}
        </button>
      </Form>

      <div className="sign-in-resend">
        {resendCountdown > 0 ? (
          <span className="sign-in-resend-timer">Resend available in {resendCountdown}s</span>
        ) : (
          <button
            type="button"
            className="sign-in-resend-btn"
            disabled={resending}
            onClick={() => void handleResend()}
          >
            {resending ? 'Sending…' : "Didn't receive it? Resend code"}
          </button>
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
