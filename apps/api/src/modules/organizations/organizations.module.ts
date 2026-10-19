import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth.module.js';
import { DatabaseModule } from '../../database.module.js';
import { OrganizationsController } from './organizations.controller.js';
import { OrganizationsService } from './organizations.service.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [OrganizationsController],
  providers: [OrganizationsService],
})
export class OrganizationsModule {}
