import type { ReactNode } from 'react';

/**
 * Centered layout for sign-in and OTP verification pages.
 * Inherits the root layout's html/body/styles.
 */
export default function SignInLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="sign-in-shell">
      {children}
    </div>
  );
}
