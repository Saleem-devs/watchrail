import { Dashboard } from '../../../../dashboard';

export default async function NewProjectMonitorPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <Dashboard view="create" projectId={projectId} backPath={`/projects/${projectId}/monitors`} />
  );
}
