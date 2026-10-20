import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database.module.js';
import { PublicStatusPagesService } from '../../public-status-pages.service.js';
import {
  InternalStatusPageRateLimiter,
  PublicStatusPageRateLimiter,
} from '../../public-status-page-rate-limiter.js';
import { InternalStatusPagesController } from './internal-status-pages.controller.js';
import { PublicStatusPagesController } from './public-status-pages.controller.js';

@Module({
  imports: [DatabaseModule],
  controllers: [InternalStatusPagesController, PublicStatusPagesController],
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
