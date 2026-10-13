import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule } from './config.module.js';
import { DatabaseModule } from './database.module.js';
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
import {
  ProbeMachineAuthGuard,
  ProbeMachineNoStoreMiddleware,
  ProbeMachineRateLimiter,
} from './probe-machine-auth.js';

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [
    InternalStatusPagesController,
    MonitorsController,
    ProbeAgentsController,
    ProbeEnrollmentsController,
    ProbeLocationsController,
    ProbeMachineController,
    PublicStatusPagesController,
    StatusPagesController,
    WebhookEndpointsController,
  ],
  providers: [
    DevelopmentIdentityMiddleware,
    ProbeIdentityService,
    ProbeMachineAuthGuard,
    ProbeMachineNoStoreMiddleware,
    {
      provide: ProbeMachineRateLimiter,
      useFactory: () => new ProbeMachineRateLimiter(),
    },
    MonitorsService,
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
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(DevelopmentIdentityMiddleware)
      .forRoutes(
        MonitorsController,
        ProbeAgentsController,
        ProbeEnrollmentsController,
        ProbeLocationsController,
        StatusPagesController,
        WebhookEndpointsController,
      );
    consumer.apply(ProbeMachineNoStoreMiddleware).forRoutes(ProbeMachineController);
  }
}
