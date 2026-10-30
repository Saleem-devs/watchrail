import Image from 'next/image';
import Link from 'next/link';
import type { PublicStatusPageProjectionV1 } from '@watchrail/domain';
import type { ReactNode } from 'react';

export function StatusPageHeader({
  page,
  active,
}: {
  page: PublicStatusPageProjectionV1;
  active: 'status' | 'incidents';
}) {
  const statusHref = `/status/${encodeURIComponent(page.slug)}`;
  const incidentsHref = `${statusHref}/incidents`;
  return (
    <header
      data-ui="public-status-header"
      className="flex min-h-16 items-center justify-between gap-4"
    >
      <Link
        href={statusHref}
        className="flex min-w-0 items-center gap-2.5 rounded-rail-control text-rail-text no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rail-accent"
        aria-label={`${page.name} status`}
      >
        <CustomerMark name={page.name} logoUrl={page.logoUrl} />
        <span className="truncate text-sm font-semibold">{page.name}</span>
      </Link>
      <nav aria-label="Status page sections" className="flex shrink-0 items-center gap-1">
        <NavLink href={statusHref} current={active === 'status'}>
          Status
        </NavLink>
        <NavLink href={incidentsHref} current={active === 'incidents'}>
          Incidents
        </NavLink>
      </nav>
    </header>
  );
}

export function StatusPageFooter() {
  return (
    <footer className="flex items-center justify-center gap-2 py-10 text-xs text-rail-muted">
      <span>Powered by</span>
      <a
        href="/"
        className="inline-flex items-center gap-1.5 font-medium text-rail-subtle no-underline hover:text-rail-text"
      >
        <Image src="/watchrail-mark.svg" width={16} height={16} alt="" aria-hidden="true" />
        Watchrail
      </a>
    </footer>
  );
}

function NavLink({
  href,
  current,
  children,
}: {
  href: string;
  current: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={current ? 'page' : undefined}
      className={`inline-flex min-h-9 items-center rounded-rail-control px-3 text-xs font-medium no-underline hover:bg-rail-hover hover:text-rail-text ${
        current ? 'bg-rail-selected text-rail-text' : 'text-rail-subtle'
      }`}
    >
      {children}
    </Link>
  );
}

function CustomerMark({ name, logoUrl }: { name: string; logoUrl: string | undefined }) {
  const safeLogoUrl = safeImageUrl(logoUrl);
  if (safeLogoUrl) {
    return (
      // Customer logos may be hosted by the customer's chosen provider.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={safeLogoUrl}
        alt=""
        aria-hidden="true"
        referrerPolicy="no-referrer"
        className="size-7 rounded-rail-control object-contain"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="grid size-7 place-items-center rounded-rail-control border border-rail-border-strong bg-rail-surface text-xs font-semibold text-rail-text"
    >
      {brandInitials(name)}
    </span>
  );
}

function safeImageUrl(value?: string): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('/')) return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return value;
  } catch {
    if (value.startsWith('data:image/')) return value;
  }
  return undefined;
}

function brandInitials(name: string): string {
  const words = name
    .replace(/\bstatus\b/giu, '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  return (
    (words.length > 1
      ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`
      : words[0]?.slice(0, 2)
    )?.toUpperCase() || 'S'
  );
}
