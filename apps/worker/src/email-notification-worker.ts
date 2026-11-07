import nodemailer from 'nodemailer';
import {
  InvalidEmailNotificationError,
  parseEmailNotification,
  type EmailNotificationV1,
} from '@watchrail/contracts';
import type { ClaimedEmailNotificationDelivery } from '@watchrail/db';

const EMAIL_DELIVERY_CLEANUP_MARGIN_MS = 5_000;

export type EmailNotificationCycleResult =
  'IDLE' | 'DELIVERED' | 'SUPPRESSED' | 'RETRY_SCHEDULED' | 'DEAD' | 'LOST_CLAIM';

export interface EmailNotificationDeliveryStore {
  claimNext(leaseDurationMs: number): Promise<ClaimedEmailNotificationDelivery | null>;
  applyMaintenancePolicy(
    id: string,
    token: string,
    organizationId: string,
    monitorId: string | null,
  ): Promise<
    | { state: 'CONTINUE'; databaseNow: Date; leaseExpiresAt: Date }
    | { state: 'SUPPRESSED' | 'LOST_CLAIM' }
  >;
  acknowledgeDelivered(id: string, token: string): Promise<boolean>;
  releaseForRetry(
    id: string,
    token: string,
    retryDelayMs: number,
    errorCode: string,
  ): Promise<boolean>;
  markDead(id: string, token: string, reason: string, errorCode: string): Promise<boolean>;
}

export interface NotificationEmailSender {
  send(
    message: { to: string[]; subject: string; text: string },
    options: { signal: AbortSignal },
  ): Promise<{ accepted: string[]; rejected: string[] }>;
}

export class NodemailerNotificationEmailSender implements NotificationEmailSender {
  constructor(
    private readonly from: string,
    private readonly smtp: {
      host: string;
      port: number;
      secure: boolean;
      user?: string;
      pass?: string;
    },
    private readonly timeouts: { connectionTimeoutMs: number; socketTimeoutMs: number },
  ) {}

  async send(
    message: { to: string[]; subject: string; text: string },
    options: { signal: AbortSignal },
  ): Promise<{ accepted: string[]; rejected: string[] }> {
    // A per-send one-connection pool gives abort() a concrete socket to close without
    // interrupting another concurrent delivery using this sender instance.
    const transport = nodemailer.createTransport({
      host: this.smtp.host,
      port: this.smtp.port,
      secure: this.smtp.secure,
      pool: true,
      maxConnections: 1,
      maxMessages: 1,
      connectionTimeout: this.timeouts.connectionTimeoutMs,
      greetingTimeout: this.timeouts.connectionTimeoutMs,
      socketTimeout: this.timeouts.socketTimeoutMs,
      auth:
        this.smtp.user && this.smtp.pass
          ? { user: this.smtp.user, pass: this.smtp.pass }
          : undefined,
    });
    const abort = () => transport.close();
    if (options.signal.aborted) {
      abort();
      throw new NotificationEmailTimeoutError();
    }
    options.signal.addEventListener('abort', abort, { once: true });
    try {
      const info = await transport.sendMail({ from: this.from, ...message });
      if (options.signal.aborted) throw new NotificationEmailTimeoutError();
      return {
        accepted: normalizeAddresses(info.accepted),
        rejected: normalizeAddresses(info.rejected),
      };
    } finally {
      options.signal.removeEventListener('abort', abort);
      transport.close();
    }
  }
}

export class NotificationEmailTimeoutError extends Error {
  constructor() {
    super('Email delivery exceeded its send deadline.');
    this.name = 'NotificationEmailTimeoutError';
  }
}

export class EmailNotificationWorker {
  constructor(
    private readonly deliveries: EmailNotificationDeliveryStore,
    private readonly sender: NotificationEmailSender,
    private readonly options: {
      leaseDurationMs: number;
      sendTimeoutMs: number;
      maxAttempts: number;
      retryDelayMs: (attemptCount: number) => number;
    },
  ) {
    if (
      !Number.isSafeInteger(options.leaseDurationMs) ||
      !Number.isSafeInteger(options.sendTimeoutMs) ||
      options.leaseDurationMs < options.sendTimeoutMs + EMAIL_DELIVERY_CLEANUP_MARGIN_MS
    )
      throw new Error('Email delivery lease must exceed the send timeout by at least 5000 ms.');
  }

