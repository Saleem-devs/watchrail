import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { WorkspaceSecretsController } from './workspace-secrets.controller.js';
import { WorkspaceSecretsService } from './workspace-secrets.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [WorkspaceSecretsController],
  providers: [WorkspaceSecretsService],
})
export class WorkspaceSecretsModule {}
