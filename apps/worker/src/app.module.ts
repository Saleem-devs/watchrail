import { Module } from '@nestjs/common';
import { DrizzleModule, getDrizzleToken } from '@nestjs/drizzle';
import { NodeHttpExecutor } from '@watchrail/check-engine';
import { BullMqCheckJobConsumer, BullMqCheckJobPublisher } from '@watchrail/queue';
import {
  CheckExecutionRepository,
  CheckRoundOutboxRepository,
  createWatchrailDatabase,
} from '@watchrail/db';
import type { WatchrailDatabase } from '@watchrail/db';
import { CheckOutboxRelay, createExponentialBackoff } from './check-outbox-relay.js';
import { CheckRoundJobHandler } from './check-round-job-handler.js';
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
      provide: CheckExecutionRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new CheckExecutionRepository(db),
    },
    {
      provide: NodeHttpExecutor,
      useFactory: () => new NodeHttpExecutor(),
    },
    {
      provide: CheckRoundJobHandler,
      inject: [CheckExecutionRepository, NodeHttpExecutor, WORKER_CONFIG],
      useFactory: (
        executions: CheckExecutionRepository,
        executor: NodeHttpExecutor,
        config: WorkerConfig,
      ) => new CheckRoundJobHandler(executions, executor, config.checkExecutionLeaseDurationMs),
    },
    {
      provide: BullMqCheckJobConsumer,
      inject: [WORKER_CONFIG, CheckRoundJobHandler],
      useFactory: (config: WorkerConfig, handler: CheckRoundJobHandler) =>
        BullMqCheckJobConsumer.connect({
          redisUrl: config.redisUrl,
          handler,
          concurrency: config.checkConsumerConcurrency,
          lockDurationMs: config.checkWorkerLockDurationMs,
        }),
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
      inject: [CheckOutboxRelay, BullMqCheckJobConsumer, BullMqCheckJobPublisher, WORKER_CONFIG],
      useFactory: (
        relay: CheckOutboxRelay,
        consumer: BullMqCheckJobConsumer,
        publisher: BullMqCheckJobPublisher,
        config: WorkerConfig,
      ) => new WorkerRuntime(relay, consumer, publisher, config),
    },
  ],
})
export class AppModule {}
