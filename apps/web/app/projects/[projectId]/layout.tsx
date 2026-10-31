import type { ReactNode } from 'react';
import { ProjectAccessGuard } from '../../../features/projects/project-access-guard';

export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ProjectAccessGuard projectId={projectId}>{children}</ProjectAccessGuard>;
}
