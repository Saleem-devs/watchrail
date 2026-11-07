import {
  InvalidSlackNotificationError,
  parseSlackNotification,
  type SlackNotificationV1,
} from '@watchrail/contracts';
import type {
  ClaimedSlackNotificationDelivery,
  SlackDeliveryDispatchDecision,
} from '@watchrail/db';
import type { WebhookDeliveryAttemptResult } from '@watchrail/webhook-delivery';
import {
  decryptSlackWebhookUrl,
  StoredSlackWebhookUrlInvariantError,
  StoredSlackWebhookUrlKeyUnavailableError,
  StoredSlackWebhookUrlResolutionError,
  type WebhookSigningSecretKeyring,
} from '@watchrail/webhook-security';

const SLACK_DELIVERY_CLEANUP_MARGIN_MS = 5_000;

export type SlackNotificationCycleResult =
  'IDLE' | 'DELIVERED' | 'SUPPRESSED' | 'RETRY_SCHEDULED' | 'DEAD' | 'LOST_CLAIM';

export interface SlackNotificationWorkerOptions {
  leaseDurationMs: number;
  sendTimeoutMs: number;
  maxAttempts: number;
  retryDelayMs: (attemptCount: number) => number;
  monotonicNowMs?: () => number;
}

export interface SlackDeliveryStore {
  claimNext(leaseDurationMs: number): Promise<ClaimedSlackNotificationDelivery | null>;
  applyMaintenancePolicy(
    id: string,
    token: string,
    organizationId: string,
    monitorId: string | null,
  ): Promise<SlackDeliveryDispatchDecision>;
  acknowledgeDelivered(id: string, token: string, httpStatus: number): Promise<boolean>;
  releaseForRetry(
    id: string,
    token: string,
    retryDelayMs: number,
    errorCode: string,
    httpStatus?: number,
  ): Promise<boolean>;
  markDead(
    id: string,
    token: string,
    reason: string,
    errorCode: string,
    httpStatus?: number,
  ): Promise<boolean>;
}

export interface SlackDeliveryAttemptExecutor {
  deliver(input: {
    url: string;
    body: Uint8Array;
    headers: readonly { name: string; value: string }[];
    timeoutMs: number;
  }): Promise<WebhookDeliveryAttemptResult>;
}

export class SlackNotificationWorker {
  constructor(
    private readonly deliveries: SlackDeliveryStore,
    private readonly engine: SlackDeliveryAttemptExecutor,
    private readonly keyring: WebhookSigningSecretKeyring,
    private readonly options: SlackNotificationWorkerOptions,
  ) {
    if (options.leaseDurationMs < options.sendTimeoutMs + SLACK_DELIVERY_CLEANUP_MARGIN_MS)
      throw new Error(
        'Slack delivery lease must exceed the send timeout by at least 5000 milliseconds.',
      );
  }

  async processNext(): Promise<SlackNotificationCycleResult> {
    const delivery = await this.deliveries.claimNext(this.options.leaseDurationMs);
    if (!delivery) return 'IDLE';

    let payload: SlackNotificationV1;
    try {
      payload = parseSlackNotification(delivery.payload);
      if (
        payload.eventId !== delivery.eventId ||
        payload.organizationId !== delivery.organizationId ||
        (payload.eventType === 'TEST'
          ? payload.channel.id !== delivery.channelId || delivery.monitorId !== null
          : payload.monitor.id !== delivery.monitorId)
      )
        throw new InvalidSlackNotificationError();
    } catch (error) {
      if (!(error instanceof InvalidSlackNotificationError))
        return this.retryOrExhaust(delivery, 'INTERNAL_ERROR');
      return this.dead(delivery, 'INVALID_CONTRACT', 'INVALID_CONTRACT');
    }

    const dispatch = await this.deliveries.applyMaintenancePolicy(
      delivery.id,
      delivery.claimToken,
      delivery.organizationId,
      delivery.monitorId,
    );
    if (dispatch.state !== 'CONTINUE') return dispatch.state;
    const remainingMs =
      dispatch.leaseExpiresAt.getTime() -
      dispatch.databaseNow.getTime() -
      SLACK_DELIVERY_CLEANUP_MARGIN_MS;
    if (remainingMs <= 0) return this.retryOrExhaust(delivery, 'LEASE_BUDGET_EXHAUSTED');
    const budgetStartedAtMs = this.monotonicNowMs();

    let url: string;
    try {
      url = decryptSlackWebhookUrl(
        delivery.webhookUrlEnvelope,
        {
          organizationId: delivery.organizationId,
          channelId: delivery.channelId,
          versionNumber: delivery.channelVersionNumber,
        },
        this.keyring,
      );
    } catch (error) {
      if (error instanceof StoredSlackWebhookUrlKeyUnavailableError)
        return this.retryOrExhaust(delivery, 'SECRET_UNAVAILABLE');
      if (
        error instanceof StoredSlackWebhookUrlInvariantError ||
        error instanceof StoredSlackWebhookUrlResolutionError
      )
        return this.dead(delivery, 'INVALID_SECRET_ENVELOPE', 'INVALID_SECRET_ENVELOPE');
      return this.retryOrExhaust(delivery, 'INTERNAL_ERROR');
    }

    try {
      const body = Buffer.from(
        JSON.stringify(renderSlackMessage(payload, delivery.deliverySequence)),
        'utf8',
      );
      const elapsedBeforeDispatchMs = Math.max(0, this.monotonicNowMs() - budgetStartedAtMs);
      const dispatchBudgetMs = remainingMs - Math.ceil(elapsedBeforeDispatchMs);
      if (dispatchBudgetMs <= 0) return this.retryOrExhaust(delivery, 'LEASE_BUDGET_EXHAUSTED');
      const result = await this.engine.deliver({
        url,
        body,
        timeoutMs: Math.min(this.options.sendTimeoutMs, dispatchBudgetMs),
        headers: [{ name: 'content-type', value: 'application/json; charset=utf-8' }],
      });
      return this.finishAttempt(delivery, result);
    } catch {
      return this.retryOrExhaust(delivery, 'INTERNAL_ERROR');
    }
  }

