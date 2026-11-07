import { IncidentDetailPage } from '../../../../../features/incidents/incident-detail-page';

export default async function ProjectIncidentDetailRoute({
  params,
}: {
  params: Promise<{ projectId: string; incidentId: string }>;
}) {
  const { projectId, incidentId } = await params;
  return <IncidentDetailPage projectId={projectId} incidentId={incidentId} />;
}
