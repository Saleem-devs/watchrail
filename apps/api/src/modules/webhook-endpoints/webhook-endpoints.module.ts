import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { WebhookEndpointsController } from './webhook-endpoints.controller.js';
import { WebhookEndpointsService } from './webhook-endpoints.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [WebhookEndpointsController],
  providers: [WebhookEndpointsService],
})
export class WebhookEndpointsModule {}
