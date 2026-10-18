/**
 * Next.js 16 proxy — route-level authentication guard.
 *
 * In Next.js 16 the middleware file is named proxy.ts (not middleware.ts) and
 * the exported function is named `proxy` (not `middleware`).
 *
 * This proxy checks for the presence (not validity) of a Better Auth session
 * cookie when protecting pages. Only the NestJS API validates credentials.
 * Sign-in routes must remain reachable even with an expired or revoked cookie.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/** Routes that do not require authentication. */
function isPublicPath(pathname: string): boolean {
  return (
    pathname.startsWith('/sign-in') || pathname.startsWith('/status/') || pathname === '/status'
  );
}

export function proxy(request: NextRequest): NextResponse | undefined {
  const { pathname } = request.nextUrl;

  // Let Next.js internals pass through unconditionally.
  if (
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/api/') ||
    pathname === '/favicon.ico' ||
    pathname === '/sitemap.xml' ||
    pathname === '/robots.txt'
  ) {
    return undefined;
  }

  const sessionCookie =
    request.cookies.get('better-auth.session_token') ??
    request.cookies.get('__Secure-better-auth.session_token');

  const authenticated = sessionCookie != null;

  if (!authenticated && !isPublicPath(pathname)) {
    // Unauthenticated user trying to access a protected page.
    const url = request.nextUrl.clone();
    url.pathname = '/sign-in';
    url.searchParams.set('next', `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(url);
  }

  return undefined;
}

export const config = {
  matcher: [
    /*
     * Match every path except:
     *  - _next/static, _next/image (Next.js assets)
     *  - favicon.ico, sitemap.xml, robots.txt
     */
    '/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)',
  ],
};
