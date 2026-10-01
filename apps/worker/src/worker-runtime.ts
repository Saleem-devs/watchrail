import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { BullMqCheckJobConsumer, BullMqCheckJobPublisher } from '@watchrail/queue';
import type { ScheduledRoundRepository } from '@watchrail/db';
import type { CheckOutboxRelay } from './check-outbox-relay.js';
import type { WorkerConfig } from './config.js';

@Injectable()
export class WorkerRuntime
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerRuntime.name);
  private stopping = false;
  private outboxRunning: Promise<void> | undefined;
  private schedulerRunning: Promise<void> | undefined;

  constructor(
    private readonly relay: CheckOutboxRelay,
    private readonly consumer: BullMqCheckJobConsumer,
    private readonly publisher: BullMqCheckJobPublisher,
    private readonly scheduledRounds: ScheduledRoundRepository,
    private readonly config: WorkerConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.outboxRunning = this.runOutboxRelay();
    this.schedulerRunning = this.runScheduledDispatch();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await Promise.all([this.outboxRunning, this.schedulerRunning, this.consumer.close()]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.publisher.close();
  }

  private async runOutboxRelay(): Promise<void> {
    while (!this.stopping) {
      try {
        const result = await this.relay.processNext();

        if (result === 'IDLE') {
          await delay(this.config.idlePollIntervalMs);
        } else if (result === 'BLOCKED_INVALID') {
          this.logger.error('Blocked an invalid check-round outbox event.');
        } else if (result === 'LOST_CLAIM') {
          this.logger.warn('An outbox relay claim expired before its final update.');
        }
      } catch (error) {
        this.logger.error(
          error instanceof Error ? error.message : 'Unknown outbox relay dependency failure.',
        );
        await delay(this.config.dependencyErrorDelayMs);
      }
    }
  }

  private async runScheduledDispatch(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.scheduledRounds.dispatchDue(this.config.scheduleDispatchBatchSize);
        await delay(this.config.scheduleIdlePollIntervalMs);
      } catch (error) {
        this.logger.error(
          error instanceof Error ? error.message : 'Unknown scheduled dispatch dependency failure.',
        );
        await delay(this.config.dependencyErrorDelayMs);
      }
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
