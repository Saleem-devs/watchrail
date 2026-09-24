import { Module } from '@nestjs/common';
import { BullMqCheckJobPublisher } from '@watchrail/queue';
import { CheckRoundOutboxRepository, createDatabaseConnection } from '@watchrail/db';
import { CheckOutboxRelay, createExponentialBackoff } from './check-outbox-relay.js';
import { loadWorkerConfig, WORKER_CONFIG, type WorkerConfig } from './config.js';
import { WorkerRuntime } from './worker-runtime.js';

@Module({
  providers: [
    {
      provide: WORKER_CONFIG,
      useFactory: loadWorkerConfig,
    },
    {
      provide: WorkerRuntime,
      inject: [WORKER_CONFIG],
      useFactory: async (config: WorkerConfig) => {
        const database = createDatabaseConnection(config.databaseUrl);

        try {
          const publisher = await BullMqCheckJobPublisher.connect({
            redisUrl: config.redisUrl,
            publicationTimeoutMs: config.queuePublicationTimeoutMs,
          });
          const outbox = new CheckRoundOutboxRepository(database.db);
          const relay = new CheckOutboxRelay(outbox, publisher, {
            leaseDurationMs: config.outboxLeaseDurationMs,
            retryDelayMs: createExponentialBackoff(),
          });

          return new WorkerRuntime(relay, publisher, database, config);
        } catch (error) {
          await database.pool.end();
          throw error;
        }
      },
    },
  ],
})
export class AppModule {}
