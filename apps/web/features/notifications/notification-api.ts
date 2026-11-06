import type {
  NotificationApiError,
  NotificationDelivery,
  EmailChannel,
  NotificationMonitor,
  WebhookChannel,
} from './types';

export class NotificationRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: NotificationApiError,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return (await requestEnvelope<T>(path, init)).data;
}

async function requestEnvelope<T>(
  path: string,
  init?: RequestInit,
): Promise<{
  data: T;
  page?: { number: number; limit: number; total: number; totalPages: number };
}> {
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
    code?: string;
    message?: string;
    fields?: Record<string, string[]>;
    page?: { number: number; limit: number; total: number; totalPages: number };
  };
  if (!response.ok || body.data === undefined) {
    throw new NotificationRequestError(
      body.message ?? 'The notification request failed.',
      response.status,
      body,
    );
  }
  return {
    data: body.data,
    ...(body.page ? { page: body.page } : {}),
  };
}

export async function listNotificationMonitors(projectId: string): Promise<NotificationMonitor[]> {
  const monitors = new Map<string, NotificationMonitor>();
  let page = 1;
  let totalPages = 1;
  do {
    const query = new URLSearchParams({ projectId, page: String(page), limit: '100' });
    const response = await requestEnvelope<NotificationMonitor[]>(`/api/monitors?${query}`);
    for (const monitor of response.data) monitors.set(monitor.id, monitor);
    if (!response.page) break;
    totalPages = response.page.totalPages;
    page += 1;
  } while (page <= totalPages);
  return [...monitors.values()];
}

export function listWebhookChannels(projectId: string): Promise<WebhookChannel[]> {
  return request(`/api/webhook-endpoints?projectId=${encodeURIComponent(projectId)}`);
}

export function listEmailChannels(projectId: string): Promise<EmailChannel[]> {
  return request(`/api/email-channels?projectId=${encodeURIComponent(projectId)}`);
}

export function findEmailChannel(channelId: string): Promise<EmailChannel> {
  return request(`/api/email-channels/${encodeURIComponent(channelId)}`);
}

export function createEmailChannel(input: {
  projectId: string;
  name: string;
  recipientEmails: string[];
  enabled: boolean;
  routing: EmailChannel['routing'];
}): Promise<EmailChannel> {
  return request('/api/email-channels', { method: 'POST', body: JSON.stringify(input) });
}

export function updateEmailChannel(
  channelId: string,
  input: {
    name: string;
    recipientEmails: string[];
    routing: EmailChannel['routing'];
  },
): Promise<EmailChannel> {
  return request(`/api/email-channels/${encodeURIComponent(channelId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function setEmailChannelEnabled(channelId: string, enabled: boolean): Promise<EmailChannel> {
  return request(`/api/email-channels/${encodeURIComponent(channelId)}/enabled`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
}

export function sendEmailChannelTest(channelId: string): Promise<{ deliveryId: string }> {
  return request(`/api/email-channels/${encodeURIComponent(channelId)}/test`, { method: 'POST' });
}

export function listEmailDeliveries(channelId: string): Promise<NotificationDelivery[]> {
  return request(`/api/email-channels/${encodeURIComponent(channelId)}/deliveries?limit=25`);
}

export function deleteEmailChannel(channelId: string): Promise<{ deleted: true }> {
  return request(`/api/email-channels/${encodeURIComponent(channelId)}`, { method: 'DELETE' });
}

export function findWebhookChannel(endpointId: string): Promise<WebhookChannel> {
  return request(`/api/webhook-endpoints/${encodeURIComponent(endpointId)}`);
}

export function createWebhookChannel(input: {
  projectId: string;
  name: string;
  url: string;
  signingSecret: string;
  enabled: boolean;
  routing: WebhookChannel['routing'];
}): Promise<WebhookChannel> {
  return request('/api/webhook-endpoints', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateWebhookChannel(
  endpointId: string,
  input: {
    name: string;
    url: string;
    signingSecret: { retain: true } | { value: string };
    routing: WebhookChannel['routing'];
  },
): Promise<WebhookChannel> {
  return request(`/api/webhook-endpoints/${encodeURIComponent(endpointId)}/configuration`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function setWebhookChannelEnabled(
  endpointId: string,
  enabled: boolean,
): Promise<WebhookChannel> {
  return request(`/api/webhook-endpoints/${encodeURIComponent(endpointId)}/enabled`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
}

export function listWebhookDeliveries(endpointId: string): Promise<NotificationDelivery[]> {
  return request(`/api/webhook-endpoints/${encodeURIComponent(endpointId)}/deliveries?limit=25`);
}

export function deleteWebhookChannel(endpointId: string): Promise<{ deleted: true }> {
  return request(`/api/webhook-endpoints/${encodeURIComponent(endpointId)}`, {
    method: 'DELETE',
  });
}
