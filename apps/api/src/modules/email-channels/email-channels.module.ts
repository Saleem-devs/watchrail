import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { EmailChannelsController } from './email-channels.controller.js';
import { EmailChannelsService } from './email-channels.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [EmailChannelsController],
  providers: [EmailChannelsService],
})
export class EmailChannelsModule {}
