import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { routeStatusDomain } from './status-domain-routing';
const binding = { id: 'binding-one', pageId: 'page-one', slug: 'customer-one' };
function req(path: string, host = 'status.customer.com', headers = {}) {
  return new NextRequest(`https://${host}${path}`, { headers: { host, ...headers } });
}
describe('custom status host routing', () => {
  beforeEach(() => {
    vi.stubEnv('FRONTEND_URL', 'https://app.watchrail.com');
    vi.stubEnv('PUBLIC_STATUS_PAGE_INTERNAL_TOKEN', 'internal-test-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ data: binding }))),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it('leaves primary hosts on the existing auth path', async () => {
    expect(await routeStatusDomain(req('/settings', 'app.watchrail.com'))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rewrites only to the verified page and signs the readiness challenge', async () => {
    const challenge = 'a'.repeat(64);
    const response = await routeStatusDomain(
      req('/', undefined, { 'x-watchrail-domain-challenge': challenge }),
    );
    expect(response?.headers.get('x-middleware-rewrite')).toBe(
      'https://status.customer.com/status/customer-one',
    );
    expect(response?.headers.get('x-watchrail-domain-proof')).toBe(
      createHmac('sha256', 'internal-test-token')
        .update(`status-domain:binding-one:${challenge}`)
        .digest('hex'),
    );
    expect(response?.headers.get('cache-control')).toBe('no-store');
  });
  it.each([
    '/settings',
    '/sign-in',
    '/api/auth/get-session',
    '/api/internal/status-domains/eligible',
    '/status/customer-two',
    '/status/customer-two/incidents',
  ])('denies %s on customer hosts', async (path) => {
    expect((await routeStatusDomain(req(path)))?.status).toBe(404);
  });
  it.each([
    '/status/customer-one/incidents',
    '/status/customer-one/subscribe',
    '/status/subscriptions/manage',
    '/_next/static/test.js',
    '/api/public/status-subscriptions',
  ])('allows public resources: %s', async (path) => {
    expect((await routeStatusDomain(req(path)))?.headers.get('x-middleware-next')).toBe('1');
  });
  it('rejects unknown/removed hosts and does not trust forwarded-host overrides', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 404 }));
    expect(
      (
        await routeStatusDomain(
          req('/', 'unknown.customer.com', { 'x-forwarded-host': 'app.watchrail.com' }),
        )
      )?.status,
    ).toBe(404);
  });
  it('fails closed when the resolver is unavailable', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    expect((await routeStatusDomain(req('/')))?.status).toBe(503);
  });
});
