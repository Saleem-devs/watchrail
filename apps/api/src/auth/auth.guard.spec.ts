import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthApiKeyRepository, AuthMembershipRepository } from '@watchrail/db';
import { describe, expect, it, vi } from 'vitest';
import { Public, WatchrailAuthGuard } from './auth.guard.js';
import { PERMISSIONS } from './permissions.js';
import { DEVELOPMENT_REQUEST_CONTEXT } from './request-context.js';

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

  it('declares every runtime dependency explicitly for tsx execution', () => {
    const dependencies = (
      Reflect.getMetadata('self:paramtypes', WatchrailAuthGuard) as Array<{
        index: number;
        param: unknown;
      }>
    ).toSorted((left, right) => left.index - right.index);

    expect(dependencies).toEqual([
      { index: 0, param: expect.any(Symbol) },
      { index: 1, param: AuthMembershipRepository },
      { index: 2, param: AuthApiKeyRepository },
      { index: 3, param: Reflector },
    ]);
  });

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
      watchrailContext: DEVELOPMENT_REQUEST_CONTEXT,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
  it('rejects an injected context that did not come from the development middleware', async () => {
    class ProtectedController {}
    const handler = () => undefined;
    Reflect.defineMetadata('watchrail:permission', PERMISSIONS.MONITOR_READ, handler);
    const context = executionContext(handler, ProtectedController, {
      watchrailContext: { ...DEVELOPMENT_REQUEST_CONTEXT },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('caps API-key secret-use scopes at the authenticated organization role', async () => {
    class ProtectedController {}
    const handler = () => undefined;
    Reflect.defineMetadata('watchrail:permission', PERMISSIONS.SECRET_USE, handler);
    apiKeys.authenticate.mockResolvedValueOnce({
      userId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
      role: 'editor',
      permissions: JSON.stringify([PERMISSIONS.SECRET_USE]),
    });
    const context = executionContext(handler, ProtectedController, {
      headers: { authorization: `Bearer wrk_${'a'.repeat(43)}` },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('attaches effective secret-use permission for an authorized API key', async () => {
    class ProtectedController {}
    const handler = () => undefined;
    Reflect.defineMetadata('watchrail:permission', PERMISSIONS.SECRET_USE, handler);
    apiKeys.authenticate.mockResolvedValueOnce({
      userId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
      role: 'admin',
      permissions: JSON.stringify([PERMISSIONS.SECRET_USE, PERMISSIONS.MONITOR_UPDATE]),
    });
    const request = { headers: { authorization: `Bearer wrk_${'b'.repeat(43)}` } } as {
      headers: { authorization: string };
      watchrailContext?: { permissions: readonly string[] };
    };
    const context = executionContext(handler, ProtectedController, request);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.watchrailContext?.permissions).toEqual([
      PERMISSIONS.SECRET_USE,
      PERMISSIONS.MONITOR_UPDATE,
    ]);
  });
});
