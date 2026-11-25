import { StatusDomainsService } from './status-domains.service.js';
import { StatusDomainsController } from './status-domains.controller.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { StatusPagesController } from './status-pages.controller.js';
import { StatusPagesService } from './status-pages.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [StatusPagesController, StatusDomainsController],
  providers: [StatusPagesService, StatusDomainsService],
  exports: [StatusPagesService],
})
export class StatusPagesModule {}
