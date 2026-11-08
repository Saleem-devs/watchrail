import { Module } from '@nestjs/common';
import { DrizzleModule, getDrizzleToken } from '@nestjs/drizzle';
import {
  CheckHistoryRepository,
  DnsRecordHistoryRepository,
  createWatchrailDatabase,
  IncidentReadRepository,
  IncidentActionRepository,
  ManualRoundRepository,
  MonitorRepository,
  ProbeIdentityRepository,
  ProbeCoordinatorRepository,
  ProjectRepository,
  PublicStatusPageRepository,
  StatusPageRepository,
  UptimeReadRepository,
  WebhookDeliveryReadRepository,
  WebhookEndpointRepository,
  AuthMembershipRepository,
  AuthInvitationRepository,
  AuthApiKeyRepository,
  AuthEmailOutboxRepository,
  WorkspaceSecretRepository,
  HeartbeatRepository,
  MaintenanceWindowRepository,
  EmailChannelRepository,
  EmailDeliveryReadRepository,
  SlackChannelRepository,
  SlackDeliveryReadRepository,
} from '@watchrail/db';
import type { WatchrailDatabase } from '@watchrail/db';
import { ConfigModule } from '../../config/config.module.js';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';

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
      provide: EmailChannelRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new EmailChannelRepository(db),
    },
    {
      provide: EmailDeliveryReadRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new EmailDeliveryReadRepository(db),
    },
    {
      provide: SlackChannelRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new SlackChannelRepository(db),
    },
    {
      provide: SlackDeliveryReadRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new SlackDeliveryReadRepository(db),
    },
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
      provide: AuthInvitationRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new AuthInvitationRepository(db),
    },
    {
      provide: WorkspaceSecretRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new WorkspaceSecretRepository(db),
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
      provide: ProjectRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new ProjectRepository(db),
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
      provide: HeartbeatRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new HeartbeatRepository(db),
    },
    {
      provide: MaintenanceWindowRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new MaintenanceWindowRepository(db),
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
      provide: DnsRecordHistoryRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new DnsRecordHistoryRepository(db),
    },
    {
      provide: IncidentReadRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new IncidentReadRepository(db),
    },
    {
      provide: IncidentActionRepository,
      inject: [getDrizzleToken()],
      useFactory: (db: WatchrailDatabase) => new IncidentActionRepository(db),
    },
  ],
  exports: [
    AuthEmailOutboxRepository,
    AuthApiKeyRepository,
    AuthMembershipRepository,
    AuthInvitationRepository,
    UptimeReadRepository,
    CheckHistoryRepository,
    DnsRecordHistoryRepository,
    IncidentReadRepository,
    IncidentActionRepository,
    ManualRoundRepository,
    MonitorRepository,
    ProbeIdentityRepository,
    ProbeCoordinatorRepository,
    ProjectRepository,
    PublicStatusPageRepository,
    StatusPageRepository,
    WebhookEndpointRepository,
    WebhookDeliveryReadRepository,
    WorkspaceSecretRepository,
    HeartbeatRepository,
    MaintenanceWindowRepository,
    EmailChannelRepository,
    EmailDeliveryReadRepository,
    SlackChannelRepository,
    SlackDeliveryReadRepository,
  ],
})
export class DatabaseModule {}
