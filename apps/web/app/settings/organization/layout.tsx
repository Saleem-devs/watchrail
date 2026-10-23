import type { ReactNode } from 'react';
import { AppShell } from '../../../components/app-shell';

export default function OrganizationLayout({ children }: { children: ReactNode }) {
  return <AppShell page="organization">{children}</AppShell>;
}
