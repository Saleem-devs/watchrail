import { StatusPageIncidentsList } from '../../../../../../features/status-pages/status-page-incidents-list';

export default async function StatusPageIncidentsRoute({
  params,
}: {
  params: Promise<{ projectId: string; statusPageId: string }>;
}) {
  const { projectId, statusPageId } = await params;
  return <StatusPageIncidentsList projectId={projectId} statusPageId={statusPageId} />;
}
