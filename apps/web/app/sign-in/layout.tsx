/**
 * Centered layout for sign-in and OTP verification pages.
 * Inherits the root layout's html/body/styles.
 */

import type { ReactNode } from 'react';

export default function SignInLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="sign-in-shell">{children}</div>;
}
