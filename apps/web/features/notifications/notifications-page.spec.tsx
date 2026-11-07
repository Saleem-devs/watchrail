import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listNotificationMonitors } from './notification-api';
import { NotificationChannelDetailPage } from './notification-channel-detail-page';
import { NotificationChannelsPage } from './notification-channels-page';
import { WebhookChannelForm } from './webhook-channel-form';
import { EmailChannelForm } from './email-channel-form';
import { SlackChannelForm } from './slack-channel-form';
import type { EmailChannel, NotificationMonitor, SlackChannel, WebhookChannel } from './types';

vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
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
const emailChannel: EmailChannel = {
  id: '77777777-7777-4777-8777-777777777777',
  projectId,
  type: 'EMAIL',
  name: 'Primary on-call',
  enabled: true,
  versionNumber: 1,
  recipientEmails: ['alerts@example.com'],
  routing: channel.routing,
  createdAt: channel.createdAt,
  updatedAt: channel.updatedAt,
};
const slackChannel: SlackChannel = {
  id: '88888888-8888-4888-8888-888888888888',
  projectId,
  type: 'SLACK',
  name: 'Operations Slack',
  enabled: true,
  versionNumber: 1,
  webhookUrl: { hasValue: true },
  routing: channel.routing,
  createdAt: channel.createdAt,
  updatedAt: channel.updatedAt,
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
    await user.click(screen.getByLabelText(/Selected monitors/));
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
        allMonitors: false,
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
        allMonitors: false,
        monitorIds: [monitor.id],
        notifyOnIncident: true,
        notifyOnRecovery: false,
      },
    });
  });

  it('creates an email channel for the entire project by default', async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: emailChannel }, 201));
    const onSaved = vi.fn();
    render(
      <EmailChannelForm
        formId="email-form"
        projectId={projectId}
        monitors={[monitor]}
        onSaved={onSaved}
      />,
    );
    await user.type(screen.getByLabelText('Channel name'), emailChannel.name);
    await user.type(
      screen.getByLabelText(/^Recipient emails/),
      'Alerts@Example.com\noncall@example.com',
    );
    expect(screen.getByLabelText(/Entire project/)).toBeChecked();
    expect(screen.queryByText(monitor.name)).not.toBeInTheDocument();
    fireEvent.submit(document.querySelector('#email-form')!);

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(emailChannel));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/email-channels');
    expect(requestJson(fetchMock.mock.calls[0])).toMatchObject({
      projectId,
      name: emailChannel.name,
      recipientEmails: ['alerts@example.com', 'oncall@example.com'],
      routing: {
        allMonitors: true,
        monitorIds: [],
        notifyOnIncident: true,
        notifyOnRecovery: true,
      },
    });
  });

  it('creates a Slack channel and retains its encrypted webhook during edits', async () => {
    const user = userEvent.setup();
    const webhookUrl = [
      'https://hooks.slack.com',
      'services',
      'T00000000',
      'B00000000',
      'XXXXXXXXXXXXXXXXXXXXXXXX',
    ].join('/');
    const createFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: slackChannel }, 201));
    const createdView = render(
      <SlackChannelForm
        formId="slack-form"
        projectId={projectId}
        monitors={[monitor]}
        onSaved={vi.fn()}
      />,
    );
    await user.type(screen.getByLabelText('Channel name'), slackChannel.name);
    await user.type(screen.getByLabelText(/^Incoming webhook URL/), webhookUrl);
    await user.click(screen.getByLabelText(/Selected monitors/));
    await user.click(screen.getByText(monitor.name));
    fireEvent.submit(screen.getByRole('form', { name: 'Add Slack channel' }));
    await waitFor(() => expect(createFetch).toHaveBeenCalledTimes(1));
    expect(requestJson(createFetch.mock.calls[0])).toMatchObject({
      projectId,
      name: slackChannel.name,
      webhookUrl,
      routing: { allMonitors: false, monitorIds: [monitor.id] },
    });

    createdView.unmount();
    createFetch.mockRestore();
    const updateFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: slackChannel }));
    render(
      <SlackChannelForm
        formId="slack-edit-form"
        projectId={projectId}
        monitors={[monitor]}
        channel={slackChannel}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/^Replace incoming webhook URL/)).toHaveValue('');
    fireEvent.submit(screen.getByRole('form', { name: 'Edit Slack channel' }));
    await waitFor(() => expect(updateFetch).toHaveBeenCalledTimes(1));
    expect(requestJson(updateFetch.mock.calls[0])).toMatchObject({ webhookUrl: { retain: true } });
  });

  it('shows failed delivery evidence without exposing a payload or signing secret', async () => {
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
      suppressedAt: null,
      suppressionReason: null,
      createdAt: '2026-11-05T10:00:00.000Z',
    } as const;
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: channel }))
      .mockResolvedValueOnce(json({ data: [monitor] }))
      .mockResolvedValueOnce(json({ data: [delivery] }));

    render(
      <NotificationChannelDetailPage
        projectId={projectId}
        channelId={channel.id}
        channelType="WEBHOOK"
      />,
    );

    const history = await screen.findByRole('heading', { name: 'Delivery history' });
    const section = history.closest('section');
    expect(section).not.toBeNull();
    expect(within(section!).getByText('Failed')).toBeInTheDocument();
    expect(within(section!).getByText(/HTTP_503 · HTTP 503/)).toBeInTheDocument();
    expect(section).not.toHaveTextContent('signingSecret');
    expect(section).not.toHaveTextContent('payload');
  });

  it('presents maintenance suppression as a neutral terminal delivery state', async () => {
    const delivery = {
      id: '44444444-4444-4444-8444-444444444444',
      event: {
        id: '55555555-5555-4555-8555-555555555555',
        type: 'INCIDENT_OPENED',
        occurredAt: '2026-11-05T10:00:00.000Z',
        monitorId: monitor.id,
        incidentId: '66666666-6666-4666-8666-666666666666',
      },
      status: 'SUPPRESSED',
      attemptCount: 1,
      lastAttemptAt: '2026-11-05T10:00:02.000Z',
      lastErrorCode: null,
      lastHttpStatus: null,
      nextAttemptAt: null,
      leaseExpiresAt: null,
      deliveredAt: null,
      deadAt: null,
      deadReason: null,
      suppressedAt: '2026-11-05T10:00:02.000Z',
      suppressionReason: 'MAINTENANCE_WINDOW',
      createdAt: '2026-11-05T10:00:00.000Z',
    } as const;
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: channel }))
      .mockResolvedValueOnce(json({ data: [monitor] }))
      .mockResolvedValueOnce(json({ data: [delivery] }));

    render(
      <NotificationChannelDetailPage
        projectId={projectId}
        channelId={channel.id}
        channelType="WEBHOOK"
      />,
    );

    const section = (await screen.findByRole('heading', { name: 'Delivery history' })).closest(
      'section',
    );
    expect(section).not.toBeNull();
    expect(within(section!).getByText('Suppressed')).toBeInTheDocument();
    expect(within(section!).queryByText('Failed')).not.toBeInTheDocument();
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
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = requestPath(input);
      if (path.includes('incident-reminder-policy'))
        return Promise.resolve(json({ data: { delaysMinutes: [] } }));
      if (path.startsWith('/api/webhook-endpoints'))
        return Promise.resolve(json({ data: [channel] }));
      return Promise.resolve(json({ data: [] }));
    });

    render(<NotificationChannelsPage projectId={projectId} />);
    await screen.findByText(channel.name);
    expect(screen.getByRole('link', { name: 'Add another Webhook channel' })).toHaveAttribute(
      'href',
      `/projects/${projectId}/notifications/new`,
    );
    expect(screen.getByRole('link', { name: 'Connect Email' })).toHaveAttribute(
      'href',
      `/projects/${projectId}/notifications/email/new`,
    );
    expect(screen.getByRole('link', { name: 'Connect Slack' })).toHaveAttribute(
      'href',
      `/projects/${projectId}/notifications/slack/new`,
    );
    await user.click(screen.getByRole('button', { name: `Actions for ${channel.name}` }));
    expect(screen.getByRole('menuitem', { name: 'View' })).toHaveAttribute(
      'href',
      `/projects/${projectId}/notifications/${channel.id}`,
    );
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveAttribute(
      'href',
      `/projects/${projectId}/notifications/${channel.id}/edit`,
    );
  });

  it('confirms channel deletion from the row action menu', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = requestPath(input);
      if (init?.method === 'DELETE') return Promise.resolve(json({ data: { deleted: true } }));
      if (path.includes('incident-reminder-policy'))
        return Promise.resolve(json({ data: { delaysMinutes: [] } }));
      if (path.startsWith('/api/webhook-endpoints'))
        return Promise.resolve(json({ data: [channel] }));
      return Promise.resolve(json({ data: [] }));
    });

    render(<NotificationChannelsPage projectId={projectId} />);
    await screen.findByText(channel.name);
    await user.click(screen.getByRole('button', { name: `Actions for ${channel.name}` }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(`Delete ${channel.name}?`);
    await user.click(screen.getByRole('button', { name: 'Delete channel' }));

    await waitFor(() => expect(screen.queryByText(channel.name)).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/webhook-endpoints/${channel.id}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('configures an ordered incident reminder schedule', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = requestPath(input);
      if (path.includes('incident-reminder-policy')) {
        if (init?.method === 'PUT')
          return Promise.resolve(json({ data: { delaysMinutes: [15, 60] } }));
        return Promise.resolve(json({ data: { delaysMinutes: [] } }));
      }
      return Promise.resolve(json({ data: [] }));
    });

    render(<NotificationChannelsPage projectId={projectId} />);
    await user.click(await screen.findByLabelText('Send reminders'));
    expect(screen.getByLabelText('Reminder 1 delay in minutes')).toHaveValue(15);
    await user.click(screen.getByRole('button', { name: 'Add reminder' }));
    expect(screen.getByLabelText('Reminder 2 delay in minutes')).toHaveValue(60);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/projects/${projectId}/incident-reminder-policy`,
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ delaysMinutes: [15, 60] }),
        }),
      ),
    );
  });

  it('loads every monitor page and preserves a selected monitor beyond the first 100', async () => {
    const monitors = Array.from({ length: 101 }, (_, index): NotificationMonitor => ({
      id: `monitor-${index + 1}`,
      name: `Monitor ${index + 1}`,
      type: 'HTTP',
      lifecycleState: 'ENABLED',
    }));
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        json({
          data: monitors.slice(0, 100),
          page: { number: 1, limit: 100, total: 101, totalPages: 2 },
        }),
      )
      .mockResolvedValueOnce(
        json({
          data: monitors.slice(100),
          page: { number: 2, limit: 100, total: 101, totalPages: 2 },
        }),
      );

    const loaded = await listNotificationMonitors(projectId);
    expect(loaded).toHaveLength(101);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/monitors?projectId=${projectId}&page=1&limit=100`,
      `/api/monitors?projectId=${projectId}&page=2&limit=100`,
    ]);

    render(
      <WebhookChannelForm
        formId="webhook-form"
        projectId={projectId}
        monitors={loaded}
        channel={{
          ...channel,
          routing: { ...channel.routing, monitorIds: [monitors[100]!.id] },
        }}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole('checkbox', { name: /Monitor 101/ })).toBeChecked();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });
});

function requestJson(call: readonly unknown[] | undefined): unknown {
  const init = call?.[1];
  const body = typeof init === 'object' && init !== null && 'body' in init ? init.body : undefined;
  if (typeof body !== 'string') throw new TypeError('Expected a JSON request body.');
  return JSON.parse(body) as unknown;
}

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
