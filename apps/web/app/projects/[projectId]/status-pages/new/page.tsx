import { StatusPageForm } from '../../../../../features/status-pages/status-page-form';

export default async function NewProjectStatusPageRoute({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <StatusPageForm mode="create" projectId={projectId} />;
}
