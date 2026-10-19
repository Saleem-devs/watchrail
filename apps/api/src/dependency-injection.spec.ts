import { describe, expect, it } from 'vitest';
import { ApiCredentialsController } from './modules/api-credentials/api-credentials.controller.js';
import { ApiCredentialsService } from './modules/api-credentials/api-credentials.service.js';
import { OrganizationsService } from './organizations.service.js';
import { StatusPagesController } from './modules/status-pages/status-pages.controller.js';
import { WebhookEndpointsController } from './modules/webhook-endpoints/webhook-endpoints.controller.js';
import { WebhookEndpointsService } from './modules/webhook-endpoints/webhook-endpoints.service.js';

describe('tsx dependency injection metadata', () => {
  it.each([
    ApiCredentialsController,
    ApiCredentialsService,
    OrganizationsService,
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
