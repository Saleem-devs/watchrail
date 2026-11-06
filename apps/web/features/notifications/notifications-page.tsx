'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../../components/app-shell';
import { actionClassName, Button } from '../../components/ui/button';
import { PageHeader } from '../../components/ui/page-header';
import {
  listEmailChannels,
  listEmailDeliveries,
  listNotificationMonitors,
  listWebhookChannels,
  listWebhookDeliveries,
  setWebhookChannelEnabled,
  setEmailChannelEnabled,
  sendEmailChannelTest,
} from './notification-api';
import type {
  NotificationDelivery,
  NotificationDeliveryStatus,
  NotificationChannel,
  NotificationMonitor,
} from './types';

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function NotificationsPage({ projectId }: { projectId: string }) {
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [monitors, setMonitors] = useState<NotificationMonitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyChannelIds, setBusyChannelIds] = useState<Set<string>>(() => new Set());
  const [historyChannel, setHistoryChannel] = useState<NotificationChannel | null>(null);
  const [deliveries, setDeliveries] = useState<NotificationDelivery[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextWebhooks, nextEmails, nextMonitors] = await Promise.all([
        listWebhookChannels(projectId),
        listEmailChannels(projectId),
        listNotificationMonitors(projectId),
      ]);
      setChannels([
        ...nextEmails,
        ...nextWebhooks.map((channel) => ({ ...channel, type: 'WEBHOOK' as const })),
      ]);
      setMonitors(nextMonitors);
      setLoadError(null);
    } catch (error) {
      setLoadError(messageFor(error, 'Could not load notification settings.'));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    // `load` only commits state after its requests settle; the callback identity also powers retry.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const routedMonitorCount = useMemo(
    () => new Set(channels.flatMap((channel) => channel.routing.monitorIds)).size,
    [channels],
  );

  async function toggleChannel(channel: NotificationChannel) {
    setBusyChannelIds((current) => new Set(current).add(channel.id));
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
    } finally {
      setBusyChannelIds((current) => {
        const next = new Set(current);
        next.delete(channel.id);
        return next;
      });
    }
  }

  async function showHistory(channel: NotificationChannel) {
    setHistoryChannel(channel);
    setDeliveries([]);
    setHistoryError(null);
    setHistoryLoading(true);
    try {
      setDeliveries(
        channel.type === 'EMAIL'
          ? await listEmailDeliveries(channel.id)
          : await listWebhookDeliveries(channel.id),
      );
    } catch (error) {
      setHistoryError(messageFor(error, 'Could not load delivery history.'));
    } finally {
      setHistoryLoading(false);
    }
  }

  async function testEmailChannel(channel: NotificationChannel) {
    if (channel.type !== 'EMAIL') return;
    setBusyChannelIds((current) => new Set(current).add(channel.id));
    try {
      await sendEmailChannelTest(channel.id);
      setNotice(`Test notification queued for ${channel.name}.`);
      if (historyChannel?.id === channel.id) await showHistory(channel);
    } catch (error) {
      setNotice(messageFor(error, `Could not test ${channel.name}.`));
    } finally {
      setBusyChannelIds((current) => {
        const next = new Set(current);
        next.delete(channel.id);
        return next;
      });
    }
  }

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
                <WebhookIcon />
                Add webhook
              </Link>
              <Link
                href={`/projects/${projectId}/notifications/email/new`}
                className={actionClassName({ variant: 'primary' })}
              >
                <MailIcon />
                Add email channel
              </Link>
            </div>
          }
        />

        {notice ? (
          <div
            className="mt-5 flex items-start justify-between gap-4 rounded-rail-control border border-rail-border bg-rail-raised px-4 py-3 text-sm text-rail-subtle"
            role="status"
          >
            <span>{notice}</span>
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent p-0 text-rail-muted hover:text-rail-text"
              onClick={() => setNotice(null)}
              aria-label="Dismiss message"
            >
              <CloseIcon />
            </button>
          </div>
        ) : null}

        <section className="mt-8" aria-labelledby="channels-title">
          <div className="flex flex-wrap items-end justify-between gap-4 pb-4">
            <div>
              <h2 id="channels-title" className="m-0 text-base font-semibold text-rail-text">
                Notification channels
              </h2>
              <p className="mt-1 mb-0 text-sm text-rail-muted">
                {channels.length} {channels.length === 1 ? 'channel' : 'channels'} ·{' '}
                {routedMonitorCount} {routedMonitorCount === 1 ? 'monitor' : 'monitors'} routed
              </p>
            </div>
          </div>

          <div
            id="webhooks"
            className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface"
          >
            {loading ? (
              <ChannelListLoading />
            ) : loadError ? (
              <ErrorState message={loadError} onRetry={() => void load()} />
            ) : channels.length === 0 ? (
              <div className="flex min-h-52 flex-col items-start justify-center px-5 py-10">
                <h3 className="m-0 text-sm font-semibold text-rail-text">
                  No notification channels yet
                </h3>
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
            ) : (
              <div className="divide-y divide-rail-border">
                <div className="hidden grid-cols-[minmax(13rem,1.4fr)_minmax(12rem,1.6fr)_8rem_10rem_15rem] gap-4 px-5 py-3 text-xs text-rail-muted lg:grid">
                  <span>Channel</span>
                  <span>Destination</span>
                  <span className="text-right">Monitors</span>
                  <span>Events</span>
                  <span>
                    <span className="sr-only">Actions</span>
                  </span>
                </div>
                {channels.map((channel) => (
                  <ChannelRow
                    key={channel.id}
                    channel={channel}
                    monitorCount={channel.routing.monitorIds.length}
                    busy={busyChannelIds.has(channel.id)}
                    editHref={
                      channel.type === 'EMAIL'
                        ? `/projects/${projectId}/notifications/email/${channel.id}/edit`
                        : `/projects/${projectId}/notifications/${channel.id}/edit`
                    }
                    onTest={
                      channel.type === 'EMAIL' ? () => void testEmailChannel(channel) : undefined
                    }
                    onHistory={() => void showHistory(channel)}
                    onToggle={() => void toggleChannel(channel)}
                  />
                ))}
              </div>
            )}
          </div>
        </section>

        {historyChannel ? (
          <DeliveryHistory
            channel={historyChannel}
            monitors={monitors}
            deliveries={deliveries}
            loading={historyLoading}
            error={historyError}
            onClose={() => setHistoryChannel(null)}
            onRetry={() => void showHistory(historyChannel)}
          />
        ) : null}
      </main>
    </AppShell>
  );
}

