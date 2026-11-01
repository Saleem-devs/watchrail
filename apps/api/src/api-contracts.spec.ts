import { RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { PERMISSION_KEY, PUBLIC_KEY } from './auth/auth.guard.js';
import { MonitorHistoryController } from './modules/monitors/monitor-history.controller.js';
import { MonitorUptimeController } from './modules/monitors/monitor-uptime.controller.js';
import { MonitorsController } from './modules/monitors/monitors.controller.js';
import {
  ProbeAgentsController,
  ProbeEnrollmentsController,
  ProbeLocationsController,
  ProbeMachineController,
} from './modules/probes/probe-identity.controller.js';
import { InternalStatusPagesController } from './modules/public-status-pages/internal-status-pages.controller.js';
import { PublicStatusPagesController } from './modules/public-status-pages/public-status-pages.controller.js';
import { OverviewController } from './modules/overview/overview.controller.js';

function routes(controller: { prototype: object }) {
  const prototype: object = controller.prototype;
  const prefix = Reflect.getMetadata('path', controller) as string;
  return Object.getOwnPropertyNames(prototype).flatMap((key) => {
    if (key === 'constructor') return [];
    const handler: unknown = Reflect.get(prototype, key);
    if (typeof handler !== 'function') return [];
    const path = Reflect.getMetadata('path', handler) as string | undefined;
    const method = Reflect.getMetadata('method', handler) as RequestMethod | undefined;
    if (path === undefined || method === undefined) return [];
    const permission = Reflect.getMetadata(PERMISSION_KEY, handler) as string | undefined;
    return [
      {
        route: `${RequestMethod[method]} ${prefix}${path && path !== '/' ? `/${path}` : ''}`,
        permission,
      },
    ];
  });
}

describe('remaining API route contracts', () => {
  it('protects overview analytics with check-read permission', () => {
    expect(routes(OverviewController)).toEqual([
      { route: 'GET overview/response-times', permission: 'check:read' },
    ]);
  });

  it('preserves monitor settings, uptime, history, and incident paths and permissions', () => {
    const observed = [
      ...routes(MonitorsController),
      ...routes(MonitorUptimeController),
      ...routes(MonitorHistoryController),
    ];
    expect(observed).toHaveLength(23);
    expect(new Set(observed.map((item) => item.route)).size).toBe(23);
    expect(observed.every((item) => typeof item.permission === 'string')).toBe(true);
    expect(observed).toContainEqual({
      route: 'POST monitors',
      permission: 'monitor:create',
    });
    expect(observed).toContainEqual({
      route: 'POST monitors/test-configuration',
      permission: 'monitor:execute',
    });
    expect(observed).toContainEqual({
      route: 'POST monitors/:monitorId/test-configuration',
      permission: 'monitor:execute',
    });
    expect(observed).toContainEqual({
      route: 'PATCH monitors/:monitorId/tcp-settings',
      permission: 'monitor:update',
    });
    expect(observed).toContainEqual({
      route: 'PATCH monitors/:monitorId/dns-settings',
      permission: 'monitor:update',
    });
    expect(observed).toContainEqual({
      route: 'GET monitors/:monitorId/uptime',
      permission: 'availability:read',
    });
    expect(observed).toContainEqual({
      route: 'POST monitors/:monitorId/check-rounds',
      permission: 'monitor:execute',
    });
    expect(observed).toContainEqual({
      route: 'GET monitors/:monitorId/incidents/:incidentId',
      permission: 'incident:read',
    });
  });

  it('preserves probe operator authorization and public machine authentication separation', () => {
    const operators = [
      ...routes(ProbeLocationsController),
      ...routes(ProbeEnrollmentsController),
      ...routes(ProbeAgentsController),
    ];
    expect(operators).toHaveLength(7);
    expect(operators.every((route) => typeof route.permission === 'string')).toBe(true);
    expect(Reflect.getMetadata(PUBLIC_KEY, ProbeMachineController)).toBe(true);
    expect(routes(ProbeMachineController)).toHaveLength(8);
  });

  it('preserves the public and internal status-page routes as explicitly public', () => {
    expect(Reflect.getMetadata(PUBLIC_KEY, PublicStatusPagesController)).toBe(true);
    expect(Reflect.getMetadata(PUBLIC_KEY, InternalStatusPagesController)).toBe(true);
    expect(routes(PublicStatusPagesController).map((entry) => entry.route)).toEqual([
      'GET public/status-pages/:slug',
    ]);
    expect(routes(InternalStatusPagesController).map((entry) => entry.route)).toEqual([
      'GET internal/status-pages/:slug',
    ]);
  });
});
