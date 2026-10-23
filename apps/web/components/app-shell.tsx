import Link from 'next/link';
import type { ReactNode } from 'react';
import { OrgSwitcher } from './org-switcher';

type Page = 'overview' | 'organization';

const links = [
  { label: 'Overview', href: '/', page: 'overview', glyph: '◫' },
  { label: 'Monitors', href: '/#monitor-inventory', page: null, glyph: '⌁' },
  { label: 'New monitor', href: '/#create-monitor', page: null, glyph: '+' },
  { label: 'Organization', href: '/settings/organization', page: 'organization', glyph: '⚙' },
] as const;

function Navigation({ page, mobile = false }: { page: Page; mobile?: boolean }) {
  return (
    <nav
      aria-label={mobile ? 'Mobile workspace navigation' : 'Workspace navigation'}
      className={mobile ? 'flex w-max gap-1 px-4 py-2' : 'grid content-start gap-1'}
    >
      {!mobile && <span className="mb-3 px-3 text-[10px] font-bold tracking-widest text-rail-muted uppercase">Workspace</span>}
      {links.map((item) => (
        <Link
          key={item.label}
          href={item.href}
          aria-current={item.page === page ? 'page' : undefined}
          className="flex min-h-11 items-center gap-3 rounded-lg border border-transparent px-3 text-[13px] font-medium whitespace-nowrap text-rail-subtle no-underline transition-colors hover:bg-rail-hover hover:text-rail-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rail-accent aria-[current=page]:border-rail-selected-border aria-[current=page]:bg-rail-selected aria-[current=page]:text-rail-accent-light"
        >
          <span className="grid w-[18px] place-items-center text-lg" aria-hidden="true">{item.glyph}</span>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

export function AppShell({ children, page }: { children: ReactNode; page: Page }) {
  const title = page === 'overview' ? 'Overview' : 'Organization';
  return (
    <div className="min-h-screen bg-rail-workspace text-rail-text lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-rail-border bg-rail-sidebar px-4 pt-8 pb-6 lg:flex" aria-label="Workspace">
        <Link href="/" aria-label="Watchrail home" className="mb-14 ml-3 inline-flex items-center gap-2.5 text-[19px] font-bold tracking-tight text-rail-text no-underline">
          <span className="grid size-9 place-items-center rounded-lg border border-rail-selected-border bg-rail-selected text-rail-accent">
            <svg viewBox="0 0 32 32" fill="none" className="size-6" aria-hidden="true">
              <path d="M3 19h7l4-9 5 15 4-8h6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          watchrail<span className="text-rail-accent">.</span>
        </Link>
        <Navigation page={page} />
        <div className="mt-auto flex items-center gap-2 border-t border-rail-border px-3 pt-4 text-xs text-rail-subtle">
          <span className="size-2 rounded-full bg-rail-success" aria-hidden="true" />Open-source monitoring
        </div>
      </aside>
      <div className="min-w-0">
        <header className="flex min-h-[73px] items-center justify-between gap-4 border-b border-rail-border bg-rail-header px-4 sm:px-6 lg:px-10 xl:px-16">
          <div className="flex gap-3 text-xs text-rail-muted">
            <span>Workspace</span><span aria-hidden="true">/</span><strong className="text-rail-text">{title}</strong>
          </div>
          <OrgSwitcher />
        </header>
        <div className="overflow-x-auto border-b border-rail-border bg-rail-sidebar lg:hidden"><Navigation page={page} mobile /></div>
        <div className="mx-auto max-w-[1700px] min-w-0 px-4 pb-16 sm:px-6 lg:px-10 xl:px-16">{children}</div>
      </div>
    </div>
  );
}
