import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { MonitorsService } from './monitors.service.js';
import { MonitorsController } from './monitors.controller.js';
import { MonitorUptimeController } from './monitor-uptime.controller.js';
import { MonitorHistoryController } from './monitor-history.controller.js';

@Module({
  imports: [DatabaseModule],
  controllers: [MonitorsController, MonitorUptimeController, MonitorHistoryController],
  providers: [MonitorsService],
})
export class MonitorsModule {}
