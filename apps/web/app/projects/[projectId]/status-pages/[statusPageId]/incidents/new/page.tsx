import { StatusPageIncidentForm } from '../../../../../../../features/status-pages/status-page-incident-form';

export default async function NewStatusPageIncidentRoute({
  params,
}: {
  params: Promise<{ projectId: string; statusPageId: string }>;
}) {
  const { projectId, statusPageId } = await params;
  return <StatusPageIncidentForm projectId={projectId} statusPageId={statusPageId} />;
}
