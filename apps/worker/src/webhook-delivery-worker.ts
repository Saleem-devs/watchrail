import { InvalidWebhookNotificationError, parseWebhookNotification } from '@watchrail/contracts';
import type { ClaimedNotificationDelivery } from '@watchrail/db';
import type { WebhookDeliveryAttemptResult } from '@watchrail/webhook-delivery';
import {
  decryptWebhookSigningSecret,
  signWebhookBody,
  StoredWebhookSigningSecretInvariantError,
  StoredWebhookSigningSecretKeyUnavailableError,
  StoredWebhookSigningSecretResolutionError,
  type WebhookSigningSecretKeyring,
} from '@watchrail/webhook-security';

export type WebhookDeliveryCycleResult =
  'IDLE' | 'DELIVERED' | 'RETRY_SCHEDULED' | 'DEAD' | 'LOST_CLAIM';

export interface WebhookDeliveryWorkerOptions {
  leaseDurationMs: number;
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: (attemptCount: number) => number;
  now?: () => Date;
}

export interface NotificationDeliveryStore {
  claimNext(leaseDurationMs: number): Promise<ClaimedNotificationDelivery | null>;
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

export interface WebhookDeliveryAttemptExecutor {
  deliver: (input: {
    url: string;
    body: Uint8Array;
    headers: readonly { name: string; value: string }[];
    timeoutMs: number;
  }) => Promise<WebhookDeliveryAttemptResult>;
}

export class WebhookDeliveryWorker {
  private readonly now: () => Date;

  constructor(
    private readonly deliveries: NotificationDeliveryStore,
    private readonly engine: WebhookDeliveryAttemptExecutor,
    private readonly keyring: WebhookSigningSecretKeyring,
    private readonly options: WebhookDeliveryWorkerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async processNext(): Promise<WebhookDeliveryCycleResult> {
    const delivery = await this.deliveries.claimNext(this.options.leaseDurationMs);
    if (!delivery) return 'IDLE';

    let payload: ReturnType<typeof parseWebhookNotification>;
    try {
      payload = parseWebhookNotification(delivery.payload);
      if (
        payload.eventId !== delivery.eventId ||
        payload.organizationId !== delivery.organizationId
      )
        throw new InvalidWebhookNotificationError();
    } catch (error) {
      if (!(error instanceof InvalidWebhookNotificationError))
        return this.retryOrExhaust(delivery, 'INTERNAL_ERROR');
      return this.dead(delivery, 'INVALID_CONTRACT', 'INVALID_CONTRACT');
    }

    let secret: string;
    try {
      secret = decryptWebhookSigningSecret(
        delivery.signingSecretEnvelope,
        {
          organizationId: delivery.organizationId,
          endpointId: delivery.endpointId,
          versionNumber: delivery.endpointVersionNumber,
        },
        this.keyring,
      );
    } catch (error) {
      if (error instanceof StoredWebhookSigningSecretKeyUnavailableError)
        return this.retryOrExhaust(delivery, 'SECRET_UNAVAILABLE');
      if (
        error instanceof StoredWebhookSigningSecretInvariantError ||
        error instanceof StoredWebhookSigningSecretResolutionError
      )
        return this.dead(delivery, 'INVALID_SECRET_ENVELOPE', 'INVALID_SECRET_ENVELOPE');
      return this.retryOrExhaust(delivery, 'INTERNAL_ERROR');
    }

    try {
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      const timestamp = Math.floor(this.now().getTime() / 1000);
      const signature = signWebhookBody(secret, timestamp, body);
      const result = await this.engine.deliver({
        url: delivery.url,
        body,
        timeoutMs: this.options.timeoutMs,
        headers: [
          { name: 'content-type', value: 'application/json' },
          { name: 'x-watchrail-event-id', value: delivery.eventId },
          { name: 'x-watchrail-delivery-id', value: delivery.id },
          { name: 'x-watchrail-timestamp', value: String(timestamp) },
          { name: 'x-watchrail-signature', value: signature },
        ],
      });
      return this.finishAttempt(delivery, result);
    } catch {
      return this.retryOrExhaust(delivery, 'INTERNAL_ERROR');
    }
  }

  private async finishAttempt(
    delivery: ClaimedNotificationDelivery,
    result: WebhookDeliveryAttemptResult,
  ): Promise<WebhookDeliveryCycleResult> {
    if (result.type === 'FAILURE')
      return result.terminal
        ? this.dead(delivery, result.errorCode, result.errorCode)
        : this.retryOrExhaust(delivery, result.errorCode);
    const errorCode = `HTTP_${result.statusCode}`;
    if (result.statusCode >= 200 && result.statusCode <= 299) {
      return (await this.deliveries.acknowledgeDelivered(
        delivery.id,
        delivery.claimToken,
        result.statusCode,
      ))
        ? 'DELIVERED'
        : 'LOST_CLAIM';
    }
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
    delivery: ClaimedNotificationDelivery,
    errorCode: string,
    httpStatus?: number,
  ): Promise<WebhookDeliveryCycleResult> {
    if (delivery.attemptCount >= this.options.maxAttempts)
      return this.dead(delivery, 'MAX_ATTEMPTS', errorCode, httpStatus);
    const released = await this.deliveries.releaseForRetry(
      delivery.id,
      delivery.claimToken,
      this.options.retryDelayMs(delivery.attemptCount),
      errorCode,
      httpStatus,
    );
    return released ? 'RETRY_SCHEDULED' : 'LOST_CLAIM';
  }

  private async dead(
    delivery: ClaimedNotificationDelivery,
    reason: string,
    errorCode: string,
    httpStatus?: number,
  ): Promise<WebhookDeliveryCycleResult> {
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
