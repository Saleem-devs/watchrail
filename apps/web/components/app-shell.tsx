'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { OrgSwitcher } from './org-switcher';

type Page = 'overview' | 'organization';
type IconName = 'overview' | 'monitors' | 'add' | 'organization' | 'menu';

const links = [
  { label: 'Overview', href: '/', page: 'overview', icon: 'overview' },
  { label: 'Monitors', href: '/#monitor-inventory', page: null, icon: 'monitors' },
  {
    label: 'Organization',
    href: '/settings/organization',
    page: 'organization',
    icon: 'organization',
  },
] as const;

function ShellIcon({ name, className = 'size-[18px]' }: { name: IconName; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    overview: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    monitors: <path d="M3 12h4l2.5-5 4.5 10 2.5-5H21" />,
    add: (
      <>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </>
    ),
    organization: (
      <>
        <circle cx="9" cy="8" r="3" />
        <circle cx="17" cy="9" r="2.5" />
        <path d="M3.5 20c.4-4 2.2-6 5.5-6s5.1 2 5.5 6" />
        <path d="M14 15c.8-.7 1.8-1 3-1 2.5 0 3.8 1.6 4 4.8" />
      </>
    ),
    menu: (
      <>
        <path d="M4 7h16" />
        <path d="M4 12h16" />
        <path d="M4 17h16" />
      </>
    ),
  };

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function WatchrailLogo({ compact = false }: { compact?: boolean }) {
  return (
    <Link
      href="/"
      aria-label="Watchrail home"
      className="inline-flex min-h-11 items-center gap-2.5 text-[18px] font-bold tracking-[-0.02em] text-rail-text no-underline"
    >
      <span className="grid size-9 place-items-center rounded-lg border border-rail-selected-border bg-rail-selected text-rail-accent">
        <svg viewBox="0 0 32 32" fill="none" className="size-6" aria-hidden="true">
          <path
            d="M3 19h7l4-9 5 15 4-8h6"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      {!compact && (
        <span>
          watchrail<span className="text-rail-accent">.</span>
        </span>
      )}
    </Link>
  );
}

function Navigation({ page, onNavigate }: { page: Page; onNavigate?: () => void }) {
  return (
    <nav aria-label="Workspace navigation" className="grid content-start gap-1">
      {links.map((item) => (
        <Link
          key={item.label}
          href={item.href}
          {...(onNavigate ? { onClick: onNavigate } : {})}
          aria-current={item.page === page ? 'page' : undefined}
          className="group flex min-h-11 items-center gap-3 rounded-lg px-3 text-[13px] font-medium whitespace-nowrap text-rail-subtle no-underline transition-colors hover:bg-rail-hover hover:text-rail-text aria-[current=page]:bg-rail-selected aria-[current=page]:text-rail-text"
        >
          <span className="text-rail-muted transition-colors group-hover:text-rail-text group-aria-[current=page]:text-rail-accent">
            <ShellIcon name={item.icon} />
          </span>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

function CreateMonitorLink({
  mobile = false,
  onNavigate,
}: {
  mobile?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href="/#create-monitor"
      {...(onNavigate ? { onClick: onNavigate } : {})}
      className={`flex min-h-11 items-center gap-2 rounded-lg bg-rail-accent px-3 text-[13px] font-semibold text-rail-on-accent no-underline transition-colors hover:bg-rail-accent-hover ${mobile ? 'mt-3 justify-center' : 'justify-start'}`}
    >
      <ShellIcon name="add" />
      Add monitor
    </Link>
  );
}

function MobileNavigation({ page }: { page: Page }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        ref={triggerRef}
        type="button"
        className="grid size-11 place-items-center rounded-lg border border-rail-border text-rail-subtle transition-colors hover:bg-rail-hover hover:text-rail-text"
        aria-expanded={open}
        aria-controls="mobile-workspace-navigation"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="sr-only">{open ? 'Close' : 'Open'} workspace navigation</span>
        <ShellIcon name="menu" className="size-5" />
      </button>
      {open && (
        <div
          id="mobile-workspace-navigation"
          className="absolute top-[calc(100%+0.5rem)] right-0 z-50 w-[min(18rem,calc(100vw-2rem))] rounded-xl border border-rail-border bg-rail-overlay p-2 shadow-[0_18px_50px_var(--color-rail-shadow)]"
        >
          <p className="px-3 pt-2 pb-3 text-xs font-medium text-rail-muted">Workspace</p>
          <Navigation page={page} onNavigate={() => setOpen(false)} />
          <CreateMonitorLink mobile onNavigate={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

export function AppShell({ children, page }: { children: ReactNode; page: Page }) {
  const title = page === 'overview' ? 'Overview' : 'Organization';

  return (
    <div className="min-h-screen bg-rail-workspace text-rail-text lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <a
        href="#main-content"
        className="fixed top-3 left-3 z-[100] -translate-y-20 rounded-lg bg-rail-accent px-4 py-2 text-sm font-semibold text-rail-on-accent no-underline transition-transform focus:translate-y-0"
      >
        Skip to content
      </a>
      <aside
        className="sticky top-0 hidden h-screen flex-col border-r border-rail-border bg-rail-sidebar px-4 pt-6 pb-5 lg:flex"
        aria-label="Workspace"
      >
        <div className="px-2">
          <WatchrailLogo />
        </div>
        <div className="mt-10 mb-3 px-3 text-xs font-medium text-rail-muted">Workspace</div>
        <Navigation page={page} />
        <div className="mt-4 border-t border-rail-border pt-4">
          <CreateMonitorLink />
        </div>
        <p className="mt-auto px-3 text-xs leading-5 text-rail-muted">
          Open-source uptime monitoring
        </p>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-40 border-b border-rail-border bg-rail-header">
          <div className="flex min-h-16 items-center justify-between gap-3 px-4 sm:px-6 lg:px-10 xl:px-16">
            <div className="lg:hidden">
              <WatchrailLogo compact />
            </div>
            <div className="hidden min-w-0 items-center gap-2 text-sm lg:flex">
              <span className="text-rail-muted">Workspace</span>
              <span className="text-rail-border-strong" aria-hidden="true">
                /
              </span>
              <strong className="truncate font-medium text-rail-text">{title}</strong>
            </div>
            <div className="ml-auto flex min-w-0 items-center gap-2">
              <OrgSwitcher />
              <div className="lg:hidden">
                <MobileNavigation page={page} />
              </div>
            </div>
          </div>
        </header>

        <div className="mx-auto max-w-[1700px] min-w-0 px-4 pb-16 sm:px-6 lg:px-10 xl:px-16">
          {children}
        </div>
      </div>
    </div>
  );
}
