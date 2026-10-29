import { Dashboard } from '../../dashboard';
import { safeInternalPath } from '../../../lib/navigation-origin';

export default async function MonitorDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ monitorId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { monitorId } = await params;
  const values = await searchParams;
  const backPath =
    safeInternalPath(typeof values.from === 'string' ? values.from : undefined) ?? '/monitors';

  return <Dashboard view="detail" monitorId={monitorId} backPath={backPath} />;
}
