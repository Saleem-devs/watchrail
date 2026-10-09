import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule } from './config.module.js';
import { DatabaseModule } from './database.module.js';
import { MonitorsController } from './monitors.controller.js';
import { MonitorsService } from './monitors.service.js';
import { DevelopmentIdentityMiddleware } from './request-context.js';
import { StatusPagesController } from './status-pages.controller.js';
import { StatusPagesService } from './status-pages.service.js';
import { WebhookEndpointsController } from './webhook-endpoints.controller.js';
import { WebhookEndpointsService } from './webhook-endpoints.service.js';

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [MonitorsController, StatusPagesController, WebhookEndpointsController],
  providers: [
    DevelopmentIdentityMiddleware,
    MonitorsService,
    StatusPagesService,
    WebhookEndpointsService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(DevelopmentIdentityMiddleware)
      .forRoutes(MonitorsController, StatusPagesController, WebhookEndpointsController);
  }
}
