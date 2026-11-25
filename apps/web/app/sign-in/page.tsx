'use client';

import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '../../components/ui/button';
import { Form } from '../../components/ui/form';
import { Input } from '../../components/ui/form-control';
import { SignInBrand } from '../../features/auth/sign-in-brand';
import { authClient } from '../../lib/auth-client';
import {
  clearPendingAuthMethod,
  readLastUsedAuthMethod,
  rememberPendingAuthMethod,
  type AuthMethod,
} from '../../lib/auth-method-preference';
import { safeNextPath } from '../../lib/safe-next-path';

type SocialMethod = Exclude<AuthMethod, 'email'>;

interface SocialButtonProps {
  label: string;
  icon: ReactNode;
  disabled: boolean;
  lastUsed: boolean;
  onClick: () => void;
}

function SocialButton({ label, icon, disabled, lastUsed, onClick }: SocialButtonProps) {
  return (
    <Button variant="secondary" className="relative w-full" disabled={disabled} onClick={onClick}>
      <span className="sign-in-social-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="sign-in-social-label">{label}</span>
      {lastUsed ? <LastUsedBadge social /> : null}
    </Button>
  );
}

function LastUsedBadge({ social = false }: { social?: boolean }) {
  return (
    <span className={social ? 'sign-in-last-used sign-in-social-last-used' : 'sign-in-last-used'}>
      Last used
    </span>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

function GitLabIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="m23.955 13.587-1.342-4.135-2.664-8.189a.455.455 0 0 0-.867 0L16.418 9.45H7.582L4.918 1.263a.455.455 0 0 0-.867 0L1.387 9.452.045 13.587a.924.924 0 0 0 .331 1.023L12 23.054l11.624-8.443a.924.924 0 0 0 .331-1.023Z" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

export default function SignInPage() {
  const router = useRouter();
  const emailInputRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState('');
  const [emailPending, setEmailPending] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [socialPending, setSocialPending] = useState<SocialMethod | null>(null);
  const [lastUsedMethod, setLastUsedMethod] = useState<AuthMethod | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => setLastUsedMethod(readLastUsedAuthMethod()), 0);
    return () => window.clearTimeout(timeout);
  }, []);

  function returnPath(): string {
    return safeNextPath(new URLSearchParams(window.location.search).get('next'));
  }

  async function handleSocial(provider: SocialMethod) {
    setSocialPending(provider);
    setEmailError(null);
    rememberPendingAuthMethod(provider);
    try {
      await authClient.signIn.social({
        provider,
        callbackURL: `/sign-in/complete?next=${encodeURIComponent(returnPath())}`,
      });
      // Better Auth handles the redirect; control doesn't normally return here.
    } catch {
      clearPendingAuthMethod();
      setEmailError(`Could not start ${provider} sign-in. Please try again.`);
      setSocialPending(null);
    }
  }

  async function handleEmail(event: FormEvent) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      setEmailError('Enter the email address you use for Watchrail.');
      emailInputRef.current?.focus();
      return;
    }
    setEmailPending(true);
    setEmailError(null);
    try {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email: trimmed,
        type: 'sign-in',
      });
      if (result.error) {
        setEmailError(result.error.message ?? 'Could not send the verification code. Try again.');
        emailInputRef.current?.focus();
        return;
      }
      rememberPendingAuthMethod('email');
      router.push(
        `/sign-in/verify?email=${encodeURIComponent(trimmed)}&next=${encodeURIComponent(returnPath())}`,
      );
    } catch {
      setEmailError('Could not send the verification code. Try again.');
      emailInputRef.current?.focus();
    } finally {
      setEmailPending(false);
    }
  }

  const anyPending = emailPending || socialPending != null;

  return (
    <main className="sign-in-auth-view" data-watchrail-auth>
      <Link href="/" className="sign-in-home-link">
        <ArrowLeft aria-hidden="true" />
        Back to home
      </Link>

      <div className="sign-in-auth-inner">
        <SignInBrand />

        <header className="sign-in-header">
          <h1 id="sign-in-heading" className="sign-in-heading">
            Continue to Watchrail
          </h1>
          <p className="sign-in-subheading">Sign in or create an account to continue.</p>
        </header>

        <div className="sign-in-social-list" aria-label="Social sign-in methods">
          <SocialButton
            label="Continue with GitHub"
            icon={<GitHubIcon />}
            disabled={anyPending}
            lastUsed={lastUsedMethod === 'github'}
            onClick={() => void handleSocial('github')}
          />
          <SocialButton
            label="Continue with GitLab"
            icon={<GitLabIcon />}
            disabled={anyPending}
            lastUsed={lastUsedMethod === 'gitlab'}
            onClick={() => void handleSocial('gitlab')}
          />
          <SocialButton
            label="Continue with Google"
            icon={<GoogleIcon />}
            disabled={anyPending}
            lastUsed={lastUsedMethod === 'google'}
            onClick={() => void handleSocial('google')}
          />
        </div>

        <div className="sign-in-divider" role="separator" aria-label="Email sign-in">
          <span>Or continue with email</span>
        </div>

        <section className="sign-in-email-method" aria-labelledby="email-method-title">
          <div className="sign-in-email-heading">
            <span className="sign-in-email-copy">
              <h2 id="email-method-title">Email</h2>
              <p id="email-help">We’ll send a 6-digit verification code.</p>
            </span>
            {lastUsedMethod === 'email' ? <LastUsedBadge /> : null}
          </div>

          <Form onSubmit={(event) => void handleEmail(event)} noValidate>
            <label className="sign-in-label" htmlFor="email">
              Email address
            </label>
            <Input
              ref={emailInputRef}
              id="email"
              type="email"
              value={email}
              placeholder="you@example.com"
              autoComplete="email"
              disabled={anyPending}
              aria-invalid={emailError != null}
              aria-describedby={emailError ? 'email-help email-error' : 'email-help'}
              onChange={(event) => {
                setEmail(event.target.value);
                if (emailError) setEmailError(null);
              }}
            />
            {emailError != null ? (
              <p id="email-error" className="sign-in-error" role="alert">
                {emailError}
              </p>
            ) : null}
            <Button type="submit" variant="primary" className="mt-3 w-full" disabled={anyPending}>
              {emailPending ? 'Sending code…' : 'Continue with email'}
            </Button>
          </Form>
        </section>

        <p className="sign-in-footnote">
          By continuing, you agree to Watchrail’s{' '}
          <a
            href="https://github.com/Saleem-devs/watchrail"
            target="_blank"
            rel="noopener noreferrer"
          >
            open-source terms
          </a>
          .
        </p>
      </div>
    </main>
  );
}
