import { InvalidExecuteCheckRoundJobError, parseExecuteCheckRoundJob } from '@watchrail/contracts';
import type { ExecuteCheckRoundJobV1 } from '@watchrail/contracts';
import type { ClaimedCheckRoundOutboxEvent, OutboxPublicationErrorCode } from '@watchrail/db';
import { CheckQueuePublicationTimeoutError, type CheckJobPublisher } from '@watchrail/queue';

export type RelayCycleResult =
  'IDLE' | 'PUBLISHED' | 'RETRY_SCHEDULED' | 'BLOCKED_INVALID' | 'LOST_CLAIM';

export interface CheckRoundOutboxStore {
  claimNext(leaseDurationMs: number): Promise<ClaimedCheckRoundOutboxEvent | null>;
  acknowledgePublished(outboxId: string, claimToken: string): Promise<boolean>;
  releaseForRetry(
    outboxId: string,
    claimToken: string,
    retryDelayMs: number,
    errorCode: OutboxPublicationErrorCode,
  ): Promise<boolean>;
  blockInvalid(outboxId: string, claimToken: string): Promise<boolean>;
}

export interface CheckOutboxRelayOptions {
  leaseDurationMs: number;
  retryDelayMs: (attemptCount: number) => number;
  classifyPublicationError?: (error: unknown) => OutboxPublicationErrorCode;
}

export class CheckOutboxRelay {
  private readonly classifyPublicationError: (error: unknown) => OutboxPublicationErrorCode;

  constructor(
    private readonly outbox: CheckRoundOutboxStore,
    private readonly publisher: CheckJobPublisher,
    private readonly options: CheckOutboxRelayOptions,
  ) {
    this.classifyPublicationError =
      options.classifyPublicationError ?? classifyCheckQueuePublicationError;
  }

  async processNext(): Promise<RelayCycleResult> {
    const event = await this.outbox.claimNext(this.options.leaseDurationMs);

    if (!event) return 'IDLE';

    let payload: ExecuteCheckRoundJobV1;

    try {
      payload = parseExecuteCheckRoundJob(event.payload);
    } catch (error) {
      if (!(error instanceof InvalidExecuteCheckRoundJobError)) throw error;

      const blocked = await this.outbox.blockInvalid(event.id, event.claimToken);
      return blocked ? 'BLOCKED_INVALID' : 'LOST_CLAIM';
    }

    try {
      await this.publisher.publish(payload);
    } catch (error) {
      const released = await this.outbox.releaseForRetry(
        event.id,
        event.claimToken,
        this.options.retryDelayMs(event.attemptCount),
        this.classifyPublicationError(error),
      );

      return released ? 'RETRY_SCHEDULED' : 'LOST_CLAIM';
    }

    const acknowledged = await this.outbox.acknowledgePublished(event.id, event.claimToken);
    return acknowledged ? 'PUBLISHED' : 'LOST_CLAIM';
  }
}

export function classifyCheckQueuePublicationError(error: unknown): OutboxPublicationErrorCode {
  return error instanceof CheckQueuePublicationTimeoutError
    ? 'QUEUE_PUBLICATION_TIMEOUT'
    : 'REDIS_UNAVAILABLE';
}

export function createExponentialBackoff(
  baseMs = 1_000,
  maximumMs = 60_000,
  random: () => number = Math.random,
): (attemptCount: number) => number {
  assertPositiveMilliseconds(baseMs, 'baseMs');
  assertPositiveMilliseconds(maximumMs, 'maximumMs');
  if (baseMs > maximumMs) throw new RangeError('baseMs cannot exceed maximumMs.');

  return (attemptCount) => {
    if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) {
      throw new RangeError('attemptCount must be a positive safe integer.');
    }

    const exponential = Math.min(maximumMs, baseMs * 2 ** Math.min(attemptCount - 1, 30));
    const jitterMultiplier = 0.5 + normalizeRandom(random());

    return Math.max(1, Math.min(maximumMs, Math.round(exponential * jitterMultiplier)));
  };
}

function normalizeRandom(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function assertPositiveMilliseconds(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}
