import { StatusDomainRoutingController } from './status-domain-routing.controller.js';
import { StatusSubscriptionsController } from './status-subscriptions.controller.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { PublicStatusPagesService } from './public-status-pages.service.js';
import {
  InternalStatusPageRateLimiter,
  PublicStatusPageRateLimiter,
} from '../../common/rate-limiting/public-status-page-rate-limiter.js';
import { InternalStatusPagesController } from './internal-status-pages.controller.js';
import { PublicStatusPagesController } from './public-status-pages.controller.js';

@Module({
  imports: [DatabaseModule],
  controllers: [
    StatusDomainRoutingController,
    StatusSubscriptionsController,
    InternalStatusPagesController,
    PublicStatusPagesController,
  ],
  providers: [
    PublicStatusPagesService,
    { provide: PublicStatusPageRateLimiter, useFactory: () => new PublicStatusPageRateLimiter() },
    {
      provide: InternalStatusPageRateLimiter,
      useFactory: () => new InternalStatusPageRateLimiter(),
    },
  ],
})
export class PublicStatusPagesModule {}
