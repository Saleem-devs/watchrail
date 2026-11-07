import type { IncidentActionEvent, WorkspaceIncident, WorkspaceIncidentDetail } from './types';

export class IncidentRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
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
  const body = (await response.json().catch(() => ({}))) as {
    data?: T;
    message?: string;
    code?: string;
  };
  if (!response.ok || body.data === undefined) {
    throw new IncidentRequestError(
      body.message ?? 'The incident request failed.',
      response.status,
      body.code,
    );
  }
  return body.data;
}

export function findIncident(incidentId: string): Promise<WorkspaceIncidentDetail> {
  return request(`/api/incidents/${encodeURIComponent(incidentId)}`);
}

export function listIncidentActions(incidentId: string): Promise<IncidentActionEvent[]> {
  return request(`/api/incidents/${encodeURIComponent(incidentId)}/audit-events`);
}

export function listRelatedIncidents(incidentId: string): Promise<WorkspaceIncident[]> {
  return request(`/api/incidents/${encodeURIComponent(incidentId)}/related`);
}

export function acknowledgeIncident(incidentId: string): Promise<WorkspaceIncident> {
  return request(`/api/incidents/${encodeURIComponent(incidentId)}/acknowledge`, {
    method: 'POST',
  });
}

export function silenceIncident(incidentId: string, until: Date): Promise<WorkspaceIncident> {
  return request(`/api/incidents/${encodeURIComponent(incidentId)}/silence`, {
    method: 'POST',
    body: JSON.stringify({ until: until.toISOString() }),
  });
}

export function unsilenceIncident(incidentId: string): Promise<WorkspaceIncident> {
  return request(`/api/incidents/${encodeURIComponent(incidentId)}/silence`, {
    method: 'DELETE',
  });
}

export function resolveIncident(
  incidentId: string,
  note: string | null,
): Promise<WorkspaceIncident> {
  return request(`/api/incidents/${encodeURIComponent(incidentId)}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
}
