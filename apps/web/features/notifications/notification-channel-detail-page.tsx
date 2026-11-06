'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../components/app-shell';
import { actionClassName, Button } from '../../components/ui/button';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog';
import { PageHeader } from '../../components/ui/page-header';
import {
  deleteEmailChannel,
  deleteWebhookChannel,
  findEmailChannel,
  findWebhookChannel,
  listEmailDeliveries,
  listNotificationMonitors,
  listWebhookDeliveries,
  sendEmailChannelTest,
  setEmailChannelEnabled,
  setWebhookChannelEnabled,
} from './notification-api';
import { NotificationDeliveryHistory } from './notification-delivery-history';
import type { NotificationChannel, NotificationDelivery, NotificationMonitor } from './types';

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function NotificationChannelDetailPage({
  projectId,
  channelId,
  channelType,
}: {
  projectId: string;
  channelId: string;
  channelType: 'EMAIL' | 'WEBHOOK';
}) {
  const router = useRouter();
  const [channel, setChannel] = useState<NotificationChannel | null>(null);
  const [monitors, setMonitors] = useState<NotificationMonitor[]>([]);
  const [deliveries, setDeliveries] = useState<NotificationDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      setDeliveries(
        channelType === 'EMAIL'
          ? await listEmailDeliveries(channelId)
          : await listWebhookDeliveries(channelId),
      );
    } catch (loadError) {
      setHistoryError(messageFor(loadError, 'Could not load delivery history.'));
    } finally {
      setHistoryLoading(false);
    }
  }, [channelId, channelType]);

  const load = useCallback(async () => {
    try {
      const [loadedChannel, loadedMonitors] = await Promise.all([
        channelType === 'EMAIL'
          ? findEmailChannel(channelId)
          : findWebhookChannel(channelId).then((value) => ({ ...value, type: 'WEBHOOK' as const })),
        listNotificationMonitors(projectId),
      ]);
      if (loadedChannel.projectId !== projectId) throw new Error('Notification channel not found.');
      setChannel(loadedChannel);
      setMonitors(loadedMonitors);
      setError(null);
      await loadHistory();
    } catch (loadError) {
      setError(messageFor(loadError, 'Could not load this notification channel.'));
      setHistoryLoading(false);
    } finally {
      setLoading(false);
    }
  }, [channelId, channelType, loadHistory, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleEnabled() {
    if (!channel) return;
    setBusy(true);
    try {
      const updated =
        channel.type === 'EMAIL'
          ? await setEmailChannelEnabled(channel.id, !channel.enabled)
          : {
              ...(await setWebhookChannelEnabled(channel.id, !channel.enabled)),
              type: 'WEBHOOK' as const,
            };
      setChannel(updated);
      setNotice(`${updated.name} ${updated.enabled ? 'enabled' : 'paused'}.`);
    } catch (updateError) {
      setNotice(messageFor(updateError, 'Could not update this channel.'));
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    if (!channel || channel.type !== 'EMAIL') return;
    setBusy(true);
    try {
      await sendEmailChannelTest(channel.id);
      setNotice(`Test notification queued for ${channel.name}.`);
      await loadHistory();
    } catch (testError) {
      setNotice(messageFor(testError, 'Could not send a test notification.'));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!channel) return;
    setBusy(true);
    try {
      if (channel.type === 'EMAIL') await deleteEmailChannel(channel.id);
      else await deleteWebhookChannel(channel.id);
      router.replace(`/projects/${projectId}/notifications`);
    } catch (deleteError) {
      setNotice(messageFor(deleteError, 'Could not delete this channel.'));
      setConfirmDelete(false);
      setBusy(false);
    }
  }

  const editHref = channel
    ? channel.type === 'EMAIL'
      ? `/projects/${projectId}/notifications/email/${channel.id}/edit`
      : `/projects/${projectId}/notifications/${channel.id}/edit`
    : '#';

  return (
    <AppShell page="notifications" projectId={projectId}>
      <main id="main-content" data-watchrail-workspace className="w-full min-w-0 pb-16">
        <PageHeader
          title={channel?.name ?? 'Notification channel'}
          description={
            channel
              ? `${channel.type === 'EMAIL' ? 'Email' : 'Webhook'} notification channel`
              : 'Loading channel details…'
          }
          backLink={{
            href: `/projects/${projectId}/notifications`,
            label: 'Back to notifications',
          }}
          actions={
            channel ? (
              <>
                {channel.type === 'EMAIL' ? (
                  <Button variant="secondary" onClick={() => void sendTest()} disabled={busy}>
                    Send test
                  </Button>
                ) : null}
                <Link href={editHref} className={actionClassName({ variant: 'primary' })}>
                  Edit channel
                </Link>
                <Button variant="quiet" onClick={() => void toggleEnabled()} disabled={busy}>
                  {busy ? 'Updating…' : channel.enabled ? 'Pause channel' : 'Enable channel'}
                </Button>
              </>
            ) : null
          }
        />

        {notice ? (
          <div
            className="mt-5 rounded-rail-control border border-rail-border bg-rail-raised px-4 py-3 text-sm text-rail-subtle"
            role="status"
          >
            {notice}
          </div>
        ) : null}

        {loading ? (
          <div
            className="mt-8 grid min-h-56 place-items-center rounded-rail-panel border border-rail-border bg-rail-surface text-sm text-rail-muted"
            role="status"
          >
            Loading notification channel…
          </div>
        ) : error || !channel ? (
          <div
            className="mt-8 flex min-h-56 flex-col items-start justify-center gap-3 rounded-rail-panel border border-rail-border bg-rail-surface px-5 py-10"
            role="alert"
          >
            <p className="m-0 text-sm text-rail-subtle">
              {error ?? 'Notification channel not found.'}
            </p>
            <Button size="compact" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            <ChannelOverview channel={channel} monitors={monitors} />
            <NotificationDeliveryHistory
              monitors={monitors}
              deliveries={deliveries}
              loading={historyLoading}
              error={historyError}
              onRetry={() => void loadHistory()}
            />
            <section
              className="mt-10 border-t border-rail-border pt-6"
              aria-labelledby="delete-channel-title"
            >
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2
                    id="delete-channel-title"
                    className="m-0 text-sm font-semibold text-rail-text"
                  >
                    Delete channel
                  </h2>
                  <p className="mt-1 mb-0 text-sm text-rail-muted">
                    Stop future deliveries and remove this channel from the project.
                  </p>
                </div>
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  Delete channel
                </Button>
              </div>
            </section>
          </>
        )}

        <ConfirmationDialog
          open={confirmDelete}
          title={channel ? `Delete ${channel.name}?` : 'Delete notification channel?'}
          description="This stops future and retrying deliveries. Existing delivery evidence remains retained, but an in-flight delivery may already have reached its destination."
          confirmLabel={busy ? 'Deleting…' : 'Delete channel'}
          onCancel={() => {
            if (!busy) setConfirmDelete(false);
          }}
          onConfirm={() => void remove()}
        />
      </main>
    </AppShell>
  );
}

function ChannelOverview({
  channel,
  monitors,
}: {
  channel: NotificationChannel;
  monitors: NotificationMonitor[];
}) {
  const monitorNames = new Map(monitors.map((monitor) => [monitor.id, monitor.name]));
  const routed = channel.routing.monitorIds.map(
    (id) => monitorNames.get(id) ?? 'Monitor unavailable',
  );
  return (
    <section
      className="mt-8 overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface"
      aria-labelledby="channel-overview-title"
    >
      <div className="border-b border-rail-border px-5 py-4">
        <h2 id="channel-overview-title" className="m-0 text-sm font-semibold text-rail-text">
          Channel overview
        </h2>
        <p className="mt-1 mb-0 text-xs text-rail-muted">
          Current destination, routing, and lifecycle state.
        </p>
      </div>
      <dl className="m-0 grid sm:grid-cols-2 lg:grid-cols-4">
        <Definition label="Status" value={channel.enabled ? 'Active' : 'Paused'} />
        <Definition label="Type" value={channel.type === 'EMAIL' ? 'Email' : 'Signed webhook'} />
        <Definition label="Version" value={String(channel.versionNumber)} />
        <Definition label="Updated" value={dateFormatter.format(new Date(channel.updatedAt))} />
      </dl>
      <div className="grid border-t border-rail-border lg:grid-cols-2">
        <div className="border-b border-rail-border px-5 py-5 lg:border-r lg:border-b-0">
          <h3 className="m-0 text-xs font-medium text-rail-muted">Destination</h3>
          {channel.type === 'EMAIL' ? (
            <ul className="mt-3 mb-0 space-y-2 p-0 text-sm text-rail-text">
              {channel.recipientEmails.map((email) => (
                <li key={email} className="list-none break-all">
                  {email}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 mb-0 break-all font-mono text-xs text-rail-text">{channel.url}</p>
          )}
        </div>
        <div className="px-5 py-5">
          <h3 className="m-0 text-xs font-medium text-rail-muted">Monitor routing</h3>
          <p className="mt-3 mb-0 text-sm text-rail-text">
            {routed.length ? routed.join(', ') : 'No monitors selected'}
          </p>
          <p className="mt-2 mb-0 text-xs text-rail-muted">
            {[
              channel.routing.notifyOnIncident ? 'Incident opened' : null,
              channel.routing.notifyOnRecovery ? 'Incident resolved' : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
      </div>
    </section>
  );
}

function Definition({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-rail-border px-5 py-4 last:border-b-0 sm:border-r sm:[&:nth-child(2n)]:border-r-0 lg:border-b-0 lg:[&:nth-child(2n)]:border-r lg:last:border-r-0">
      <dt className="text-xs text-rail-muted">{label}</dt>
      <dd className="mt-1.5 mb-0 text-sm font-medium text-rail-text">{value}</dd>
    </div>
  );
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
