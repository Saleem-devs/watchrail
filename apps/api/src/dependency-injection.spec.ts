import { describe, expect, it } from 'vitest';
import { ApiCredentialsController } from './api-credentials.controller.js';
import { ApiCredentialsService } from './api-credentials.service.js';
import { OrganizationsService } from './organizations.service.js';
import { StatusPagesController } from './status-pages.controller.js';
import { WebhookEndpointsController } from './webhook-endpoints.controller.js';

describe('tsx dependency injection metadata', () => {
  it.each([
    ApiCredentialsController,
    ApiCredentialsService,
    OrganizationsService,
    StatusPagesController,
    WebhookEndpointsController,
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
