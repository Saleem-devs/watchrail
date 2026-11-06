import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { PublicStatusPageRateLimiter } from '../../common/rate-limiting/public-status-page-rate-limiter.js';
import { HeartbeatsController } from './heartbeats.controller.js';
import { HeartbeatsService } from './heartbeats.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [HeartbeatsController],
  providers: [
    HeartbeatsService,
    { provide: PublicStatusPageRateLimiter, useFactory: () => new PublicStatusPageRateLimiter() },
  ],
})
export class HeartbeatsModule {}
