import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { ConfigModule } from './config.module.js';
import { DatabaseModule } from './database.module.js';
import { AuthModule } from './auth.module.js';
import { BetterAuthMiddleware } from './auth.middleware.js';
import { WatchrailAuthGuard } from './auth.guard.js';
import { MonitorsController } from './monitors.controller.js';
import { MonitorsService } from './monitors.service.js';
import { PublicStatusPagesController } from './public-status-pages.controller.js';
import {
  InternalStatusPageRateLimiter,
  PublicStatusPageRateLimiter,
} from './public-status-page-rate-limiter.js';
import { PublicStatusPagesService } from './public-status-pages.service.js';
import { DevelopmentIdentityMiddleware } from './request-context.js';
import { InternalStatusPagesController } from './internal-status-pages.controller.js';
import { StatusPagesController } from './modules/status-pages/status-pages.controller.js';
import { StatusPagesModule } from './modules/status-pages/status-pages.module.js';
import { WebhookEndpointsController } from './modules/webhook-endpoints/webhook-endpoints.controller.js';
import { WebhookEndpointsModule } from './modules/webhook-endpoints/webhook-endpoints.module.js';
import {
  ProbeAgentsController,
  ProbeEnrollmentsController,
  ProbeLocationsController,
  ProbeMachineController,
} from './probe-identity.controller.js';
import { ProbeIdentityService } from './probe-identity.service.js';
import { ProbeCoordinatorService } from './probe-coordinator.service.js';
import {
  ProbeMachineAuthGuard,
  ProbeMachineNoStoreMiddleware,
  ProbeMachineRateLimiter,
} from './probe-machine-auth.js';
import { OrganizationsController } from './organizations.controller.js';
import { OrganizationsService } from './organizations.service.js';
import { ApiCredentialsController } from './modules/api-credentials/api-credentials.controller.js';
import { ApiCredentialsModule } from './modules/api-credentials/api-credentials.module.js';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    AuthModule,
    ApiCredentialsModule,
    StatusPagesModule,
    WebhookEndpointsModule,
  ],
  controllers: [
    InternalStatusPagesController,
    MonitorsController,
    OrganizationsController,
    ProbeAgentsController,
    ProbeEnrollmentsController,
    ProbeLocationsController,
    ProbeMachineController,
    PublicStatusPagesController,
  ],
  providers: [
    DevelopmentIdentityMiddleware,
    ProbeIdentityService,
    ProbeCoordinatorService,
    ProbeMachineAuthGuard,
    ProbeMachineNoStoreMiddleware,
    {
      provide: ProbeMachineRateLimiter,
      useFactory: () => new ProbeMachineRateLimiter(),
    },

    MonitorsService,
    OrganizationsService,
    {
      provide: PublicStatusPageRateLimiter,
      useFactory: () => new PublicStatusPageRateLimiter(),
    },
    {
      provide: InternalStatusPageRateLimiter,
      useFactory: () => new InternalStatusPageRateLimiter(),
    },
    PublicStatusPagesService,

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
