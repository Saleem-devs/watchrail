import { StatusPagesPage } from '../../../../features/status-pages/status-pages-page';

export default async function ProjectStatusPagesRoute({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <StatusPagesPage projectId={projectId} />;
}
