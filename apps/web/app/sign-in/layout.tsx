import type { ReactNode } from 'react';

export default function SignInLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="sign-in-shell">
      <section className="sign-in-auth-column">{children}</section>
    </div>
  );
}
