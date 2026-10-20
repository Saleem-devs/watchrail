import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database.module.js';
import { ProbeCoordinatorService } from '../../probe-coordinator.service.js';
import { ProbeIdentityService } from '../../probe-identity.service.js';
import { ProbeMachineAuthGuard } from '../../probe-machine-auth.js';
import {
  ProbeAgentsController,
  ProbeEnrollmentsController,
  ProbeLocationsController,
  ProbeMachineController,
} from './probe-identity.controller.js';

@Module({
  imports: [DatabaseModule],
  controllers: [
    ProbeAgentsController,
    ProbeEnrollmentsController,
    ProbeLocationsController,
    ProbeMachineController,
  ],
  providers: [ProbeIdentityService, ProbeCoordinatorService, ProbeMachineAuthGuard],
})
export class ProbesModule {}
