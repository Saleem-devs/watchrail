import type { ReactNode } from 'react';
import { AppShell } from '../../../components/app-shell';

export default function SecretsLayout({ children }: { children: ReactNode }) {
  return <AppShell page="secrets">{children}</AppShell>;
}
