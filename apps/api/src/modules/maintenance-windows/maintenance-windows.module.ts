import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { MaintenanceWindowsController } from './maintenance-windows.controller.js';
import { MaintenanceWindowsService } from './maintenance-windows.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [MaintenanceWindowsController],
  providers: [MaintenanceWindowsService],
})
export class MaintenanceWindowsModule {}
