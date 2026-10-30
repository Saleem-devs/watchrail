import { StatusPageForm } from '../../../../../../features/status-pages/status-page-form';

export default async function EditProjectStatusPageRoute({
  params,
}: {
  params: Promise<{ projectId: string; statusPageId: string }>;
}) {
  const { projectId, statusPageId } = await params;
  return <StatusPageForm mode="edit" projectId={projectId} statusPageId={statusPageId} />;
}
