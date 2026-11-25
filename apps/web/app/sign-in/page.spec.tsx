import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SignInPage from './page';

const { push, social, sendVerificationOtp } = vi.hoisted(() => ({
  push: vi.fn(),
  social: vi.fn(),
  sendVerificationOtp: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('../../lib/auth-client', () => ({
  authClient: {
    signIn: { social },
    emailOtp: { sendVerificationOtp },
  },
}));

describe('SignInPage', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => vi.clearAllMocks());

  it('shows every accepted method and marks only the last successful method', async () => {
    localStorage.setItem('watchrail:last-used-auth-method', 'github');

    render(<SignInPage />);

    const github = screen.getByRole('button', { name: /continue with github/i });
    expect(github).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue with gitlab/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Email' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
    expect(screen.getByText('Sign in or create an account to continue.')).toBeInTheDocument();

    await waitFor(() => expect(within(github).getByText('Last used')).toBeInTheDocument());
    expect(screen.getAllByText('Last used')).toHaveLength(1);
  });

  it('does not change last-used until a social callback succeeds', async () => {
    social.mockResolvedValue(undefined);

    render(<SignInPage />);
    await userEvent.click(screen.getByRole('button', { name: /continue with gitlab/i }));

    expect(sessionStorage.getItem('watchrail:pending-auth-method')).toBe('gitlab');
    expect(localStorage.getItem('watchrail:last-used-auth-method')).toBeNull();
    expect(social).toHaveBeenCalledWith({
      provider: 'gitlab',
      callbackURL: '/sign-in/complete?next=%2F',
    });
  });

  it('stages email as pending only after the verification code is sent', async () => {
    sendVerificationOtp.mockResolvedValue({ error: null });

    render(<SignInPage />);
    await userEvent.type(screen.getByLabelText('Email address'), 'operator@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Continue with email' }));

    await waitFor(() => {
      expect(sessionStorage.getItem('watchrail:pending-auth-method')).toBe('email');
    });
    expect(push).toHaveBeenCalledWith('/sign-in/verify?email=operator%40example.com&next=%2F');
    expect(localStorage.getItem('watchrail:last-used-auth-method')).toBeNull();
  });
});
