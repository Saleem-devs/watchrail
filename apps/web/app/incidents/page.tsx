import { IncidentsPage } from '../../features/incidents/incidents-page';
import type { IncidentStatusFilter } from '../../features/incidents/types';

export default async function IncidentsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const values = await searchParams;
  const requestedStatus = values.status;
  const initialStatus: IncidentStatusFilter =
    requestedStatus === 'open' || requestedStatus === 'resolved' ? requestedStatus : 'all';
  const requestedPage = Number(typeof values.page === 'string' ? values.page : '1');
  const requestedLimit = Number(typeof values.limit === 'string' ? values.limit : '25');
  const initialPage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const initialLimit = [10, 25, 50, 100].includes(requestedLimit) ? requestedLimit : 25;
  return (
    <IncidentsPage
      key={`${initialStatus}:${initialPage}:${initialLimit}`}
      initialStatus={initialStatus}
      initialPage={initialPage}
      initialLimit={initialLimit}
    />
  );
}