function ChannelRow({
  channel,
  monitorCount,
  busy,
  editHref,
  onHistory,
  onToggle,
  onTest,
}: {
  channel: NotificationChannel;
  monitorCount: number;
  busy: boolean;
  editHref: string;
  onHistory: () => void;
  onToggle: () => void;
  onTest?: (() => void) | undefined;
}) {
  let destination =
    channel.type === 'EMAIL'
      ? `${channel.recipientEmails.length} ${channel.recipientEmails.length === 1 ? 'recipient' : 'recipients'}`
      : channel.url;
  if (channel.type === 'WEBHOOK') {
    try {
      destination = new URL(channel.url).hostname;
    } catch {
      destination = channel.url.replace(/^https?:\/\//, '');
    }
  }
  const eventLabel = [
    channel.routing.notifyOnIncident ? 'Incidents' : null,
    channel.routing.notifyOnRecovery ? 'Recoveries' : null,
  ]
    .filter(Boolean)
    .join(' + ');
  return (
    <div className="grid gap-3 px-5 py-4 lg:grid-cols-[minmax(13rem,1.4fr)_minmax(12rem,1.6fr)_8rem_10rem_15rem] lg:items-center lg:gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-rail-text">{channel.name}</span>
          <span
            className={`shrink-0 rounded-[4px] border px-1.5 py-0.5 text-[11px] font-medium ${
              channel.enabled
                ? 'border-rail-success/35 bg-rail-success/10 text-rail-success'
                : 'border-rail-border bg-rail-raised text-rail-muted'
            }`}
          >
            {channel.enabled ? 'Active' : 'Paused'}
          </span>
        </div>
        <p className="mt-1 mb-0 text-xs text-rail-muted lg:hidden">
          {channel.type === 'EMAIL' ? 'Email channel' : 'Webhook channel'}
        </p>
      </div>
      <div className="min-w-0">
        <p className="m-0 truncate text-sm text-rail-subtle">{destination}</p>
        <p className="mt-1 mb-0 truncate text-xs text-rail-muted">
          {channel.type === 'EMAIL' ? 'Email' : 'Signed webhook'} · version {channel.versionNumber}
        </p>
      </div>
      <div className="text-sm text-rail-subtle lg:text-right">
        <span className="lg:hidden">Monitors: </span>
        <span className="tabular-nums">{monitorCount}</span>
      </div>
      <div className="text-sm text-rail-subtle">{eventLabel || 'No events'}</div>
      <div className="flex flex-wrap gap-2 lg:justify-end">
        {onTest ? (
          <Button size="compact" variant="quiet" onClick={onTest} disabled={busy}>
            Send test
          </Button>
        ) : null}
        <Button size="compact" variant="quiet" onClick={onHistory}>
          History
        </Button>
        <Link
          href={editHref}
          className={actionClassName({ variant: 'secondary', size: 'compact' })}
        >
          Edit
        </Link>
        <Button size="compact" variant="quiet" onClick={onToggle} disabled={busy}>
          {busy ? 'Updating…' : channel.enabled ? 'Pause' : 'Enable'}
        </Button>
      </div>
    </div>
  );
}

function DeliveryHistory({
  channel,
  monitors,
  deliveries,
  loading,
  error,
  onClose,
  onRetry,
}: {
  channel: NotificationChannel;
  monitors: NotificationMonitor[];
  deliveries: NotificationDelivery[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
}) {
  const monitorNames = new Map(monitors.map((monitor) => [monitor.id, monitor.name]));
  return (
    <section className="mt-8" aria-labelledby="delivery-history-title">
      <div className="flex items-end justify-between gap-4 pb-4">
        <div>
          <h2 id="delivery-history-title" className="m-0 text-base font-semibold text-rail-text">
            Delivery history
          </h2>
          <p className="mt-1 mb-0 text-sm text-rail-muted">{channel.name} · latest 25 attempts</p>
        </div>
        <Button size="compact" variant="quiet" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface">
        {loading ? (
          <div
            className="grid min-h-36 place-items-center px-5 py-10 text-sm text-rail-muted"
            role="status"
          >
            Loading delivery history…
          </div>
        ) : error ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : deliveries.length === 0 ? (
          <div className="px-5 py-10">
            <h3 className="m-0 text-sm font-semibold text-rail-text">No deliveries yet</h3>
            <p className="mt-1.5 mb-0 text-sm text-rail-muted">
              Attempts will appear after a routed monitor opens or resolves an incident.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-rail-border">
            <div className="hidden grid-cols-[minmax(13rem,1.5fr)_10rem_9rem_8rem_11rem] gap-4 px-5 py-3 text-xs text-rail-muted lg:grid">
              <span>Event</span>
              <span>Monitor</span>
              <span>Status</span>
              <span className="text-right">Attempts</span>
              <span className="text-right">Occurred</span>
            </div>
            {deliveries.map((delivery) => (
              <div
                key={delivery.id}
                className="grid gap-2 px-5 py-4 text-sm lg:grid-cols-[minmax(13rem,1.5fr)_10rem_9rem_8rem_11rem] lg:items-center lg:gap-4"
              >
                <div>
                  <span className="font-medium text-rail-text">
                    {delivery.event.type === 'INCIDENT_OPENED'
                      ? 'Incident opened'
                      : delivery.event.type === 'INCIDENT_RESOLVED'
                        ? 'Incident resolved'
                        : 'Test notification'}
                  </span>
                  {delivery.lastErrorCode ? (
                    <span className="mt-1 block text-xs text-rail-muted">
                      {delivery.lastErrorCode}
                      {delivery.lastHttpStatus ? ` · HTTP ${delivery.lastHttpStatus}` : ''}
                    </span>
                  ) : null}
                </div>
                <span className="truncate text-rail-subtle">
                  {delivery.event.monitorId
                    ? (monitorNames.get(delivery.event.monitorId) ?? 'Monitor unavailable')
                    : 'Channel test'}
                </span>
                <DeliveryStatus status={delivery.status} />
                <span className="tabular-nums text-rail-subtle lg:text-right">
                  <span className="lg:hidden">Attempts: </span>
                  {delivery.attemptCount}
                </span>
                <time
                  className="text-rail-muted lg:text-right"
                  dateTime={delivery.event.occurredAt}
                >
                  {dateFormatter.format(new Date(delivery.event.occurredAt))}
                </time>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function DeliveryStatus({ status }: { status: NotificationDeliveryStatus }) {
  const label: Record<NotificationDeliveryStatus, string> = {
    PENDING: 'Pending',
    IN_FLIGHT: 'Sending',
    RETRY_SCHEDULED: 'Retrying',
    DELIVERED: 'Delivered',
    SUPPRESSED: 'Suppressed',
    DEAD: 'Failed',
  };
  const tone =
    status === 'DELIVERED'
      ? 'border-rail-success/35 bg-rail-success/10 text-rail-success'
      : status === 'DEAD'
        ? 'border-rail-danger/40 bg-rail-danger/10 text-rail-danger'
        : status === 'SUPPRESSED'
          ? 'border-rail-border-strong bg-rail-raised text-rail-subtle'
          : 'border-rail-warning/35 bg-rail-warning/10 text-rail-warning';
  return (
    <span
      className={`w-fit whitespace-nowrap rounded-[4px] border px-1.5 py-0.5 text-xs font-medium ${tone}`}
    >
      {label[status]}
    </span>
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
        <div
          key={item}
          className="grid gap-3 px-5 py-5 lg:grid-cols-[minmax(13rem,1.4fr)_minmax(12rem,1.6fr)_8rem_10rem_15rem]"
        >
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
