import { describe, expect, it, vi } from 'vitest';
import { DEVELOPMENT_REQUEST_CONTEXT, DevelopmentIdentityMiddleware } from './request-context.js';

describe('DevelopmentIdentityMiddleware', () => {
  it('passes production requests through without manufacturing an identity', () => {
    const middleware = new DevelopmentIdentityMiddleware({
      developmentIdentityEnabled: false,
    } as never);
    const request: { headers: Record<string, string>; watchrailContext?: unknown } = {
      headers: {},
    };
    const next = vi.fn();

    middleware.use(request as never, {} as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(request.watchrailContext).toBeUndefined();
  });

  it('injects the fixed identity only when explicitly enabled', () => {
    const middleware = new DevelopmentIdentityMiddleware({
      developmentIdentityEnabled: true,
    } as never);
    const request: { headers: Record<string, string>; watchrailContext?: unknown } = {
      headers: {},
    };
    const next = vi.fn();

    middleware.use(request as never, {} as never, next);

    expect(request.watchrailContext).toEqual(DEVELOPMENT_REQUEST_CONTEXT);
    expect(next).toHaveBeenCalledOnce();
  });

  it.each([
    ['session cookie', { cookie: 'better-auth.session_token=token' }],
    ['authorization header', { authorization: 'Bearer token' }],
  ])('does not override a real %s', (_label, headers) => {
    const middleware = new DevelopmentIdentityMiddleware({
      developmentIdentityEnabled: true,
    } as never);
    const request: { headers: typeof headers; watchrailContext?: unknown } = { headers };
    const next = vi.fn();

    middleware.use(request as never, {} as never, next);

    expect(request.watchrailContext).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});
