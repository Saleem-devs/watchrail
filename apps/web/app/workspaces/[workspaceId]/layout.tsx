import type { ReactNode } from 'react';
import { WorkspaceAccessGuard } from '../../../features/workspaces/workspace-access-guard';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <WorkspaceAccessGuard workspaceId={workspaceId}>{children}</WorkspaceAccessGuard>;
}
