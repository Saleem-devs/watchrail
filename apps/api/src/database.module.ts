import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDatabaseConnection, MonitorRepository } from '@watchrail/db';
import type { DatabaseConnection } from '@watchrail/db';
import { APP_CONFIG, type AppConfig } from './config.js';

export const DATABASE_CONNECTION = Symbol('DATABASE_CONNECTION');

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_CONNECTION) private readonly connection: DatabaseConnection) {}

  async onApplicationShutdown(): Promise<void> {
    await this.connection.pool.end();
  }
}

@Module({
  providers: [
    {
      provide: DATABASE_CONNECTION,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createDatabaseConnection(config.databaseUrl),
    },
    {
      provide: MonitorRepository,
      inject: [DATABASE_CONNECTION],
      useFactory: (connection: DatabaseConnection) => new MonitorRepository(connection.db),
    },
    DatabaseLifecycle,
  ],
  exports: [MonitorRepository],
})
export class DatabaseModule {}
