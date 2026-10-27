import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { OverviewController } from './overview.controller.js';
import { OverviewService } from './overview.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [OverviewController],
  providers: [OverviewService],
})
export class OverviewModule {}