  async processNext(): Promise<EmailNotificationCycleResult> {
    const delivery = await this.deliveries.claimNext(this.options.leaseDurationMs);
    if (!delivery) return 'IDLE';

    let payload: EmailNotificationV1;
    try {
      payload = parseEmailNotification(delivery.payload);
      if (
        payload.eventId !== delivery.eventId ||
        payload.organizationId !== delivery.organizationId ||
        ('monitor' in payload && payload.monitor.id !== delivery.monitorId) ||
        ('channel' in payload && payload.channel.id !== delivery.channelId)
      )
        throw new InvalidEmailNotificationError();
    } catch (error) {
      if (!(error instanceof InvalidEmailNotificationError))
        return this.retryOrExhaust(delivery, 'INTERNAL_ERROR');
      return this.dead(delivery, 'INVALID_CONTRACT', 'INVALID_CONTRACT');
    }

    const maintenance = await this.deliveries.applyMaintenancePolicy(
      delivery.id,
      delivery.claimToken,
      delivery.organizationId,
      delivery.monitorId,
    );
    if (maintenance.state !== 'CONTINUE') return maintenance.state;
    const sendTimeoutMs = Math.min(
      this.options.sendTimeoutMs,
      maintenance.leaseExpiresAt.getTime() -
        maintenance.databaseNow.getTime() -
        EMAIL_DELIVERY_CLEANUP_MARGIN_MS,
    );
    if (sendTimeoutMs <= 0) return this.retryOrExhaust(delivery, 'INSUFFICIENT_LEASE_BUDGET');

    try {
      const message = renderEmail(payload, delivery.recipientEmails, delivery.deliverySequence);
      // Delivery remains at-least-once: SMTP acceptance can be ambiguous if the
      // connection fails after the server accepts the message. The deadline prevents
      // an intentionally overlapping live attempt, while claim-token fencing prevents
      // a stale worker from recording the authoritative terminal state.
      const result = await withSendDeadline(
        (signal) => this.sender.send(message, { signal }),
        sendTimeoutMs,
      );
      const acceptance = recipientAcceptance(message.to, result);
      if (acceptance === 'PARTIAL')
        return this.dead(
          delivery,
          'PARTIAL_RECIPIENT_ACCEPTANCE',
          'SMTP_PARTIAL_RECIPIENT_ACCEPTANCE',
        );
      if (acceptance === 'NONE') return this.retryOrExhaust(delivery, 'SMTP_RECIPIENTS_REJECTED');
      return (await this.deliveries.acknowledgeDelivered(delivery.id, delivery.claimToken))
        ? 'DELIVERED'
        : 'LOST_CLAIM';
    } catch (error) {
      return this.retryOrExhaust(
        delivery,
        error instanceof NotificationEmailTimeoutError
          ? 'SMTP_DELIVERY_TIMEOUT'
          : 'SMTP_DELIVERY_FAILED',
      );
    }
  }

  private async retryOrExhaust(
    delivery: ClaimedEmailNotificationDelivery,
    errorCode: string,
  ): Promise<EmailNotificationCycleResult> {
    if (delivery.attemptCount >= this.options.maxAttempts)
      return this.dead(delivery, 'MAX_ATTEMPTS', errorCode);
    return (await this.deliveries.releaseForRetry(
      delivery.id,
      delivery.claimToken,
      this.options.retryDelayMs(delivery.attemptCount),
      errorCode,
    ))
      ? 'RETRY_SCHEDULED'
      : 'LOST_CLAIM';
  }

  private async dead(
    delivery: ClaimedEmailNotificationDelivery,
    reason: string,
    errorCode: string,
  ): Promise<EmailNotificationCycleResult> {
    return (await this.deliveries.markDead(delivery.id, delivery.claimToken, reason, errorCode))
      ? 'DEAD'
      : 'LOST_CLAIM';
  }
}

async function withSendDeadline<T>(
  send: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('Email send timeout must be a positive safe integer.');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    try {
      return await Promise.race([
        send(controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new NotificationEmailTimeoutError());
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (controller.signal.aborted) throw new NotificationEmailTimeoutError();
      throw error;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function recipientAcceptance(
  recipients: string[],
  result: { accepted: string[]; rejected: string[] },
): 'ALL' | 'NONE' | 'PARTIAL' {
  const expected = new Set(recipients.map(canonicalAddress));
  const accepted = new Set(result.accepted.map(canonicalAddress));
  const rejected = new Set(result.rejected.map(canonicalAddress));
  const acceptedCount = [...expected].filter((address) => accepted.has(address)).length;
  if (acceptedCount === expected.size && ![...expected].some((address) => rejected.has(address)))
    return 'ALL';
  return acceptedCount === 0 ? 'NONE' : 'PARTIAL';
}

function normalizeAddresses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).flatMap((entry) => {
    if (typeof entry === 'string') return [canonicalAddress(entry)];
    if (typeof entry === 'object' && entry !== null) {
      const address = (entry as Record<string, unknown>)['address'];
      if (typeof address === 'string') return [canonicalAddress(address)];
    }
    return [];
  });
}

function canonicalAddress(value: string): string {
  return value.trim().toLowerCase();
}

function renderEmail(
  payload: EmailNotificationV1,
  recipients: string[],
  deliverySequence: number,
): { to: string[]; subject: string; text: string } {
  if (payload.eventType === 'TEST')
    return {
      to: recipients,
      subject: `Watchrail test notification — ${payload.channel.name}`,
      text: [
        'Your Watchrail email channel is working.',
        '',
        `Channel: ${payload.channel.name}`,
        `Sent: ${payload.occurredAt}`,
        '',
        'This was a test notification. No incident was created or changed.',
      ].join('\n'),
    };
  const opened = payload.eventType === 'INCIDENT_OPENED';
  const reminder = opened && deliverySequence > 0;
  return {
    to: recipients,
    subject: `${reminder ? `Incident reminder ${deliverySequence}` : opened ? 'Incident opened' : 'Incident resolved'} — ${payload.monitor.name}`,
    text: [
      `${payload.monitor.name} ${reminder ? 'is still failing its monitoring policy.' : opened ? 'is failing its monitoring policy.' : 'has recovered.'}`,
      '',
      `Status: ${payload.incident.status}`,
      ...(payload.contractVersion === 2
        ? [
            `Impact: ${payload.incident.severity === 'DOWN' ? 'Unavailable' : 'Degraded'}`,
            `Alert group: ${payload.incident.groupKey}`,
          ]
        : []),
      `Started: ${payload.incident.startedAt}`,
      `Opened: ${payload.incident.openedAt}`,
      ...(payload.incident.resolvedAt ? [`Resolved: ${payload.incident.resolvedAt}`] : []),
      `Incident ID: ${payload.incident.id}`,
    ].join('\n'),
  };
}
