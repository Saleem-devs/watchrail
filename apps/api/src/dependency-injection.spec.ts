import { describe, expect, it } from 'vitest';
import { ApiCredentialsController } from './modules/api-credentials/api-credentials.controller.js';
import { ApiCredentialsService } from './modules/api-credentials/api-credentials.service.js';
import { OrganizationsController } from './modules/organizations/organizations.controller.js';
import { OrganizationsService } from './modules/organizations/organizations.service.js';
import { MonitorsController } from './modules/monitors/monitors.controller.js';
import { MonitorUptimeController } from './modules/monitors/monitor-uptime.controller.js';
import { MonitorHistoryController } from './modules/monitors/monitor-history.controller.js';
import {
  ProbeAgentsController,
  ProbeEnrollmentsController,
  ProbeLocationsController,
  ProbeMachineController,
} from './modules/probes/probe-identity.controller.js';
import { PublicStatusPagesController } from './modules/public-status-pages/public-status-pages.controller.js';
import { InternalStatusPagesController } from './modules/public-status-pages/internal-status-pages.controller.js';
import { ProbeIdentityService } from './probe-identity.service.js';
import { ProbeCoordinatorService } from './probe-coordinator.service.js';
import { MonitorsService } from './monitors.service.js';
import { StatusPagesController } from './modules/status-pages/status-pages.controller.js';
import { WebhookEndpointsController } from './modules/webhook-endpoints/webhook-endpoints.controller.js';
import { WebhookEndpointsService } from './modules/webhook-endpoints/webhook-endpoints.service.js';

describe('tsx dependency injection metadata', () => {
  it.each([
    ApiCredentialsController,
    ApiCredentialsService,
    OrganizationsController,
    OrganizationsService,
    MonitorsController,
    MonitorUptimeController,
    MonitorHistoryController,
    MonitorsService,
    ProbeAgentsController,
    ProbeEnrollmentsController,
    ProbeLocationsController,
    ProbeMachineController,
    ProbeIdentityService,
    ProbeCoordinatorService,
    PublicStatusPagesController,
    InternalStatusPagesController,
    StatusPagesController,
    WebhookEndpointsController,
    WebhookEndpointsService,
  ])('$name explicitly declares every constructor dependency', (dependency) => {
    const injectedIndexes = new Set(
      (
        Reflect.getMetadata('self:paramtypes', dependency) as
          Array<{ index: number; param: unknown }> | undefined
      )?.map(({ index }) => index) ?? [],
    );

    expect(injectedIndexes).toEqual(
      new Set(Array.from({ length: dependency.length }, (_, i) => i)),
    );
  });
});
