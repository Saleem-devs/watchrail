import { Module } from '@nestjs/common';
import { DrizzleModule, getDrizzleToken } from '@nestjs/drizzle';
import { BullMqCheckJobPublisher } from '@watchrail/queue';
import { CheckRoundOutboxRepository, createWatchrailDatabase } from '@watchrail/db';
import type { WatchrailDatabase } from '@watchrail/db';
import { CheckOutboxRelay, createExponentialBackoff } from './check-outbox-relay.js';
import { WorkerConfigModule } from './config.module.js';
import { WORKER_CONFIG, type WorkerConfig } from './config.js';
import { WorkerRuntime } from './worker-runtime.js';

@Module({
  imports: [
    WorkerConfigModule,
    DrizzleModule.forRootAsync({
      imports: [WorkerConfigModule],
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) => ({
        db: createWatchrailDatabase(config.databaseUrl),
      }),
    }),
  ],
  providers: [
    {
      provide: BullMqCheckJobPublisher,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) =>
        BullMqCheckJobPublisher.connect({
          redisUrl: config.redisUrl,
          publicationTimeoutMs: config.queuePublicationTimeoutMs,
        }),
    },
    {
      provide: CheckRoundOutboxRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new CheckRoundOutboxRepository(db),
    },
    {
      provide: CheckOutboxRelay,
      inject: [CheckRoundOutboxRepository, BullMqCheckJobPublisher, WORKER_CONFIG],
      useFactory: (
        outbox: CheckRoundOutboxRepository,
        publisher: BullMqCheckJobPublisher,
        config: WorkerConfig,
      ) =>
        new CheckOutboxRelay(outbox, publisher, {
          leaseDurationMs: config.outboxLeaseDurationMs,
          retryDelayMs: createExponentialBackoff(),
        }),
    },
    {
      provide: WorkerRuntime,
      inject: [CheckOutboxRelay, BullMqCheckJobPublisher, WORKER_CONFIG],
      useFactory: (
        relay: CheckOutboxRelay,
        publisher: BullMqCheckJobPublisher,
        config: WorkerConfig,
      ) => new WorkerRuntime(relay, publisher, config),
    },
  ],
})
export class AppModule {}
