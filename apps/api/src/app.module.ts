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
import { StatusPagesController } from './status-pages.controller.js';
import { StatusPagesService } from './status-pages.service.js';
import { WebhookEndpointsController } from './webhook-endpoints.controller.js';
import { WebhookEndpointsService } from './webhook-endpoints.service.js';
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

@Module({
  imports: [ConfigModule, DatabaseModule, AuthModule],
  controllers: [
    InternalStatusPagesController,
    MonitorsController,
    OrganizationsController,
    ProbeAgentsController,
    ProbeEnrollmentsController,
    ProbeLocationsController,
    ProbeMachineController,
    PublicStatusPagesController,
    StatusPagesController,
    WebhookEndpointsController,
  ],
  providers: [
    // Development identity middleware — preserved for integration tests only.
    // Only active when DEV_IDENTITY_ENABLED=true (blocked in production).
    DevelopmentIdentityMiddleware,

    // Probe machine auth (untouched)
    ProbeIdentityService,
    ProbeCoordinatorService,
    ProbeMachineAuthGuard,
    ProbeMachineNoStoreMiddleware,
    {
      provide: ProbeMachineRateLimiter,
      useFactory: () => new ProbeMachineRateLimiter(),
    },

    // Application services
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
    StatusPagesService,
    WebhookEndpointsService,

    // Register WatchrailAuthGuard as a global guard.
    // Routes that should skip auth (probe machine, public status pages) are
    // handled by the DevelopmentIdentityMiddleware path (test) or by using
    // separate middleware that runs before the guard.
    //
    // Note: ProbeMachineController uses ProbeMachineAuthGuard which is applied
    // directly in probe-identity.controller.ts — the global guard is therefore
    // not a concern for probe machine routes.
    //
    // PublicStatusPagesController and InternalStatusPagesController are NOT
    // protected by the global guard — they use their own authentication
    // (internal token) applied in their own middleware chains.
    Reflector,
    {
      provide: APP_GUARD,
      useClass: WatchrailAuthGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Mount Better Auth at /api/auth/* (before NestJS routing).
    // This must come first so that auth routes are intercepted.
    consumer.apply(BetterAuthMiddleware).forRoutes('auth/*');

    // Nest's platform parser is disabled so Better Auth receives its untouched
    // request stream. Install bounded parsers after the auth middleware: auth
    // responses end before reaching these, while ordinary controllers retain
    // normal @Body() behavior.
    consumer
      .apply(json({ limit: '1mb' }), urlencoded({ extended: false, limit: '1mb' }))
      .forRoutes('*');

    // Development identity middleware (integration test support).
    // The guard will still run after this, but DevelopmentIdentityMiddleware
    // sets watchrailContext and the guard checks for it first.
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
      );

    consumer.apply(ProbeMachineNoStoreMiddleware).forRoutes(ProbeMachineController);
  }
}
