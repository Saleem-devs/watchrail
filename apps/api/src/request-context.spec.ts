import { describe, expect, it, vi } from 'vitest';
import { DEVELOPMENT_REQUEST_CONTEXT, DevelopmentIdentityMiddleware } from './request-context.js';

describe('DevelopmentIdentityMiddleware', () => {
  it('passes production requests through without manufacturing an identity', () => {
    const middleware = new DevelopmentIdentityMiddleware({
      developmentIdentityEnabled: false,
    } as never);
    const request: { watchrailContext?: unknown } = {};
    const next = vi.fn();

    middleware.use(request as never, {} as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(request.watchrailContext).toBeUndefined();
  });

  it('injects the fixed identity only when explicitly enabled', () => {
    const middleware = new DevelopmentIdentityMiddleware({
      developmentIdentityEnabled: true,
    } as never);
    const request: { watchrailContext?: unknown } = {};
    const next = vi.fn();

    middleware.use(request as never, {} as never, next);

    expect(request.watchrailContext).toEqual(DEVELOPMENT_REQUEST_CONTEXT);
    expect(next).toHaveBeenCalledOnce();
  });
});
