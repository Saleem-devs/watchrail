import { createHmac } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';

/** Unknown Host headers never fall through to the authenticated application. */
export async function routeStatusDomain(request: NextRequest): Promise<NextResponse | null> {
  const primary = (process.env.FRONTEND_URL ?? 'http://localhost:3010')
    .split(',')
    .map((origin) => new URL(origin.trim()).host.toLowerCase());
  const host = (request.headers.get('host') ?? '').toLowerCase();
  if (primary.includes(host)) return null;
  const denied = () =>
    new NextResponse('Status page not found.', {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    });
  if (!/^[a-z0-9.-]+$/u.test(host)) return denied();
  const token =
    process.env.PUBLIC_STATUS_PAGE_INTERNAL_TOKEN ??
    (process.env.NODE_ENV === 'production' ? '' : 'watchrail-development-status-page-token');
  if (!token) return denied();
  let binding: { id: string; pageId: string; slug: string };
  try {
    const response = await fetch(
      `${process.env.API_URL ?? 'http://localhost:4000'}/api/internal/status-domains/resolve?hostname=${encodeURIComponent(host)}`,
      {
        headers: { 'x-watchrail-internal-token': token },
        cache: 'no-store',
        signal: AbortSignal.timeout(3000),
      },
    );
    if (!response.ok) return denied();
    binding = ((await response.json()) as { data: typeof binding }).data;
    if (!binding?.id || !/^[a-z0-9-]+$/u.test(binding.slug)) return denied();
  } catch {
    return new NextResponse('Status page temporarily unavailable.', {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  const path = request.nextUrl.pathname;
  const base = `/status/${binding.slug}`;
  const allowed =
    path === '/' ||
    path === base ||
    path.startsWith(`${base}/`) ||
    path === '/status/subscriptions/manage' ||
    path === '/api/public/status-subscriptions' ||
    path === '/api/public/status-subscriptions/verify' ||
    path === '/api/public/status-subscriptions/unsubscribe' ||
    path.startsWith('/_next/static/') ||
    path.startsWith('/_next/image') ||
    path === '/watchrail-mark.svg' ||
    path === '/favicon.ico';
  if (!allowed) return denied();
  const url = request.nextUrl.clone();
  if (path === '/') url.pathname = base;
  const result = path === '/' ? NextResponse.rewrite(url) : NextResponse.next();
  result.headers.set('Cache-Control', 'no-store');
  const challenge = request.headers.get('x-watchrail-domain-challenge') ?? '';
  if (/^[a-f0-9]{64}$/u.test(challenge)) {
    result.headers.set(
      'x-watchrail-domain-proof',
      createHmac('sha256', token).update(`status-domain:${binding.id}:${challenge}`).digest('hex'),
    );
  }
  return result;
}
