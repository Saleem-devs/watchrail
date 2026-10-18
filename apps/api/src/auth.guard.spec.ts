import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { Public, WatchrailAuthGuard } from './auth.guard.js';
import { PERMISSIONS } from './permissions.js';

function executionContext(handler: () => void, controller: object, request: object) {
  return {
    getClass: () => controller,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('WatchrailAuthGuard authorization policy', () => {
  const auth = { api: { getSession: vi.fn() } };
  const memberships = { roleForUser: vi.fn() };
  const apiKeys = { authenticate: vi.fn() };
  const guard = new WatchrailAuthGuard(
    auth as never,
    memberships as never,
    apiKeys as never,
    new Reflector(),
  );

  it('fails closed when a protected endpoint has no permission metadata', async () => {
    class ProtectedController {}
    const handler = () => undefined;
    const context = executionContext(handler, ProtectedController, {
      watchrailContext: {
        actorId: '00000000-0000-4000-8000-000000000001',
        organizationId: '00000000-0000-4000-8000-000000000002',
      },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows an explicitly public endpoint without an authorization policy', async () => {
    class PublicController {}
    Public()(PublicController);
    const context = executionContext(() => undefined, PublicController, {});

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('honors an explicit permission for the development identity', async () => {
    class ProtectedController {}
    const handler = () => undefined;
    Reflect.defineMetadata('watchrail:permission', PERMISSIONS.MONITOR_READ, handler);
    const context = executionContext(handler, ProtectedController, {
      watchrailContext: {
        actorId: '00000000-0000-4000-8000-000000000001',
        organizationId: '00000000-0000-4000-8000-000000000002',
      },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
