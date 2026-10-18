import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';

describe('Next.js sign-in proxy', () => {
  it.each(['/sign-in', '/sign-in/verify?email=test%40example.com', '/sign-in/complete'])(
    'keeps %s accessible with a stale session cookie',
    (path) => {
      const request = new NextRequest(`https://watchrail.example.test${path}`, {
        headers: { cookie: 'better-auth.session_token=expired' },
      });
      expect(proxy(request)).toBeUndefined();
    },
  );

  it('redirects protected pages for requests without a session cookie', () => {
    const request = new NextRequest('https://watchrail.example.test/settings/organization');
    const response = proxy(request);
    expect(response?.status).toBe(307);
    expect(response?.headers.get('location')).toContain('/sign-in?next=');
  });
});
