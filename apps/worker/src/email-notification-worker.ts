import nodemailer from 'nodemailer';
import {
  InvalidEmailNotificationError,
  parseEmailNotification,
  type EmailNotificationV1,
} from '@watchrail/contracts';
import type { ClaimedEmailNotificationDelivery } from '@watchrail/db';

export type EmailNotificationCycleResult =
  'IDLE' | 'DELIVERED' | 'SUPPRESSED' | 'RETRY_SCHEDULED' | 'DEAD' | 'LOST_CLAIM';

export interface EmailNotificationDeliveryStore {
  claimNext(leaseDurationMs: number): Promise<ClaimedEmailNotificationDelivery | null>;
  applyMaintenancePolicy(
    id: string,
    token: string,
    organizationId: string,
    monitorId: string | null,
  ): Promise<'CONTINUE' | 'SUPPRESSED' | 'LOST_CLAIM'>;
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
  send(message: { to: string[]; subject: string; text: string }): Promise<void>;
}

export class NodemailerNotificationEmailSender implements NotificationEmailSender {
  private readonly transport: ReturnType<typeof nodemailer.createTransport>;

  constructor(
    private readonly from: string,
    smtp: { host: string; port: number; secure: boolean; user?: string; pass?: string },
  ) {
    this.transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user && smtp.pass ? { user: smtp.user, pass: smtp.pass } : undefined,
    });
  }

  async send(message: { to: string[]; subject: string; text: string }): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}

export class EmailNotificationWorker {
  constructor(
    private readonly deliveries: EmailNotificationDeliveryStore,
    private readonly sender: NotificationEmailSender,
    private readonly options: {
      leaseDurationMs: number;
      maxAttempts: number;
      retryDelayMs: (attemptCount: number) => number;
    },
  ) {}

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
    if (maintenance !== 'CONTINUE') return maintenance;

    try {
      await this.sender.send(renderEmail(payload, delivery.recipientEmails));
      return (await this.deliveries.acknowledgeDelivered(delivery.id, delivery.claimToken))
        ? 'DELIVERED'
        : 'LOST_CLAIM';
    } catch {
      return this.retryOrExhaust(delivery, 'SMTP_DELIVERY_FAILED');
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

function renderEmail(
  payload: EmailNotificationV1,
  recipients: string[],
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
  return {
    to: recipients,
    subject: `${opened ? 'Incident opened' : 'Incident resolved'} — ${payload.monitor.name}`,
    text: [
      `${payload.monitor.name} ${opened ? 'is failing its monitoring policy.' : 'has recovered.'}`,
      '',
      `Status: ${payload.incident.status}`,
      `Started: ${payload.incident.startedAt}`,
      `Opened: ${payload.incident.openedAt}`,
      ...(payload.incident.resolvedAt ? [`Resolved: ${payload.incident.resolvedAt}`] : []),
      `Incident ID: ${payload.incident.id}`,
    ].join('\n'),
  };
}
