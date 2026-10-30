import type { StatusPageApiError, StatusPageMonitor, WorkspaceStatusPage } from './types';

export async function loadStatusPage(statusPageId: string): Promise<WorkspaceStatusPage> {
  const response = await fetch(`/api/status-pages/${statusPageId}`, {
    headers: { Accept: 'application/json' },
  });
  const body = (await response.json()) as { data?: WorkspaceStatusPage } & StatusPageApiError;
  if (!response.ok || !body.data)
    throw new Error(apiErrorMessage(body, 'Could not load status page.'));
  return body.data;
}

export async function loadStatusPageMonitors(projectId?: string): Promise<StatusPageMonitor[]> {
  const response = await fetch(
    `/api/monitors${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    { headers: { Accept: 'application/json' } },
  );
  const body = (await response.json()) as { data?: StatusPageMonitor[] } & StatusPageApiError;
  if (!response.ok || !body.data)
    throw new Error(apiErrorMessage(body, 'Could not load monitors.'));
  return body.data;
}

export function apiErrorMessage(error: StatusPageApiError, fallback: string): string {
  return (
    error.fields?.statusPage?.[0] ?? error.fields?.components?.[0] ?? error.message ?? fallback
  );
}
