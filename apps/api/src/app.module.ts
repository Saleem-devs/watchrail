import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule } from './config.module.js';
import { DatabaseModule } from './database.module.js';
import { MonitorsController } from './monitors.controller.js';
import { MonitorsService } from './monitors.service.js';
import { DevelopmentIdentityMiddleware } from './request-context.js';

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [MonitorsController],
  providers: [DevelopmentIdentityMiddleware, MonitorsService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(DevelopmentIdentityMiddleware).forRoutes(MonitorsController);
  }
}
