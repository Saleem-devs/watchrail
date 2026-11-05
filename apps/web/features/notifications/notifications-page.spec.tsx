import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationsPage } from './notifications-page';
import { WebhookChannelForm } from './webhook-channel-form';
import type { NotificationMonitor, WebhookChannel } from './types';

vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const projectId = '11111111-1111-4111-8111-111111111111';
const monitor: NotificationMonitor = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Payments API',
  type: 'HTTP',
  lifecycleState: 'ENABLED',
};
const channel: WebhookChannel = {
  id: '33333333-3333-4333-8333-333333333333',
  projectId,
  name: 'Operations webhook',
  url: 'https://hooks.example.com/watchrail',
  enabled: true,
  versionNumber: 1,
  signingSecret: { hasValue: true },
  routing: {
    monitorIds: [monitor.id],
    notifyOnIncident: true,
    notifyOnRecovery: true,
  },
  createdAt: '2026-11-05T09:00:00.000Z',
  updatedAt: '2026-11-05T09:00:00.000Z',
};

afterEach(() => vi.restoreAllMocks());

describe('notifications page', () => {
  it('creates a project webhook with explicit monitor and event routing', async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: channel }, 201));
    const onSaved = vi.fn();

    render(
      <WebhookChannelForm
        formId="webhook-form"
        projectId={projectId}
        monitors={[monitor]}
        onSaved={onSaved}
      />,
    );
    await user.type(screen.getByLabelText('Channel name'), channel.name);
    await user.type(screen.getByLabelText('Endpoint URL'), channel.url);
    await user.type(screen.getByLabelText(/^Signing secret/), 'a-strong-webhook-signing-secret');
    await user.click(screen.getByText(monitor.name));
    fireEvent.submit(screen.getByRole('form', { name: 'Add webhook channel' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(channel));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/webhook-endpoints');
    expect(requestJson(fetchMock.mock.calls[0])).toEqual({
      projectId,
      name: channel.name,
      url: channel.url,
      signingSecret: 'a-strong-webhook-signing-secret',
      enabled: true,
      routing: {
        monitorIds: [monitor.id],
        notifyOnIncident: true,
        notifyOnRecovery: true,
      },
    });
  });

  it('retains the encrypted signing secret while updating routing atomically', async () => {
    const user = userEvent.setup();
    const updated = {
      ...channel,
      routing: { ...channel.routing, notifyOnRecovery: false },
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ data: updated }));

    render(
      <WebhookChannelForm
        formId="webhook-form"
        projectId={projectId}
        monitors={[monitor]}
        channel={channel}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/^Replace signing secret/)).toHaveValue('');
    await user.click(screen.getByText('Incident resolved'));
    fireEvent.submit(screen.getByRole('form', { name: 'Edit webhook channel' }));

    await waitFor(() =>
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        `/api/webhook-endpoints/${channel.id}/configuration`,
      ),
    );
    expect(requestJson(fetchMock.mock.calls[0])).toMatchObject({
      signingSecret: { retain: true },
      routing: {
        monitorIds: [monitor.id],
        notifyOnIncident: true,
        notifyOnRecovery: false,
      },
    });
  });

  it('shows failed delivery evidence without exposing a payload or signing secret', async () => {
    const user = userEvent.setup();
    const delivery = {
      id: '44444444-4444-4444-8444-444444444444',
      event: {
        id: '55555555-5555-4555-8555-555555555555',
        type: 'INCIDENT_OPENED',
        occurredAt: '2026-11-05T10:00:00.000Z',
        monitorId: monitor.id,
        incidentId: '66666666-6666-4666-8666-666666666666',
      },
      status: 'DEAD',
      attemptCount: 8,
      lastAttemptAt: '2026-11-05T10:02:00.000Z',
      lastErrorCode: 'HTTP_503',
      lastHttpStatus: 503,
      nextAttemptAt: null,
      leaseExpiresAt: null,
      deliveredAt: null,
      deadAt: '2026-11-05T10:02:00.000Z',
      deadReason: 'MAX_ATTEMPTS',
      createdAt: '2026-11-05T10:00:00.000Z',
    } as const;
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: [channel] }))
      .mockResolvedValueOnce(json({ data: [monitor] }))
      .mockResolvedValueOnce(json({ data: [delivery] }));

    render(<NotificationsPage projectId={projectId} />);
    await screen.findByText(channel.name);
    await user.click(screen.getByRole('button', { name: 'History' }));

    const history = await screen.findByRole('heading', { name: 'Delivery history' });
    const section = history.closest('section');
    expect(section).not.toBeNull();
    expect(within(section!).getByText('Failed')).toBeInTheDocument();
    expect(within(section!).getByText(/HTTP_503 · HTTP 503/)).toBeInTheDocument();
    expect(section).not.toHaveTextContent('signingSecret');
    expect(section).not.toHaveTextContent('payload');
  });

  it('keeps backend routing validation next to the editor', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      json(
        {
          code: 'VALIDATION_FAILED',
          message: 'Webhook endpoint settings are invalid.',
          fields: { monitorIds: ['Every monitor must belong to the selected project.'] },
        },
        400,
      ),
    );

    render(
      <WebhookChannelForm
        formId="webhook-form"
        projectId={projectId}
        monitors={[monitor]}
        channel={channel}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.submit(screen.getByRole('form', { name: 'Edit webhook channel' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Every monitor must belong to the selected project.',
    );
  });

  it('keeps list actions as dedicated create and edit routes', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: [channel] }))
      .mockResolvedValueOnce(json({ data: [monitor] }));

    render(<NotificationsPage projectId={projectId} />);
    await screen.findByText(channel.name);
    expect(screen.getByRole('link', { name: 'Add webhook' })).toHaveAttribute(
      'href',
      `/projects/${projectId}/notifications/new`,
    );
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      `/projects/${projectId}/notifications/${channel.id}/edit`,
    );
  });
});

function requestJson(call: readonly unknown[] | undefined): unknown {
  const init = call?.[1];
  const body = typeof init === 'object' && init !== null && 'body' in init ? init.body : undefined;
  if (typeof body !== 'string') throw new TypeError('Expected a JSON request body.');
  return JSON.parse(body) as unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
