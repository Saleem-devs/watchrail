import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { BullMqCheckJobConsumer, BullMqCheckJobPublisher } from '@watchrail/queue';
import type { AvailabilityRepository, ScheduledRoundRepository } from '@watchrail/db';
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
  private availabilityRunning: Promise<void> | undefined;
  private readonly wakeups = new Set<() => void>();

  constructor(
    private readonly relay: CheckOutboxRelay,
    private readonly consumer: BullMqCheckJobConsumer,
    private readonly publisher: BullMqCheckJobPublisher,
    private readonly scheduledRounds: ScheduledRoundRepository,
    private readonly availability: AvailabilityRepository,
    private readonly config: WorkerConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.outboxRunning = this.runOutboxRelay();
    this.schedulerRunning = this.runScheduledDispatch();
    this.availabilityRunning = this.runAvailabilityFlush();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    for (const wakeup of this.wakeups) wakeup();
    await Promise.all([
      this.outboxRunning,
      this.schedulerRunning,
      this.availabilityRunning,
      this.consumer.close(),
    ]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.publisher.close();
  }

  private async runOutboxRelay(): Promise<void> {
    while (!this.stopping) {
      try {
        const result = await this.relay.processNext();

        if (result === 'IDLE') {
          await this.wait(this.config.idlePollIntervalMs);
        } else if (result === 'BLOCKED_INVALID') {
          this.logger.error('Blocked an invalid check-round outbox event.');
        } else if (result === 'LOST_CLAIM') {
          this.logger.warn('An outbox relay claim expired before its final update.');
        }
      } catch (error) {
        this.logger.error(
          error instanceof Error ? error.message : 'Unknown outbox relay dependency failure.',
        );
        await this.wait(this.config.dependencyErrorDelayMs);
      }
    }
  }

  private async runScheduledDispatch(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.scheduledRounds.dispatchDue(this.config.scheduleDispatchBatchSize);
        await this.wait(this.config.scheduleIdlePollIntervalMs);
      } catch (error) {
        this.logger.error(
          error instanceof Error ? error.message : 'Unknown scheduled dispatch dependency failure.',
        );
        await this.wait(this.config.dependencyErrorDelayMs);
      }
    }
  }
  private async runAvailabilityFlush(): Promise<void> {
    while (!this.stopping) {
      try {
        const count = await this.availability.flushDue(
          this.config.availabilityFlushBatchSize,
          this.config.availabilityFlushIntervalMs,
        );
        if (count < this.config.availabilityFlushBatchSize) {
          await this.wait(this.config.availabilityFlushIntervalMs);
        }
      } catch {
        this.logger.error('Availability flush dependency failure.');
        await this.wait(this.config.dependencyErrorDelayMs);
      }
    }
  }

  private wait(milliseconds: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const wakeup = () => {
        clearTimeout(timer);
        this.wakeups.delete(wakeup);
        resolve();
      };
      const timer = setTimeout(wakeup, milliseconds);
      this.wakeups.add(wakeup);
    });
  }
}
