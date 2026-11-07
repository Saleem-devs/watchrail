'use client';

import { Button } from '../../components/ui/button';
import type {
  NotificationDelivery,
  NotificationDeliveryStatus,
  NotificationMonitor,
} from './types';

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function NotificationDeliveryHistory({
  monitors,
  deliveries,
  loading,
  error,
  onRetry,
}: {
  monitors: NotificationMonitor[];
  deliveries: NotificationDelivery[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const monitorNames = new Map(monitors.map((monitor) => [monitor.id, monitor.name]));
  return (
    <section className="mt-8" aria-labelledby="delivery-history-title">
      <div className="pb-4">
        <h2 id="delivery-history-title" className="m-0 text-base font-semibold text-rail-text">
          Delivery history
        </h2>
        <p className="mt-1 mb-0 text-sm text-rail-muted">Latest 25 delivery attempts</p>
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
          <div
            className="flex min-h-40 flex-col items-start justify-center gap-3 px-5 py-8"
            role="alert"
          >
            <p className="m-0 text-sm text-rail-subtle">{error}</p>
            <Button size="compact" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : deliveries.length === 0 ? (
          <div className="px-5 py-10">
            <h3 className="m-0 text-sm font-semibold text-rail-text">No deliveries yet</h3>
            <p className="mt-1.5 mb-0 text-sm text-rail-muted">
              Attempts appear after a routed monitor opens or resolves an incident.
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
                    {eventLabel(delivery.event.type, delivery.deliverySequence)}
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

function eventLabel(type: NotificationDelivery['event']['type'], deliverySequence: number): string {
  if (type === 'INCIDENT_OPENED' && deliverySequence > 0)
    return `Incident reminder ${deliverySequence}`;
  return type === 'INCIDENT_OPENED'
    ? 'Incident opened'
    : type === 'INCIDENT_RESOLVED'
      ? 'Incident resolved'
      : 'Test notification';
}

function DeliveryStatus({ status }: { status: NotificationDeliveryStatus }) {
  const labels: Record<NotificationDeliveryStatus, string> = {
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
      {labels[status]}
    </span>
  );
}
