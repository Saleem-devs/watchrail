import type {
  MaintenanceApiError,
  MaintenanceMonitor,
  MaintenanceWindow,
  MaintenanceWindowAuditEvent,
} from './types';

export class MaintenanceWindowRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: MaintenanceApiError,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as MaintenanceApiError & { data?: T };
  if (!response.ok || body.data === undefined) {
    throw new MaintenanceWindowRequestError(
      body.message ?? 'The maintenance request failed.',
      response.status,
      body,
    );
  }
  return body.data;
}

export function listMaintenanceWindows(projectId: string): Promise<MaintenanceWindow[]> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/maintenance-windows`);
}

export function findMaintenanceWindow(
  projectId: string,
  maintenanceWindowId: string,
): Promise<MaintenanceWindow> {
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/maintenance-windows/${encodeURIComponent(maintenanceWindowId)}`,
  );
}

export function createMaintenanceWindow(
  projectId: string,
  input: Pick<MaintenanceWindow, 'name' | 'schedule' | 'target' | 'effects'>,
): Promise<MaintenanceWindow> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/maintenance-windows`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateMaintenanceWindow(
  projectId: string,
  maintenanceWindowId: string,
  input: Pick<MaintenanceWindow, 'name' | 'schedule' | 'target' | 'effects'>,
): Promise<MaintenanceWindow> {
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/maintenance-windows/${encodeURIComponent(maintenanceWindowId)}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
}

export function archiveMaintenanceWindow(
  projectId: string,
  maintenanceWindowId: string,
): Promise<MaintenanceWindow> {
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/maintenance-windows/${encodeURIComponent(maintenanceWindowId)}`,
    { method: 'DELETE' },
  );
}

export function listMaintenanceWindowAuditEvents(
  projectId: string,
  maintenanceWindowId: string,
): Promise<MaintenanceWindowAuditEvent[]> {
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/maintenance-windows/${encodeURIComponent(maintenanceWindowId)}/audit-events`,
  );
}

export async function listMaintenanceMonitors(projectId: string): Promise<MaintenanceMonitor[]> {
  const monitors = new Map<string, MaintenanceMonitor>();
  let page = 1;
  let totalPages = 1;
  do {
    const query = new URLSearchParams({ projectId, page: String(page), limit: '100' });
    const response = await fetch(`/api/monitors?${query}`, {
      headers: { Accept: 'application/json' },
    });
    const body = (await response.json().catch(() => ({}))) as MaintenanceApiError & {
      data?: MaintenanceMonitor[];
      page?: { totalPages: number };
    };
    if (!response.ok || !body.data) {
      throw new MaintenanceWindowRequestError(
        body.message ?? 'Could not load project monitors.',
        response.status,
        body,
      );
    }
    for (const monitor of body.data) monitors.set(monitor.id, monitor);
    totalPages = body.page?.totalPages ?? 1;
    page += 1;
  } while (page <= totalPages);
  return [...monitors.values()];
}
