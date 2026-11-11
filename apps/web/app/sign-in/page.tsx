'use client';

import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, BellRing, Braces, GitBranch, Mail, Radio, ShieldCheck } from 'lucide-react';
import { Form } from '../../components/ui/form';
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
    <button type="button" className="sign-in-social-btn" disabled={disabled} onClick={onClick}>
      <span className="sign-in-social-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="sign-in-social-label">{label}</span>
      {lastUsed ? <LastUsedBadge /> : null}
    </button>
  );
}

function LastUsedBadge() {
  return <span className="sign-in-last-used">Last used</span>;
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
    <main className="sign-in-page" data-watchrail-auth>
      <section className="sign-in-context" aria-labelledby="sign-in-context-title">
        <SignInBrand />

        <div className="sign-in-context-copy">
          <h2 id="sign-in-context-title">Know what changed before your customers do.</h2>
          <p>
            Watchrail verifies your services, coordinates incident response, and keeps public status
            communication accurate.
          </p>
        </div>

        <ul className="sign-in-capabilities" aria-label="Watchrail reliability workflow">
          <li>
            <Activity aria-hidden="true" />
            <span>Verify services from every assigned location</span>
          </li>
          <li>
            <BellRing aria-hidden="true" />
            <span>Route confirmed incidents to the right channels</span>
          </li>
          <li>
            <Radio aria-hidden="true" />
            <span>Publish clear updates without rewriting measured health</span>
          </li>
        </ul>

        <p className="sign-in-security-note">
          <ShieldCheck aria-hidden="true" />
          Passwordless by default. Watchrail never asks you to create a password.
        </p>
      </section>

      <section className="sign-in-auth" aria-labelledby="sign-in-heading">
        <div className="sign-in-auth-inner">
          <SignInBrand mobile />

          <header className="sign-in-header">
            <h1 id="sign-in-heading" className="sign-in-heading">
              Sign in to Watchrail
            </h1>
            <p className="sign-in-subheading">
              Use GitHub, GitLab, Google, or a one-time code sent to your email.
            </p>
          </header>

          <div className="sign-in-social-list" aria-label="Social sign-in methods">
            <SocialButton
              label="Continue with GitHub"
              icon={<Braces />}
              disabled={anyPending}
              lastUsed={lastUsedMethod === 'github'}
              onClick={() => void handleSocial('github')}
            />
            <SocialButton
              label="Continue with GitLab"
              icon={<GitBranch />}
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
            <span>Or use email</span>
          </div>

          <section className="sign-in-email-method" aria-labelledby="email-method-title">
            <div className="sign-in-email-heading">
              <span className="sign-in-email-icon" aria-hidden="true">
                <Mail />
              </span>
              <span className="sign-in-email-copy">
                <h2 id="email-method-title">Email verification code</h2>
                <p id="email-help">We’ll send a 6-digit code. No password required.</p>
              </span>
              {lastUsedMethod === 'email' ? <LastUsedBadge /> : null}
            </div>

            <Form onSubmit={(event) => void handleEmail(event)} noValidate>
              <label className="sign-in-label" htmlFor="email">
                Email address
              </label>
              <input
                ref={emailInputRef}
                id="email"
                type="email"
                className="sign-in-input"
                value={email}
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
              <button type="submit" className="sign-in-primary-btn" disabled={anyPending}>
                {emailPending ? 'Sending code…' : 'Send sign-in code'}
              </button>
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
      </section>
    </main>
  );
}
