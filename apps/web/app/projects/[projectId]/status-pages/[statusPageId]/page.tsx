import { StatusPageManagement } from '../../../../../features/status-pages/status-page-management';

export default async function ProjectStatusPageRoute({
  params,
}: {
  params: Promise<{ projectId: string; statusPageId: string }>;
}) {
  const { projectId, statusPageId } = await params;
  return <StatusPageManagement projectId={projectId} statusPageId={statusPageId} />;
}
