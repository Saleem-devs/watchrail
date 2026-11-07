'use client';

import Link from 'next/link';
import { Mail, Webhook, X } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AppShell } from '../../components/app-shell';
import { actionClassName, Button } from '../../components/ui/button';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog';
import {
  DataTable,
  type DataTableAction,
  type DataTableColumn,
} from '../../components/ui/data-table';
import { PageHeader } from '../../components/ui/page-header';
import {
  deleteEmailChannel,
  deleteSlackChannel,
  deleteWebhookChannel,
  listEmailChannels,
  listSlackChannels,
  listWebhookChannels,
  sendEmailChannelTest,
  sendSlackChannelTest,
  setEmailChannelEnabled,
  setSlackChannelEnabled,
  setWebhookChannelEnabled,
} from './notification-api';
import type { NotificationChannel } from './types';
import { IncidentReminderPolicySection } from './incident-reminder-policy';

export function NotificationChannelsPage({ projectId }: { projectId: string }) {
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<NotificationChannel | null>(null);

  const load = useCallback(async () => {
    try {
      const [webhooks, emails, slack] = await Promise.all([
        listWebhookChannels(projectId),
        listEmailChannels(projectId),
        listSlackChannels(projectId),
      ]);
      setChannels([
        ...emails,
        ...slack,
        ...webhooks.map((channel) => ({ ...channel, type: 'WEBHOOK' as const })),
      ]);
      setLoadError(null);
    } catch (error) {
      setLoadError(messageFor(error, 'Could not load notification settings.'));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);

  async function toggleChannel(channel: NotificationChannel) {
    try {
      const updated = await setChannelEnabled(channel, !channel.enabled);
      setChannels((current) =>
        current.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
      );
      setNotice(`${channel.name} ${updated.enabled ? 'enabled' : 'paused'}.`);
    } catch (error) {
      setNotice(messageFor(error, `Could not update ${channel.name}.`));
    }
  }

  async function testChannel(channel: NotificationChannel) {
    if (channel.type === 'WEBHOOK') return;
    try {
      if (channel.type === 'EMAIL') await sendEmailChannelTest(channel.id);
      else await sendSlackChannelTest(channel.id);
      setNotice(`Test notification queued for ${channel.name}.`);
    } catch (error) {
      setNotice(messageFor(error, `Could not test ${channel.name}.`));
    }
  }

  async function deleteChannel() {
    const channel = deleteTarget;
    if (!channel) return;
    try {
      if (channel.type === 'EMAIL') await deleteEmailChannel(channel.id);
      else if (channel.type === 'SLACK') await deleteSlackChannel(channel.id);
      else await deleteWebhookChannel(channel.id);
      setChannels((current) => current.filter((candidate) => candidate.id !== channel.id));
      setNotice(`${channel.name} deleted.`);
    } catch (error) {
      setNotice(messageFor(error, `Could not delete ${channel.name}.`));
    } finally {
      setDeleteTarget(null);
    }
  }

  const columns: Array<DataTableColumn<NotificationChannel>> = [
    {
      id: 'channel',
      header: 'Channel',
      cell: (channel) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold text-rail-text">{channel.name}</span>
            <StatusBadge enabled={channel.enabled} />
          </div>
          <span className="mt-1 block text-xs text-rail-muted">
            {channel.type === 'EMAIL'
              ? 'Email channel'
              : channel.type === 'SLACK'
                ? 'Slack channel'
                : 'Webhook channel'}
          </span>
        </div>
      ),
    },
    {
      id: 'destination',
      header: 'Destination',
      cell: (channel) => (
        <div className="min-w-0">
          <span className="block truncate text-rail-subtle">{destinationFor(channel)}</span>
          <span className="mt-1 block text-xs text-rail-muted">
            Version {channel.versionNumber}
          </span>
        </div>
      ),
    },
    {
      id: 'monitors',
      header: 'Monitors',
      headerClassName: 'text-right',
      className: 'text-right tabular-nums text-rail-subtle',
      cell: (channel) =>
        channel.routing.allMonitors ? 'Entire project' : channel.routing.monitorIds.length,
    },
    {
      id: 'events',
      header: 'Events',
      className: 'text-rail-subtle',
      cell: eventLabel,
    },
  ];

  const actions: Array<DataTableAction<NotificationChannel>> = [
    { id: 'view', label: 'View', href: (channel) => detailHref(projectId, channel) },
    {
      id: 'test',
      label: 'Send test',
      pendingLabel: 'Sending…',
      visible: (channel) => channel.type !== 'WEBHOOK',
      onSelect: testChannel,
    },
    { id: 'edit', label: 'Edit', href: (channel) => editHref(projectId, channel) },
    {
      id: 'pause',
      label: 'Pause',
      pendingLabel: 'Pausing…',
      visible: (channel) => channel.enabled,
      onSelect: toggleChannel,
    },
    {
      id: 'enable',
      label: 'Enable',
      pendingLabel: 'Enabling…',
      visible: (channel) => !channel.enabled,
      onSelect: toggleChannel,
    },
    {
      id: 'delete',
      label: 'Delete',
      tone: 'danger',
      onSelect: (channel) => setDeleteTarget(channel),
    },
  ];

  return (
    <AppShell page="notifications" projectId={projectId}>
      <main id="main-content" data-watchrail-workspace className="w-full min-w-0 pb-16">
        <PageHeader
          title="Notifications"
          description="Route confirmed incidents and recoveries to the people and systems responsible for this project."
        />

        {notice ? <Notice message={notice} onDismiss={() => setNotice(null)} /> : null}

        <IncidentReminderPolicySection projectId={projectId} />

        <ChannelProviders projectId={projectId} channels={channels} loading={loading} />

        <section className="mt-8" aria-labelledby="channels-title">
          <div className="pb-4">
            <h2 id="channels-title" className="m-0 text-base font-semibold text-rail-text">
              Notification channels
            </h2>
            <p className="mt-1 mb-0 text-sm text-rail-muted">
              {channels.length} {channels.length === 1 ? 'channel' : 'channels'} configured
            </p>
          </div>
          <div className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface">
            {loading ? (
              <ChannelListLoading />
            ) : loadError ? (
              <ErrorState message={loadError} onRetry={() => void load()} />
            ) : channels.length === 0 ? (
              <EmptyState />
            ) : (
              <DataTable
                rows={channels}
                columns={columns}
                actions={actions}
                getRowKey={(channel) => channel.id}
                getRowHref={(channel) => detailHref(projectId, channel)}
                getRowLabel={(channel) => channel.name}
                ariaLabel="Notification channels"
                minWidthClassName="min-w-[760px]"
              />
            )}
          </div>
        </section>

        <ConfirmationDialog
          open={Boolean(deleteTarget)}
          title={deleteTarget ? `Delete ${deleteTarget.name}?` : 'Delete notification channel?'}
          description="This stops future and retrying deliveries and removes the channel from this project. Existing delivery evidence remains retained. An in-flight delivery may already have reached its destination."
          confirmLabel="Delete channel"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void deleteChannel()}
        />
      </main>
    </AppShell>
  );
}

