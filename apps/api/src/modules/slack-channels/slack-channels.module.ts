import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { SlackChannelsController } from './slack-channels.controller.js';
import { SlackChannelsService } from './slack-channels.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [SlackChannelsController],
  providers: [SlackChannelsService],
})
export class SlackChannelsModule {}
