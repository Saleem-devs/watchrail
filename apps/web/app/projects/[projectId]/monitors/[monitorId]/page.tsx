import { Dashboard } from '../../../../dashboard';
import { safeInternalPath } from '../../../../../lib/navigation-origin';

export default async function ProjectMonitorDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; monitorId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId, monitorId } = await params;
  const values = await searchParams;
  const backPath =
    safeInternalPath(typeof values.from === 'string' ? values.from : undefined) ??
    `/projects/${projectId}/monitors`;
  return (
    <Dashboard view="detail" projectId={projectId} monitorId={monitorId} backPath={backPath} />
  );
}
