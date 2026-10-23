import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { ApiCredentialsController } from './api-credentials.controller.js';
import { ApiCredentialsService } from './api-credentials.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [ApiCredentialsController],
  providers: [ApiCredentialsService],
})
export class ApiCredentialsModule {}