  private monotonicNowMs(): number {
    return this.options.monotonicNowMs?.() ?? performance.now();
  }

  private async finishAttempt(
    delivery: ClaimedSlackNotificationDelivery,
    result: WebhookDeliveryAttemptResult,
  ): Promise<SlackNotificationCycleResult> {
    if (result.type === 'FAILURE')
      return result.terminal
        ? this.dead(delivery, result.errorCode, result.errorCode)
        : this.retryOrExhaust(delivery, result.errorCode);
    const errorCode = `HTTP_${result.statusCode}`;
    if (result.statusCode >= 200 && result.statusCode <= 299)
      return (await this.deliveries.acknowledgeDelivered(
        delivery.id,
        delivery.claimToken,
        result.statusCode,
      ))
        ? 'DELIVERED'
        : 'LOST_CLAIM';
    if (
      result.statusCode === 408 ||
      result.statusCode === 425 ||
      result.statusCode === 429 ||
      (result.statusCode >= 500 && result.statusCode <= 599)
    )
      return this.retryOrExhaust(delivery, errorCode, result.statusCode);
    return this.dead(delivery, 'PERMANENT_HTTP_STATUS', errorCode, result.statusCode);
  }

  private async retryOrExhaust(
    delivery: ClaimedSlackNotificationDelivery,
    errorCode: string,
    httpStatus?: number,
  ): Promise<SlackNotificationCycleResult> {
    if (delivery.attemptCount >= this.options.maxAttempts)
      return this.dead(delivery, 'MAX_ATTEMPTS', errorCode, httpStatus);
    return (await this.deliveries.releaseForRetry(
      delivery.id,
      delivery.claimToken,
      this.options.retryDelayMs(delivery.attemptCount),
      errorCode,
      httpStatus,
    ))
      ? 'RETRY_SCHEDULED'
      : 'LOST_CLAIM';
  }

  private async dead(
    delivery: ClaimedSlackNotificationDelivery,
    reason: string,
    errorCode: string,
    httpStatus?: number,
  ): Promise<SlackNotificationCycleResult> {
    return (await this.deliveries.markDead(
      delivery.id,
      delivery.claimToken,
      reason,
      errorCode,
      httpStatus,
    ))
      ? 'DEAD'
      : 'LOST_CLAIM';
  }
}

export function renderSlackMessage(
  payload: SlackNotificationV1,
  deliverySequence = 0,
): {
  text: string;
  blocks: Array<Record<string, unknown>>;
} {
  if (payload.eventType === 'TEST') {
    const text = `Watchrail test notification for ${escapeSlack(payload.channel.name)}`;
    return {
      text,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: 'Watchrail test notification' } },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${escapeSlack(payload.channel.name)}* is connected to Slack.`,
          },
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `Sent ${escapeSlack(payload.occurredAt)}` }],
        },
      ],
    };
  }
  const opened = payload.eventType === 'INCIDENT_OPENED';
  const reminder = opened && deliverySequence > 0;
  const title = reminder
    ? `Incident reminder ${deliverySequence}`
    : opened
      ? 'Incident opened'
      : 'Incident resolved';
  const summary = opened
    ? `${payload.monitor.name} ${reminder ? 'is still failing' : 'is failing'} its monitoring policy.`
    : `${payload.monitor.name} has recovered.`;
  return {
    text: `${title}: ${escapeSlack(payload.monitor.name)}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: title } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${escapeSlack(payload.monitor.name)}*\n${escapeSlack(summary)}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Status*\n${payload.incident.status}` },
          ...(payload.contractVersion === 2
            ? [
                {
                  type: 'mrkdwn',
                  text: `*Impact*\n${payload.incident.severity === 'DOWN' ? 'Unavailable' : 'Degraded'}`,
                },
              ]
            : []),
          { type: 'mrkdwn', text: `*Started*\n${escapeSlack(payload.incident.startedAt)}` },
          ...(payload.incident.resolvedAt
            ? [{ type: 'mrkdwn', text: `*Resolved*\n${escapeSlack(payload.incident.resolvedAt)}` }]
            : []),
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text:
              payload.contractVersion === 2
                ? `Incident ${escapeSlack(payload.incident.id)} · Group ${escapeSlack(payload.incident.groupKey)}`
                : `Incident ${escapeSlack(payload.incident.id)}`,
          },
        ],
      },
    ],
  };
}

function escapeSlack(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
