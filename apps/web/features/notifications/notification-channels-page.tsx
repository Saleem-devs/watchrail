'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
  deleteWebhookChannel,
  listEmailChannels,
  listWebhookChannels,
  sendEmailChannelTest,
  setEmailChannelEnabled,
  setWebhookChannelEnabled,
} from './notification-api';
import type { NotificationChannel } from './types';

export function NotificationChannelsPage({ projectId }: { projectId: string }) {
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<NotificationChannel | null>(null);

  const load = useCallback(async () => {
    try {
      const [webhooks, emails] = await Promise.all([
        listWebhookChannels(projectId),
        listEmailChannels(projectId),
      ]);
      setChannels([
        ...emails,
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
    void load();
  }, [load]);

  const routedMonitorCount = useMemo(
    () => new Set(channels.flatMap((channel) => channel.routing.monitorIds)).size,
    [channels],
  );

  async function toggleChannel(channel: NotificationChannel) {
    try {
      const updated =
        channel.type === 'EMAIL'
          ? await setEmailChannelEnabled(channel.id, !channel.enabled)
          : {
              ...(await setWebhookChannelEnabled(channel.id, !channel.enabled)),
              type: 'WEBHOOK' as const,
            };
      setChannels((current) =>
        current.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
      );
      setNotice(`${channel.name} ${updated.enabled ? 'enabled' : 'paused'}.`);
    } catch (error) {
      setNotice(messageFor(error, `Could not update ${channel.name}.`));
    }
  }

  async function testEmailChannel(channel: NotificationChannel) {
    if (channel.type !== 'EMAIL') return;
    try {
      await sendEmailChannelTest(channel.id);
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
            {channel.type === 'EMAIL' ? 'Email channel' : 'Webhook channel'}
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
      cell: (channel) => channel.routing.monitorIds.length,
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
      visible: (channel) => channel.type === 'EMAIL',
      onSelect: testEmailChannel,
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
          actions={
            <div className="flex flex-wrap gap-2">
              <Link
                href={`/projects/${projectId}/notifications/new`}
                className={actionClassName({ variant: 'secondary' })}
              >
                <WebhookIcon /> Add webhook
              </Link>
              <Link
                href={`/projects/${projectId}/notifications/email/new`}
                className={actionClassName({ variant: 'primary' })}
              >
                <MailIcon /> Add email channel
              </Link>
            </div>
          }
        />

        {notice ? <Notice message={notice} onDismiss={() => setNotice(null)} /> : null}

        <section className="mt-8" aria-labelledby="channels-title">
          <div className="pb-4">
            <h2 id="channels-title" className="m-0 text-base font-semibold text-rail-text">
              Notification channels
            </h2>
            <p className="mt-1 mb-0 text-sm text-rail-muted">
              {channels.length} {channels.length === 1 ? 'channel' : 'channels'} ·{' '}
              {routedMonitorCount} {routedMonitorCount === 1 ? 'monitor' : 'monitors'} routed
            </p>
          </div>
          <div className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface">
            {loading ? (
              <ChannelListLoading />
            ) : loadError ? (
              <ErrorState message={loadError} onRetry={() => void load()} />
            ) : channels.length === 0 ? (
              <EmptyState projectId={projectId} />
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
  return channel.type === 'EMAIL'
    ? `/projects/${projectId}/notifications/email/${channel.id}`
    : `/projects/${projectId}/notifications/${channel.id}`;
}

function editHref(projectId: string, channel: NotificationChannel): string {
  return `${detailHref(projectId, channel)}/edit`;
}

function destinationFor(channel: NotificationChannel): string {
  if (channel.type === 'EMAIL')
    return `${channel.recipientEmails.length} ${channel.recipientEmails.length === 1 ? 'recipient' : 'recipients'}`;
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
        <CloseIcon />
      </button>
    </div>
  );
}

function EmptyState({ projectId }: { projectId: string }) {
  return (
    <div className="flex min-h-52 flex-col items-start justify-center px-5 py-10">
      <h3 className="m-0 text-sm font-semibold text-rail-text">No notification channels yet</h3>
      <p className="mt-1.5 mb-4 max-w-xl text-sm leading-6 text-rail-muted">
        Add email recipients or a signed webhook, then choose which monitors and incident
        transitions each channel receives.
      </p>
      <Link
        href={`/projects/${projectId}/notifications/email/new`}
        className={actionClassName({ variant: 'secondary', size: 'compact' })}
      >
        Add the first channel
      </Link>
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

function MailIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className="size-4"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M2.5 4.25h11v7.5h-11z" strokeLinejoin="round" />
      <path d="m3 5 5 3.75L13 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WebhookIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className="size-4"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M5.2 5.3A3 3 0 1 1 8 9.5H4.5" strokeLinecap="round" />
      <path d="M10.8 10.7A3 3 0 1 1 8 6.5h3.5" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className="size-4"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="m4 4 8 8m0-8-8 8" strokeLinecap="round" />
    </svg>
  );
}
