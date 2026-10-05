import { Module } from '@nestjs/common';
import { DrizzleModule, getDrizzleToken } from '@nestjs/drizzle';
import {
  CheckHistoryRepository,
  createWatchrailDatabase,
  IncidentReadRepository,
  ManualRoundRepository,
  MonitorRepository,
  UptimeReadRepository,
} from '@watchrail/db';
import type { WatchrailDatabase } from '@watchrail/db';
import { ConfigModule } from './config.module.js';
import { APP_CONFIG, type AppConfig } from './config.js';

@Module({
  imports: [
    DrizzleModule.forRootAsync({
      imports: [ConfigModule],
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        db: createWatchrailDatabase(config.databaseUrl),
      }),
    }),
  ],
  providers: [
    {
      provide: UptimeReadRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new UptimeReadRepository(db),
    },
    {
      provide: MonitorRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new MonitorRepository(db),
    },
    {
      provide: ManualRoundRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new ManualRoundRepository(db),
    },
    {
      provide: CheckHistoryRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new CheckHistoryRepository(db),
    },
    {
      provide: IncidentReadRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new IncidentReadRepository(db),
    },
  ],
  exports: [
    UptimeReadRepository,
    CheckHistoryRepository,
    IncidentReadRepository,
    ManualRoundRepository,
    MonitorRepository,
  ],
})
export class DatabaseModule {}
