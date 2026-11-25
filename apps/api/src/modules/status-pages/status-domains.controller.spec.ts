import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { WatchrailAuthGuard } from '../../auth/auth.guard.js';
import { StatusDomainsController } from './status-domains.controller.js';

describe('custom-domain endpoint permissions', () => {
  it.each(['find', 'attach', 'verify', 'remove'] as const)(
    'enforces viewer permissions on %s',
    async (method) => {
      const auth = {
        api: {
          getSession: vi
            .fn()
            .mockResolvedValue({
              user: { id: 'viewer' },
              session: { activeOrganizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
            }),
        },
      };
      const memberships = { roleForUser: vi.fn().mockResolvedValue('viewer') };
      const guard = new WatchrailAuthGuard(
        auth as never,
        memberships as never,
        {} as never,
        new Reflector(),
      );
      const context = {
        getClass: () => StatusDomainsController,
        // The guard reads decorator metadata on the original method; it never invokes it.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      getHandler: () => StatusDomainsController.prototype[method],
        switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
      } as unknown as ExecutionContext;
      if (method === 'find') await expect(guard.canActivate(context)).resolves.toBe(true);
      else await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    },
  );
});
