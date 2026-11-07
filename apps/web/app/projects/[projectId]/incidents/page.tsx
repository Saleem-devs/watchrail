import { IncidentsPage } from '../../../../features/incidents/incidents-page';
import type {
  IncidentSeverityFilter,
  IncidentStatusFilter,
} from '../../../../features/incidents/types';

export default async function ProjectIncidentsRoute({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const values = await searchParams;
  const initialStatus: IncidentStatusFilter =
    values.status === 'open' || values.status === 'resolved' ? values.status : 'all';
  const initialSeverity: IncidentSeverityFilter =
    values.severity === 'degraded' || values.severity === 'down' ? values.severity : 'all';
  const page = Number(typeof values.page === 'string' ? values.page : '1');
  const limit = Number(typeof values.limit === 'string' ? values.limit : '25');
  return (
    <IncidentsPage
      projectId={projectId}
      initialStatus={initialStatus}
      initialSeverity={initialSeverity}
      initialPage={Number.isSafeInteger(page) && page > 0 ? page : 1}
      initialLimit={[10, 25, 50, 100].includes(limit) ? limit : 25}
    />
  );
}