export function detailHref(projectId: string, channel: NotificationChannel): string {
  if (channel.type === 'EMAIL') return `/projects/${projectId}/notifications/email/${channel.id}`;
  if (channel.type === 'SLACK') return `/projects/${projectId}/notifications/slack/${channel.id}`;
  return `/projects/${projectId}/notifications/${channel.id}`;
}

function editHref(projectId: string, channel: NotificationChannel): string {
  return `${detailHref(projectId, channel)}/edit`;
}

function destinationFor(channel: NotificationChannel): string {
  if (channel.type === 'EMAIL')
    return `${channel.recipientEmails.length} ${channel.recipientEmails.length === 1 ? 'recipient' : 'recipients'}`;
  if (channel.type === 'SLACK') return 'Incoming webhook retained';
  try {
    return new URL(channel.url).hostname;
  } catch {
    return channel.url.replace(/^https?:\/\//, '');
  }
}

function eventLabel(channel: NotificationChannel): string {
  return (
    [
      channel.routing.notifyOnIncident ? 'Incidents' : null,
      channel.routing.notifyOnRecovery ? 'Recoveries' : null,
    ]
      .filter(Boolean)
      .join(' + ') || 'No events'
  );
}

function StatusBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`shrink-0 rounded-[4px] border px-1.5 py-0.5 text-[11px] font-medium ${
        enabled
          ? 'border-rail-success/35 bg-rail-success/10 text-rail-success'
          : 'border-rail-border bg-rail-raised text-rail-muted'
      }`}
    >
      {enabled ? 'Active' : 'Paused'}
    </span>
  );
}

function Notice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      className="mt-5 flex items-start justify-between gap-4 rounded-rail-control border border-rail-border bg-rail-raised px-4 py-3 text-sm text-rail-subtle"
      role="status"
    >
      <span>{message}</span>
      <button
        type="button"
        className="cursor-pointer border-0 bg-transparent p-0 text-rail-muted hover:text-rail-text"
        onClick={onDismiss}
        aria-label="Dismiss message"
      >
        <X className="size-4" strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}

