'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../../components/app-shell';
import { actionClassName, Button } from '../../components/ui/button';
import { PageHeader } from '../../components/ui/page-header';
import {
  listNotificationMonitors,
  listWebhookChannels,
  listWebhookDeliveries,
  setWebhookChannelEnabled,
} from './notification-api';
import type {
  NotificationDelivery,
  NotificationDeliveryStatus,
  NotificationMonitor,
  WebhookChannel,
} from './types';

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function NotificationsPage({ projectId }: { projectId: string }) {
  const [channels, setChannels] = useState<WebhookChannel[]>([]);
  const [monitors, setMonitors] = useState<NotificationMonitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyChannelIds, setBusyChannelIds] = useState<Set<string>>(() => new Set());
  const [historyChannel, setHistoryChannel] = useState<WebhookChannel | null>(null);
  const [deliveries, setDeliveries] = useState<NotificationDelivery[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextChannels, nextMonitors] = await Promise.all([
        listWebhookChannels(projectId),
        listNotificationMonitors(projectId),
      ]);
      setChannels(nextChannels);
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

  async function toggleChannel(channel: WebhookChannel) {
    setBusyChannelIds((current) => new Set(current).add(channel.id));
    try {
      const updated = await setWebhookChannelEnabled(channel.id, !channel.enabled);
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

  async function showHistory(channel: WebhookChannel) {
    setHistoryChannel(channel);
    setDeliveries([]);
    setHistoryError(null);
    setHistoryLoading(true);
    try {
      setDeliveries(await listWebhookDeliveries(channel.id));
    } catch (error) {
      setHistoryError(messageFor(error, 'Could not load delivery history.'));
    } finally {
      setHistoryLoading(false);
    }
  }

  return (
    <AppShell page="notifications" projectId={projectId}>
      <main id="main-content" data-watchrail-workspace className="w-full min-w-0 pb-16">
        <PageHeader
          title="Notifications"
          description="Route confirmed incidents and recoveries to the people and systems responsible for this project."
          actions={
            <Link
              href={`/projects/${projectId}/notifications/new`}
              className={actionClassName({ variant: 'primary' })}
            >
              <PlusIcon />
              Add webhook
            </Link>
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
                Webhook channels
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
                  Add a signed webhook, choose the monitors it covers, and decide whether recovery
                  events should be delivered too.
                </p>
                <Link
                  href={`/projects/${projectId}/notifications/new`}
                  className={actionClassName({ variant: 'secondary', size: 'compact' })}
                >
                  Add the first webhook
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
                    editHref={`/projects/${projectId}/notifications/${channel.id}/edit`}
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
}: {
  channel: WebhookChannel;
  monitorCount: number;
  busy: boolean;
  editHref: string;
  onHistory: () => void;
  onToggle: () => void;
}) {
  let hostname = channel.url;
  try {
    hostname = new URL(channel.url).hostname;
  } catch {
    hostname = channel.url.replace(/^https?:\/\//, '');
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
        <p className="mt-1 mb-0 text-xs text-rail-muted lg:hidden">Webhook channel</p>
      </div>
      <div className="min-w-0">
        <p className="m-0 truncate text-sm text-rail-subtle">{hostname}</p>
        <p className="mt-1 mb-0 truncate text-xs text-rail-muted">
          Signed · version {channel.versionNumber}
        </p>
      </div>
      <div className="text-sm text-rail-subtle lg:text-right">
        <span className="lg:hidden">Monitors: </span>
        <span className="tabular-nums">{monitorCount}</span>
      </div>
      <div className="text-sm text-rail-subtle">{eventLabel || 'No events'}</div>
      <div className="flex flex-wrap gap-2 lg:justify-end">
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
  channel: WebhookChannel;
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
                      : 'Incident resolved'}
                  </span>
                  {delivery.lastErrorCode ? (
                    <span className="mt-1 block text-xs text-rail-muted">
                      {delivery.lastErrorCode}
                      {delivery.lastHttpStatus ? ` · HTTP ${delivery.lastHttpStatus}` : ''}
                    </span>
                  ) : null}
                </div>
                <span className="truncate text-rail-subtle">
                  {monitorNames.get(delivery.event.monitorId) ?? 'Monitor unavailable'}
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
    DEAD: 'Failed',
  };
  const tone =
    status === 'DELIVERED'
      ? 'border-rail-success/35 bg-rail-success/10 text-rail-success'
      : status === 'DEAD'
        ? 'border-rail-danger/40 bg-rail-danger/10 text-rail-danger'
        : 'border-rail-warning/35 bg-rail-warning/10 text-rail-warning';
  return (
    <span className={`w-fit rounded-[4px] border px-1.5 py-0.5 text-xs font-medium ${tone}`}>
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

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className="size-4"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M8 3v10M3 8h10" strokeLinecap="round" />
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
