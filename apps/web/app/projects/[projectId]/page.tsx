import { Dashboard } from '../../dashboard';

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <Dashboard view="overview" projectId={projectId} />;
}
