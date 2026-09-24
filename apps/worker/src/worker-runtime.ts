import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { DatabaseConnection } from '@watchrail/db';
import type { BullMqCheckJobPublisher } from '@watchrail/queue';
import type { CheckOutboxRelay } from './check-outbox-relay.js';
import type { WorkerConfig } from './config.js';

@Injectable()
export class WorkerRuntime implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerRuntime.name);
  private stopping = false;
  private running: Promise<void> | undefined;

  constructor(
    private readonly relay: CheckOutboxRelay,
    private readonly publisher: BullMqCheckJobPublisher,
    private readonly database: DatabaseConnection,
    private readonly config: WorkerConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.running = this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.running;
    await Promise.all([this.publisher.close(), this.database.pool.end()]);
  }

  private async run(): Promise<void> {
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
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
