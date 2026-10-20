import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database.module.js';
import { MonitorsService } from '../../monitors.service.js';
import { MonitorsController } from './monitors.controller.js';

@Module({
  imports: [DatabaseModule],
  controllers: [MonitorsController],
  providers: [MonitorsService],
})
export class MonitorsModule {}
