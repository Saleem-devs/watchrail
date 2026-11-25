import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('./lib/status-domain-routing', () => ({ routeStatusDomain: () => Promise.resolve(null) }));
import { proxy } from './proxy';

describe('Next.js sign-in proxy', () => {
  it.each(['/sign-in', '/', '/sign-in/verify?email=test%40example.com', '/sign-in/complete'])(
    'keeps %s accessible with a stale session cookie',
    async (path) => {
      const request = new NextRequest(`https://watchrail.example.test${path}`, {
        headers: { cookie: 'better-auth.session_token=expired' },
      });
      expect(await proxy(request)).toBeUndefined();
    },
  );

  it('redirects protected pages for requests without a session cookie', async () => {
    const request = new NextRequest('https://watchrail.example.test/settings/organization');
    const response = await proxy(request);
    expect(response?.status).toBe(307);
    expect(response?.headers.get('location')).toContain('/sign-in?next=');
  });

  it('serves the sign-in brand mark without a session cookie', async () => {
    const request = new NextRequest('https://watchrail.example.test/watchrail-mark.svg');
    expect(await proxy(request)).toBeUndefined();
  });

  it('serves the public home page without a session cookie', async () => {
    expect(await proxy(new NextRequest('https://watchrail.example.test/'))).toBeUndefined();
  });
});
