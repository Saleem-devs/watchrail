import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BetterAuthMiddleware } from './auth/auth.middleware.js';
import { WatchrailAuthGuard } from './auth/auth.guard.js';
import { MonitorsController } from './modules/monitors/monitors.controller.js';
import { MonitorUptimeController } from './modules/monitors/monitor-uptime.controller.js';
import { MonitorHistoryController } from './modules/monitors/monitor-history.controller.js';
import { MonitorsModule } from './modules/monitors/monitors.module.js';
import { PublicStatusPagesModule } from './modules/public-status-pages/public-status-pages.module.js';
import { DevelopmentIdentityMiddleware } from './auth/request-context.js';
import { StatusPagesController } from './modules/status-pages/status-pages.controller.js';
import { StatusPagesModule } from './modules/status-pages/status-pages.module.js';
import { WebhookEndpointsController } from './modules/webhook-endpoints/webhook-endpoints.controller.js';
import { WebhookEndpointsModule } from './modules/webhook-endpoints/webhook-endpoints.module.js';
import {
  ProbeAgentsController,
  ProbeEnrollmentsController,
  ProbeLocationsController,
  ProbeMachineController,
} from './modules/probes/probe-identity.controller.js';
import { ProbesModule } from './modules/probes/probes.module.js';
import {
  ProbeMachineNoStoreMiddleware,
  ProbeMachineRateLimiter,
} from './modules/probes/probe-machine-auth.js';
import { OrganizationsController } from './modules/organizations/organizations.controller.js';
import { OrganizationsModule } from './modules/organizations/organizations.module.js';
import { ApiCredentialsController } from './modules/api-credentials/api-credentials.controller.js';
import { ApiCredentialsModule } from './modules/api-credentials/api-credentials.module.js';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    AuthModule,
    ApiCredentialsModule,
    OrganizationsModule,
    MonitorsModule,
    ProbesModule,
    PublicStatusPagesModule,
    StatusPagesModule,
    WebhookEndpointsModule,
  ],
  providers: [
    DevelopmentIdentityMiddleware,
    ProbeMachineNoStoreMiddleware,
    {
      provide: ProbeMachineRateLimiter,
      useFactory: () => new ProbeMachineRateLimiter(),
    },

    Reflector,
    {
      provide: APP_GUARD,
      useClass: WatchrailAuthGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(BetterAuthMiddleware).forRoutes('auth/*');

    // Nest's platform parser is disabled so Better Auth receives its untouched
    // request stream. Install bounded parsers after the auth middleware: auth
    // responses end before reaching these, while ordinary controllers retain
    // normal @Body() behavior.
    consumer
      .apply(json({ limit: '1mb' }), urlencoded({ extended: false, limit: '1mb' }))
      .forRoutes('*');

    consumer
      .apply(DevelopmentIdentityMiddleware)
      .forRoutes(
        MonitorsController,
        MonitorUptimeController,
        MonitorHistoryController,
        ProbeAgentsController,
        ProbeEnrollmentsController,
        ProbeLocationsController,
        StatusPagesController,
        WebhookEndpointsController,
        OrganizationsController,
        ApiCredentialsController,
      );

    consumer.apply(ProbeMachineNoStoreMiddleware).forRoutes(ProbeMachineController);
  }
}