function ChannelProviders({
  projectId,
  channels,
  loading,
}: {
  projectId: string;
  channels: NotificationChannel[];
  loading: boolean;
}) {
  const providers: Array<{
    type: NotificationChannel['type'];
    name: string;
    href: string;
    icon: ReactNode;
  }> = [
    {
      type: 'EMAIL',
      name: 'Email',
      href: `/projects/${projectId}/notifications/email/new`,
      icon: <Mail className="size-5" strokeWidth={1.75} aria-hidden="true" />,
    },
    {
      type: 'SLACK',
      name: 'Slack',
      href: `/projects/${projectId}/notifications/slack/new`,
      icon: <SlackIcon />,
    },
    {
      type: 'WEBHOOK',
      name: 'Webhook',
      href: `/projects/${projectId}/notifications/new`,
      icon: <Webhook className="size-5" strokeWidth={1.75} aria-hidden="true" />,
    },
  ];

  return (
    <section className="mt-8" aria-labelledby="providers-title">
      <div className="pb-4">
        <h2 id="providers-title" className="m-0 text-base font-semibold text-rail-text">
          Connect a channel
        </h2>
        <p className="mt-1 mb-0 text-sm text-rail-muted">
          Choose where Watchrail should send confirmed incidents and recoveries.
        </p>
      </div>
      <div className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface">
        {providers.map((provider) => {
          const count = channels.filter((channel) => channel.type === provider.type).length;
          const connected = count > 0;
          return (
            <div
              key={provider.type}
              className="flex min-h-20 items-center justify-between gap-4 border-b border-rail-border px-5 py-4 last:border-b-0"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-rail-control border border-rail-border bg-rail-raised text-rail-subtle">
                  {provider.icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-rail-text">{provider.name}</span>
                  <span className="mt-0.5 block text-xs text-rail-muted">
                    {loading
                      ? 'Checking connection…'
                      : connected
                        ? `${count} ${count === 1 ? 'channel' : 'channels'} connected`
                        : 'Not connected'}
                  </span>
                </span>
              </div>
              <Link
                href={provider.href}
                aria-label={
                  connected ? `Add another ${provider.name} channel` : `Connect ${provider.name}`
                }
                className={actionClassName({ variant: 'secondary', size: 'compact' })}
              >
                {connected ? 'Add another' : `Connect ${provider.name}`}
              </Link>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function EmptyState() {
  return (
    <div className="flex min-h-52 flex-col items-start justify-center px-5 py-10">
      <h3 className="m-0 text-sm font-semibold text-rail-text">No notification channels yet</h3>
      <p className="mt-1.5 mb-0 max-w-xl text-sm leading-6 text-rail-muted">
        Connect a provider above, then choose which monitors and incident transitions it receives.
      </p>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-40 flex-col items-start justify-center gap-3 px-5 py-8" role="alert">
      <p className="m-0 text-sm text-rail-subtle">{message}</p>
      <Button size="compact" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function ChannelListLoading() {
  return (
    <div
      className="divide-y divide-rail-border"
      role="status"
      aria-label="Loading notification channels"
    >
      {[0, 1].map((item) => (
        <div key={item} className="grid grid-cols-[1.4fr_1.6fr_8rem_10rem_3rem] gap-4 px-4 py-5">
          {[42, 56, 24, 36, 64].map((width, index) => (
            <span
              key={index}
              className="h-3 rounded bg-rail-raised"
              style={{ width: `${width}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function SlackIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-5" aria-hidden="true">
      <path
        d="M5.2 1.5a1.45 1.45 0 1 1 0 2.9H3.75a1.45 1.45 0 0 1 0-2.9H5.2Z"
        fill="currentColor"
      />
      <path d="M5.2 5.2H1.45a1.45 1.45 0 1 0 0 2.9H5.2V5.2Z" fill="currentColor" />
      <path
        d="M14.55 5.2a1.45 1.45 0 1 1-2.9 0V3.75a1.45 1.45 0 0 1 2.9 0V5.2Z"
        fill="currentColor"
      />
      <path d="M10.8 5.2V1.45a1.45 1.45 0 1 0-2.9 0V5.2h2.9Z" fill="currentColor" />
      <path
        d="M10.8 14.55a1.45 1.45 0 1 1 0-2.9h1.45a1.45 1.45 0 0 1 0 2.9H10.8Z"
        fill="currentColor"
      />
      <path d="M10.8 10.8h3.75a1.45 1.45 0 1 0 0-2.9H10.8v2.9Z" fill="currentColor" />
      <path
        d="M1.45 10.8a1.45 1.45 0 1 1 2.9 0v1.45a1.45 1.45 0 0 1-2.9 0V10.8Z"
        fill="currentColor"
      />
      <path d="M5.2 10.8v3.75a1.45 1.45 0 1 0 2.9 0V10.8H5.2Z" fill="currentColor" />
    </svg>
  );
}

async function setChannelEnabled(channel: NotificationChannel, enabled: boolean) {
  if (channel.type === 'EMAIL') return setEmailChannelEnabled(channel.id, enabled);
  if (channel.type === 'SLACK') return setSlackChannelEnabled(channel.id, enabled);
  return {
    ...(await setWebhookChannelEnabled(channel.id, enabled)),
    type: 'WEBHOOK' as const,
  };
}
