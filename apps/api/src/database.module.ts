import { Module } from '@nestjs/common';
import { DrizzleModule, getDrizzleToken } from '@nestjs/drizzle';
import {
  CheckHistoryRepository,
  createWatchrailDatabase,
  IncidentReadRepository,
  ManualRoundRepository,
  MonitorRepository,
  ProbeIdentityRepository,
  ProbeCoordinatorRepository,
  PublicStatusPageRepository,
  StatusPageRepository,
  UptimeReadRepository,
  WebhookDeliveryReadRepository,
  WebhookEndpointRepository,
  AuthMembershipRepository,
  AuthApiKeyRepository,
  AuthEmailOutboxRepository,
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
      provide: AuthEmailOutboxRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new AuthEmailOutboxRepository(db),
    },
    {
      provide: AuthApiKeyRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new AuthApiKeyRepository(db),
    },
    {
      provide: AuthMembershipRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new AuthMembershipRepository(db),
    },
    {
      provide: ProbeCoordinatorRepository,
      inject: [getDrizzleToken(), APP_CONFIG],
      useFactory: (db: WatchrailDatabase, config: AppConfig) =>
        new ProbeCoordinatorRepository(db, config.multiLocationExecutionEnabled),
    },
    {
      provide: ProbeIdentityRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new ProbeIdentityRepository(db),
    },
    {
      provide: PublicStatusPageRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new PublicStatusPageRepository(db),
    },
    {
      provide: StatusPageRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new StatusPageRepository(db),
    },
    {
      provide: WebhookDeliveryReadRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new WebhookDeliveryReadRepository(db),
    },
    {
      provide: WebhookEndpointRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new WebhookEndpointRepository(db),
    },
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
      inject: [getDrizzleToken(), APP_CONFIG],
      useFactory: (db: WatchrailDatabase, config: AppConfig) =>
        new ManualRoundRepository(db, config.multiLocationExecutionEnabled),
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
    AuthEmailOutboxRepository,
    AuthApiKeyRepository,
    AuthMembershipRepository,
    UptimeReadRepository,
    CheckHistoryRepository,
    IncidentReadRepository,
    ManualRoundRepository,
    MonitorRepository,
    ProbeIdentityRepository,
    ProbeCoordinatorRepository,
    PublicStatusPageRepository,
    StatusPageRepository,
    WebhookEndpointRepository,
    WebhookDeliveryReadRepository,
  ],
})
export class DatabaseModule {}
