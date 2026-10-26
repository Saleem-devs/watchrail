import { Dashboard } from '../../dashboard';

export default async function MonitorDetailPage({
  params,
}: {
  params: Promise<{ monitorId: string }>;
}) {
  const { monitorId } = await params;
  return <Dashboard view="detail" monitorId={monitorId} />;
}
