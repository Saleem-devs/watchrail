import { Module } from '@nestjs/common';
import { DrizzleModule, getDrizzleToken } from '@nestjs/drizzle';
import { NodeHttpExecutor } from '@watchrail/check-engine';
import { WebhookDeliveryEngine } from '@watchrail/webhook-delivery';
import {
  BullMqAuthEmailConsumer,
  BullMqAuthEmailPublisher,
  BullMqCheckJobConsumer,
  BullMqCheckJobPublisher,
} from '@watchrail/queue';
import {
  CheckExecutionRepository,
  CheckRoundOutboxRepository,
  ScheduledRoundRepository,
  AvailabilityRepository,
  createWatchrailDatabase,
  NotificationDeliveryRepository,
  ProbeCoordinatorRepository,
  MultiLocationRoundFinalizationRepository,
  AuthEmailOutboxRepository,
} from '@watchrail/db';
import type { WatchrailDatabase } from '@watchrail/db';
import { CheckOutboxRelay, createExponentialBackoff } from './check-outbox-relay.js';
import { CheckRoundJobHandler } from './check-round-job-handler.js';
import { WorkerConfigModule } from './config.module.js';
import { WORKER_CONFIG, type WorkerConfig } from './config.js';
import { WorkerRuntime } from './worker-runtime.js';
import { WebhookDeliveryWorker } from './webhook-delivery-worker.js';
import { AuthEmailJobHandler, AuthEmailOutboxRelay } from './auth-email-worker.js';

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
      provide: AuthEmailOutboxRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new AuthEmailOutboxRepository(db),
    },
    {
      provide: BullMqAuthEmailPublisher,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) => BullMqAuthEmailPublisher.connect(config.redisUrl),
    },
    {
      provide: AuthEmailJobHandler,
      inject: [AuthEmailOutboxRepository, WORKER_CONFIG],
      useFactory: (outbox: AuthEmailOutboxRepository, config: WorkerConfig) =>
        new AuthEmailJobHandler(outbox, config.authEmailKeyring, config.smtp),
    },
    {
      provide: BullMqAuthEmailConsumer,
      inject: [WORKER_CONFIG, AuthEmailJobHandler],
      useFactory: (config: WorkerConfig, handler: AuthEmailJobHandler) =>
        BullMqAuthEmailConsumer.connect(
          config.redisUrl,
          (job) => handler.handle(job.messageId),
          (messageId) => handler.markTerminalFailure(messageId),
        ),
    },
    {
      provide: AuthEmailOutboxRelay,
      inject: [AuthEmailOutboxRepository, BullMqAuthEmailPublisher],
      useFactory: (outbox: AuthEmailOutboxRepository, publisher: BullMqAuthEmailPublisher) =>
        new AuthEmailOutboxRelay(outbox, publisher),
    },
    {
      provide: ProbeCoordinatorRepository,
      inject: [getDrizzleToken(), WORKER_CONFIG],
      useFactory: (db: WatchrailDatabase, config: WorkerConfig) =>
        new ProbeCoordinatorRepository(db, config.multiLocationExecutionEnabled),
    },
    {
      provide: MultiLocationRoundFinalizationRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new MultiLocationRoundFinalizationRepository(db),
    },
    {
      provide: NotificationDeliveryRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new NotificationDeliveryRepository(db),
    },
    {
      provide: WebhookDeliveryEngine,
      useFactory: () => new WebhookDeliveryEngine(),
    },
    {
      provide: WebhookDeliveryWorker,
      inject: [NotificationDeliveryRepository, WebhookDeliveryEngine, WORKER_CONFIG],
      useFactory: (
        deliveries: NotificationDeliveryRepository,
        engine: WebhookDeliveryEngine,
        config: WorkerConfig,
      ) =>
        new WebhookDeliveryWorker(deliveries, engine, config.webhookSigningSecretKeyring, {
          leaseDurationMs: config.webhookDeliveryLeaseDurationMs,
          timeoutMs: config.webhookDeliveryTimeoutMs,
          maxAttempts: config.webhookDeliveryMaxAttempts,
          retryDelayMs: createExponentialBackoff(
            config.webhookDeliveryRetryBaseMs,
            config.webhookDeliveryRetryMaxMs,
          ),
        }),
    },
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
      provide: ScheduledRoundRepository,
      inject: [getDrizzleToken(), WORKER_CONFIG],
      useFactory: (db: WatchrailDatabase, config: WorkerConfig) =>
        new ScheduledRoundRepository(db, config.multiLocationExecutionEnabled),
    },
    {
      provide: AvailabilityRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new AvailabilityRepository(db),
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
      ) =>
        new CheckRoundJobHandler(
          executions,
          executor,
          config.checkExecutionLeaseDurationMs,
          config.headerEncryptionKeyring,
          config.assertionEncryptionKeyring,
        ),
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
      inject: [
        CheckOutboxRelay,
        BullMqCheckJobConsumer,
        BullMqCheckJobPublisher,
        ScheduledRoundRepository,
        AvailabilityRepository,
        WORKER_CONFIG,
        WebhookDeliveryWorker,
        ProbeCoordinatorRepository,
        MultiLocationRoundFinalizationRepository,
        AuthEmailOutboxRelay,
        BullMqAuthEmailConsumer,
        BullMqAuthEmailPublisher,
      ],
      useFactory: (
        relay: CheckOutboxRelay,
        consumer: BullMqCheckJobConsumer,
        publisher: BullMqCheckJobPublisher,
        scheduledRounds: ScheduledRoundRepository,
        availability: AvailabilityRepository,
        config: WorkerConfig,
        webhookDelivery: WebhookDeliveryWorker,
        probeCoordinator: ProbeCoordinatorRepository,
        multiLocationFinalization: MultiLocationRoundFinalizationRepository,
        authEmailRelay: AuthEmailOutboxRelay,
        authEmailConsumer: BullMqAuthEmailConsumer,
        authEmailPublisher: BullMqAuthEmailPublisher,
      ) =>
        new WorkerRuntime(
          relay,
          consumer,
          publisher,
          scheduledRounds,
          availability,
          config,
          webhookDelivery,
          probeCoordinator,
          multiLocationFinalization,
          authEmailRelay,
          authEmailConsumer,
          authEmailPublisher,
        ),
    },
  ],
})
export class AppModule {}
