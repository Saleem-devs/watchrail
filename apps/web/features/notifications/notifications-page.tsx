'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { AppShell } from '../../components/app-shell';
import { Button } from '../../components/ui/button';
import { Checkbox, Input } from '../../components/ui/form-control';
import { PageHeader } from '../../components/ui/page-header';
import {
  createWebhookChannel,
  listNotificationMonitors,
  listWebhookChannels,
  listWebhookDeliveries,
  NotificationRequestError,
  setWebhookChannelEnabled,
  updateWebhookChannel,
} from './notification-api';
import type {
  NotificationDelivery,
  NotificationDeliveryStatus,
  NotificationMonitor,
  WebhookChannel,
} from './types';

interface ChannelFormValues {
  name: string;
  url: string;
  signingSecret: string;
  monitorIds: string[];
  notifyOnIncident: boolean;
  notifyOnRecovery: boolean;
}

type Editor = { kind: 'create' } | { kind: 'edit'; channel: WebhookChannel } | null;

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
  const [editor, setEditor] = useState<Editor>(null);
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
            <Button variant="primary" onClick={() => setEditor({ kind: 'create' })}>
              <PlusIcon />
              Add webhook
            </Button>
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

        {editor ? (
          <section
            id="webhook-editor"
            className="mt-6 overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface"
            aria-labelledby="webhook-editor-title"
          >
            <ChannelForm
              key={editor.kind === 'edit' ? editor.channel.id : 'create'}
              projectId={projectId}
              monitors={monitors}
              {...(editor.kind === 'edit' ? { channel: editor.channel } : {})}
              onCancel={() => setEditor(null)}
              onSaved={async (channel) => {
                setEditor(null);
                setNotice(`${channel.name} saved.`);
                await load();
              }}
            />
          </section>
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
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={() => setEditor({ kind: 'create' })}
                >
                  Add the first webhook
                </Button>
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
                    onEdit={() => setEditor({ kind: 'edit', channel })}
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

function ChannelForm({
  projectId,
  monitors,
  channel,
  onCancel,
  onSaved,
}: {
  projectId: string;
  monitors: NotificationMonitor[];
  channel?: WebhookChannel;
  onCancel: () => void;
  onSaved: (channel: WebhookChannel) => Promise<void>;
}) {
  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ChannelFormValues>({
    defaultValues: {
      name: channel?.name ?? '',
      url: channel?.url ?? '',
      signingSecret: '',
      monitorIds: channel?.routing.monitorIds ?? [],
      notifyOnIncident: channel?.routing.notifyOnIncident ?? true,
      notifyOnRecovery: channel?.routing.notifyOnRecovery ?? true,
    },
  });
  const notifyOnIncident = useWatch({ control, name: 'notifyOnIncident' });
  const notifyOnRecovery = useWatch({ control, name: 'notifyOnRecovery' });
  const monitorIds = useWatch({ control, name: 'monitorIds' });

  return (
    <form
      noValidate
      onSubmit={handleSubmit(async (values) => {
        if (!values.notifyOnIncident && !values.notifyOnRecovery) {
          setError('notifyOnIncident', { message: 'Choose at least one event to deliver.' });
          return;
        }
        try {
          const routing = {
            monitorIds: values.monitorIds,
            notifyOnIncident: values.notifyOnIncident,
            notifyOnRecovery: values.notifyOnRecovery,
          };
          const saved = channel
            ? await updateWebhookChannel(channel.id, {
                name: values.name,
                url: values.url,
                signingSecret: values.signingSecret
                  ? { value: values.signingSecret }
                  : { retain: true },
                routing,
              })
            : await createWebhookChannel({
                projectId,
                name: values.name,
                url: values.url,
                signingSecret: values.signingSecret,
                enabled: true,
                routing,
              });
          await onSaved(saved);
        } catch (error) {
          applyServerErrors(error, setError);
        }
      })}
    >
      <div className="flex items-start justify-between gap-5 border-b border-rail-border px-5 py-4">
        <div>
          <h2 id="webhook-editor-title" className="m-0 text-base font-semibold text-rail-text">
            {channel ? 'Edit webhook channel' : 'Add webhook channel'}
          </h2>
          <p className="mt-1 mb-0 text-sm leading-6 text-rail-muted">
            Deliver signed incident events without exposing the signing secret after save.
          </p>
        </div>
        <button
          type="button"
          className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-rail-control border border-transparent bg-transparent text-rail-muted transition-colors hover:border-rail-border hover:bg-rail-hover hover:text-rail-text focus-visible:outline-2 focus-visible:outline-rail-accent"
          onClick={onCancel}
          aria-label="Close webhook editor"
        >
          <CloseIcon />
        </button>
      </div>

      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(19rem,0.72fr)]">
        <div className="grid gap-5 p-5 sm:grid-cols-2 lg:border-r lg:border-rail-border">
          <Field label="Channel name" error={errors.name?.message}>
            <Input
              autoFocus
              aria-invalid={Boolean(errors.name)}
              placeholder="Operations webhook"
              {...register('name', { required: 'Enter a channel name.' })}
            />
          </Field>
          <Field label="Endpoint URL" error={errors.url?.message}>
            <Input
              type="url"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              aria-invalid={Boolean(errors.url)}
              placeholder="https://hooks.ops.company/watchrail"
              {...register('url', { required: 'Enter an HTTPS endpoint URL.' })}
            />
          </Field>
          <Field
            className="sm:col-span-2"
            label={channel ? 'Replace signing secret' : 'Signing secret'}
            error={errors.signingSecret?.message}
            hint={
              channel
                ? 'Leave blank to keep the encrypted value. Enter a new value to rotate it.'
                : 'Use at least 16 characters. Watchrail will use it to sign every request.'
            }
          >
            <Input
              type="password"
              autoComplete="new-password"
              aria-invalid={Boolean(errors.signingSecret)}
              placeholder={channel ? 'Encrypted value retained' : 'Enter a strong signing secret'}
              {...register('signingSecret', {
                validate: (value) =>
                  Boolean(channel) || value.length >= 16 || 'Use at least 16 characters.',
              })}
            />
          </Field>
          <fieldset className="sm:col-span-2">
            <legend className="text-sm font-medium text-rail-text">Events</legend>
            <p className="mt-1 mb-3 text-sm leading-6 text-rail-muted">
              Incident alerts are created only after Watchrail confirms a failure.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <ChoiceRow
                label="Incident opened"
                description="Send when a monitor crosses its failure threshold."
              >
                <Checkbox {...register('notifyOnIncident')} />
              </ChoiceRow>
              <ChoiceRow
                label="Incident resolved"
                description="Send when a confirmed incident recovers."
              >
                <Checkbox {...register('notifyOnRecovery')} />
              </ChoiceRow>
            </div>
            {errors.notifyOnIncident?.message ? (
              <p className="mt-2 mb-0 text-xs text-rail-danger" role="alert">
                {errors.notifyOnIncident.message}
              </p>
            ) : null}
            {!notifyOnIncident && notifyOnRecovery ? (
              <p className="mt-2 mb-0 text-xs text-rail-muted">
                Recovery events will be sent without a matching incident-open event on this channel.
              </p>
            ) : null}
          </fieldset>
        </div>

        <fieldset className="min-w-0 p-5">
          <legend className="text-sm font-medium text-rail-text">Monitor routing</legend>
          <p className="mt-1 mb-3 text-sm leading-6 text-rail-muted">
            Choose the project monitors allowed to send events to this destination.
          </p>
          {monitors.length === 0 ? (
            <p className="m-0 rounded-rail-control border border-dashed border-rail-border px-3 py-4 text-sm text-rail-muted">
              This project has no monitors to route yet.
            </p>
          ) : (
            <div className="max-h-64 overflow-y-auto rounded-rail-control border border-rail-border bg-rail-input">
              {monitors.map((monitor) => (
                <label
                  key={monitor.id}
                  className="flex min-h-12 cursor-pointer items-center gap-3 border-b border-rail-border px-3 py-2 last:border-b-0 hover:bg-rail-hover"
                >
                  <Checkbox value={monitor.id} {...register('monitorIds')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-rail-text">
                      {monitor.name}
                    </span>
                    <span className="block text-xs text-rail-muted">
                      {monitor.type === 'API_WORKFLOW' ? 'API workflow' : monitor.type} ·{' '}
                      {monitor.lifecycleState === 'ENABLED' ? 'Active' : 'Paused'}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
          <p className="mt-2 mb-0 text-xs text-rail-muted">{monitorIds.length} selected</p>
        </fieldset>
      </div>

      {errors.root?.message ? (
        <p className="mx-5 mt-0 mb-4 text-sm text-rail-danger" role="alert">
          {errors.root.message}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 border-t border-rail-border px-5 py-4 sm:flex-row sm:justify-end">
        <Button type="button" variant="quiet" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : channel ? 'Save changes' : 'Add webhook'}
        </Button>
      </div>
    </form>
  );
}

function ChannelRow({
  channel,
  monitorCount,
  busy,
  onEdit,
  onHistory,
  onToggle,
}: {
  channel: WebhookChannel;
  monitorCount: number;
  busy: boolean;
  onEdit: () => void;
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
        <Button size="compact" variant="secondary" onClick={onEdit}>
          Edit
        </Button>
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

function ChoiceRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <label className="flex min-h-16 cursor-pointer items-start gap-3 rounded-rail-control border border-rail-border bg-rail-input px-3 py-3 hover:border-rail-selected-border">
      <span className="mt-0.5">{children}</span>
      <span>
        <span className="block text-sm font-medium text-rail-text">{label}</span>
        <span className="mt-0.5 block text-xs leading-5 text-rail-muted">{description}</span>
      </span>
    </label>
  );
}

function Field({
  label,
  error,
  hint,
  className,
  children,
}: {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label className={`block min-w-0 ${className ?? ''}`}>
      <span className="mb-2 block text-sm font-medium text-rail-text">{label}</span>
      {children}
      {error ? (
        <span className="mt-1.5 block text-xs text-rail-danger" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="mt-1.5 block text-xs leading-5 text-rail-muted">{hint}</span>
      ) : null}
    </label>
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

function applyServerErrors(
  error: unknown,
  setError: ReturnType<typeof useForm<ChannelFormValues>>['setError'],
) {
  if (error instanceof NotificationRequestError && error.details.fields) {
    const fields = error.details.fields;
    for (const field of ['name', 'url', 'signingSecret'] as const) {
      const message = fields[field]?.[0];
      if (message) setError(field, { message });
    }
    const routingMessage = fields.routing?.[0] ?? fields.monitorIds?.[0] ?? fields.projectId?.[0];
    if (routingMessage) setError('root', { message: routingMessage });
    if (
      Object.keys(fields).some(
        (field) =>
          !['name', 'url', 'signingSecret', 'routing', 'monitorIds', 'projectId'].includes(field),
      )
    ) {
      setError('root', { message: error.message });
    }
    return;
  }
  setError('root', { message: messageFor(error, 'Could not save the webhook channel.') });
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
