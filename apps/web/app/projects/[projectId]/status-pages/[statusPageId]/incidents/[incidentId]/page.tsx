import { StatusPageIncidentDetail } from '../../../../../../../features/status-pages/status-page-incident-detail';

export default async function StatusPageIncidentDetailRoute({
  params,
}: {
  params: Promise<{ projectId: string; statusPageId: string; incidentId: string }>;
}) {
  const { projectId, statusPageId, incidentId } = await params;
  return (
    <StatusPageIncidentDetail
      projectId={projectId}
      statusPageId={statusPageId}
      incidentId={incidentId}
    />
  );
}
