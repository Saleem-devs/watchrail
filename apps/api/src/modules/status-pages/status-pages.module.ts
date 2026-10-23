import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { StatusPagesController } from './status-pages.controller.js';
import { StatusPagesService } from './status-pages.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [StatusPagesController],
  providers: [StatusPagesService],
  exports: [StatusPagesService],
})
export class StatusPagesModule {}
