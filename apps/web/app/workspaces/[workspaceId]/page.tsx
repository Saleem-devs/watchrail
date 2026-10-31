import { ProjectsPage } from '../../../features/projects/projects-page';

export default async function WorkspaceProjectsRoute({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <ProjectsPage workspaceId={workspaceId} />;
}
