import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { MonitorsService } from './monitors.service.js';
import { MonitorsController } from './monitors.controller.js';
import { MonitorUptimeController } from './monitor-uptime.controller.js';
import { MonitorHistoryController } from './monitor-history.controller.js';
import { IncidentsController } from './incidents.controller.js';
import { NodeHttpExecutor } from '@watchrail/check-engine';
import {
  MonitorConfigurationTestRateLimiter,
  MonitorConfigurationTestService,
} from './monitor-configuration-test.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [
    MonitorsController,
    MonitorUptimeController,
    MonitorHistoryController,
    IncidentsController,
  ],
  providers: [
    MonitorsService,
    MonitorConfigurationTestService,
    {
      provide: MonitorConfigurationTestRateLimiter,
      useFactory: () => new MonitorConfigurationTestRateLimiter(),
    },
    { provide: NodeHttpExecutor, useFactory: () => new NodeHttpExecutor() },
  ],
})
export class MonitorsModule {}
