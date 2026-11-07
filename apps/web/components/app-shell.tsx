'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  Bell,
  Building2,
  CalendarDays,
  ChevronRight,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  Menu,
  PanelLeft,
  PanelTop,
  Plus,
  Radio,
  Search,
  TriangleAlert,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { OrgSwitcher } from './org-switcher';
import { ProjectSwitcher } from './project-switcher';
import { MONITOR_TYPES, type MonitorType } from '../features/monitors/monitor-types';

type Page =
  | 'workspaces'
  | 'projects'
  | 'overview'
  | 'monitors'
  | 'new-monitor'
  | 'monitor-detail'
  | 'incidents'
  | 'notifications'
  | 'maintenance'
  | 'status-pages'
  | 'organization'
  | 'secrets';
type IconName =
  | 'overview'
  | 'monitors'
  | 'add'
  | 'incidents'
  | 'status-pages'
  | 'probes'
  | 'notifications'
  | 'maintenance'
  | 'organization'
  | 'members'
  | 'credentials'
  | 'secrets'
  | 'menu'
  | 'sidebar-control';

type NavigationItem = {
  label: string;
  icon: IconName;
  href?: string;
  page?: Page;
  disabled?: boolean;
};

const projectNavigationGroups: { label: string; items: NavigationItem[] }[] = [
  {
    label: 'Monitoring',
    items: [
      { label: 'Overview', href: '/', page: 'overview', icon: 'overview' },
      { label: 'Monitors', href: '/monitors', page: 'monitors', icon: 'monitors' },
      { label: 'Incidents', href: '/incidents', page: 'incidents', icon: 'incidents' },
      { label: 'Status pages', href: '/status-pages', page: 'status-pages', icon: 'status-pages' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Probe locations', icon: 'probes', disabled: true },
      { label: 'Notifications', icon: 'notifications', page: 'notifications' },
      { label: 'Maintenance', icon: 'maintenance', page: 'maintenance' },
    ],
  },
  {
    label: 'Workspace',
    items: [
      {
        label: 'Organization',
        href: '/settings/organization#general',
        page: 'organization',
        icon: 'organization',
      },
      { label: 'Members', href: '/settings/organization#members', icon: 'members' },
      {
        label: 'API credentials',
        href: '/settings/organization#api-credentials',
        icon: 'credentials',
      },
      { label: 'Secrets', href: '/settings/secrets', page: 'secrets', icon: 'secrets' },
    ],
  },
];

function navigationGroups(
  projectId?: string,
  workspaceId?: string,
): { label: string; items: NavigationItem[] }[] {
  if (!projectId) {
    return [
      {
        label: 'Workspace',
        items: [
          {
            label: 'Projects',
            href: workspaceId ? `/workspaces/${workspaceId}` : '/projects',
            page: 'projects',
            icon: 'overview',
          },
          { label: 'Members', href: '/settings/organization#members', icon: 'members' },
          {
            label: 'Workspace settings',
            href: '/settings/organization#general',
            page: 'organization',
            icon: 'organization',
          },
          { label: 'Secrets', href: '/settings/secrets', page: 'secrets', icon: 'secrets' },
        ],
      },
    ];
  }
  const base = `/projects/${projectId}`;
  const groups: { label: string; items: NavigationItem[] }[] = [
    {
      label: 'Project',
      items: [
        { label: 'Overview', href: base, page: 'overview', icon: 'overview' },
        { label: 'Monitors', href: `${base}/monitors`, page: 'monitors', icon: 'monitors' },
        { label: 'Incidents', href: `${base}/incidents`, page: 'incidents', icon: 'incidents' },
        {
          label: 'Status pages',
          href: `${base}/status-pages`,
          page: 'status-pages',
          icon: 'status-pages',
        },
      ],
    },
    ...projectNavigationGroups.slice(1),
  ];
  return groups.map((group) =>
    group.label !== 'Operations'
      ? group
      : {
          ...group,
          items: group.items.map((item) =>
            item.icon === 'notifications'
              ? { ...item, href: `${base}/notifications` }
              : item.icon === 'maintenance'
                ? { ...item, href: `${base}/maintenance` }
                : item,
          ),
        },
  );
}

const shellIcons: Record<IconName, LucideIcon> = {
  overview: LayoutDashboard,
  monitors: Activity,
  add: Plus,
  incidents: TriangleAlert,
  'status-pages': PanelTop,
  probes: Radio,
  notifications: Bell,
  maintenance: CalendarDays,
  organization: Building2,
  members: Users,
  credentials: KeyRound,
  secrets: LockKeyhole,
  menu: Menu,
  'sidebar-control': PanelLeft,
};

function ShellIcon({ name, className = 'size-[18px]' }: { name: IconName; className?: string }) {
  const Icon = shellIcons[name];
  return <Icon className={className} strokeWidth={1.75} aria-hidden="true" />;
}

function WatchrailLogo({ compact = false }: { compact?: boolean }) {
  return (
    <Link
      href="/"
      aria-label="Watchrail home"
      className="inline-flex min-h-10 items-center gap-2 text-base font-semibold tracking-[-0.02em] text-rail-text no-underline"
    >
      <Image src="/watchrail-mark.svg" alt="" width={28} height={28} className="size-7" />
      {!compact && (
        <span>
          watchrail<span className="text-rail-accent">.</span>
        </span>
      )}
    </Link>
  );
}

function SearchIcon({ className = 'size-4' }: { className?: string }) {
  return <Search className={className} strokeWidth={1.75} aria-hidden="true" />;
}

function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
      }
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="flex min-h-10 min-w-10 items-center justify-center gap-2 rounded-rail-control border border-rail-border bg-rail-raised px-2.5 text-[13px] text-rail-muted transition-colors hover:border-rail-border-strong hover:bg-rail-hover hover:text-rail-text sm:min-h-8 sm:min-w-0 sm:justify-start"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label="Search Watchrail"
      >
        <SearchIcon />
        <span className="hidden sm:inline">Search...</span>
        <kbd className="ml-3 hidden rounded border border-rail-border bg-rail-sidebar px-1.5 py-0.5 font-sans text-[10px] text-rail-muted lg:inline">
          ⌘K
        </kbd>
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-[90] flex items-start justify-center bg-black/60 px-4 pt-[14vh] backdrop-blur-sm"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="global-search-title"
            tabIndex={-1}
            className="w-full max-w-xl overflow-hidden rounded-rail-panel border border-rail-border bg-rail-overlay shadow-[0_24px_80px_var(--color-rail-shadow)] outline-none"
            onKeyDown={(event) => {
              if (event.key !== 'Tab') return;
              const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
              );
              if (!controls?.length) return;
              const first = controls[0];
              const last = controls[controls.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }}
          >
            <div className="flex items-center gap-3 border-b border-rail-border px-4 py-3">
              <SearchIcon className="size-5 text-rail-muted" />
              <div className="min-w-0 flex-1">
                <h2 id="global-search-title" className="m-0 text-sm font-medium text-rail-text">
                  Search Watchrail
                </h2>
                <p className="mt-0.5 mb-0 text-xs text-rail-muted">
                  Workspace-wide search is coming soon.
                </p>
              </div>
              <button
                type="button"
                className="grid size-8 place-items-center rounded-rail-control text-rail-muted hover:bg-rail-hover hover:text-rail-text"
                onClick={() => setOpen(false)}
              >
                <span className="sr-only">Close search</span>
                <X className="size-4" strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
            <div className="p-4">
              <div className="flex min-h-9 items-center gap-3 rounded-rail-control border border-rail-border bg-rail-sidebar px-3 text-sm text-rail-muted">
                <SearchIcon />
                Search monitors, incidents, and settings
              </div>
              <p className="mt-3 mb-0 text-xs leading-5 text-rail-muted">
                This preview does not query or expose workspace data yet.
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Navigation({
  page,
  projectId,
  workspaceId,
  collapsed = false,
  onNavigate,
  monitorType,
}: {
  page: Page;
  projectId?: string | undefined;
  workspaceId?: string | undefined;
  collapsed?: boolean;
  onNavigate?: () => void;
  monitorType?: MonitorType | undefined;
}) {
  const monitorsActive = page === 'monitors' || page === 'monitor-detail' || page === 'new-monitor';
  const [monitorsOpen, setMonitorsOpen] = useState(monitorsActive);
  const monitorNavigationId = useId();

  return (
    <nav aria-label="Workspace navigation" className="grid content-start gap-4">
      {navigationGroups(projectId, workspaceId).map((group) => (
        <div key={group.label} className="grid gap-1">
          <p
            className={`m-0 overflow-hidden px-3 text-[10px] font-medium tracking-[0.08em] whitespace-nowrap text-rail-muted uppercase transition-[max-height,padding,opacity] duration-150 ${collapsed ? 'max-h-0 pb-0 opacity-0' : 'max-h-5 pb-1 opacity-100'}`}
          >
            {group.label}
          </p>
          {group.items.map((item) => {
            const active =
              item.page === page ||
              (item.page === 'monitors' && (page === 'monitor-detail' || page === 'new-monitor'));
            const sharedClassName = `group relative flex min-h-9 items-center gap-3 rounded-rail-control px-3 text-[13px] whitespace-nowrap transition-colors ${active ? 'bg-rail-selected font-medium text-rail-text' : 'font-normal text-rail-subtle'} ${item.disabled ? 'cursor-not-allowed' : 'hover:bg-rail-hover hover:text-rail-text'}`;
            const content = (
              <>
                <span
                  className={`shrink-0 transition-colors ${active ? 'text-rail-accent' : 'text-rail-muted group-hover:text-rail-text'}`}
                >
                  <ShellIcon name={item.icon} />
                </span>
                <span
                  className={`overflow-hidden transition-[max-width,opacity] duration-150 ${collapsed ? 'max-w-0 opacity-0' : 'max-w-36 opacity-100'}`}
                >
                  {item.label}
                </span>
              </>
            );

            if (item.page === 'monitors' && projectId) {
              const base = `/projects/${projectId}/monitors`;
              return (
                <div key={item.label} className="grid gap-1">
                  <button
                    type="button"
                    className={`${sharedClassName} w-full cursor-pointer appearance-none border-0 bg-transparent text-left`}
                    aria-expanded={monitorsOpen}
                    aria-controls={monitorNavigationId}
                    title={collapsed ? 'Monitors' : undefined}
                    onClick={() => setMonitorsOpen((current) => !current)}
                  >
                    {content}
                    <ChevronRight
                      className={`ml-auto size-4 shrink-0 text-rail-muted transition-[transform,opacity] ${collapsed ? 'opacity-0' : 'opacity-100'} ${monitorsOpen ? 'rotate-90' : ''}`}
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                  </button>
                  {!collapsed && monitorsOpen ? (
                    <div
                      id={monitorNavigationId}
                      className="ml-4 grid gap-0.5 border-l border-rail-border pl-3"
                    >
                      <Link
                        href={base}
                        {...(onNavigate ? { onClick: onNavigate } : {})}
                        aria-current={page === 'monitors' && !monitorType ? 'page' : undefined}
                        className={`flex min-h-8 items-center rounded-rail-control px-3 text-xs no-underline transition-colors ${page === 'monitors' && !monitorType ? 'bg-rail-selected font-medium text-rail-text' : 'text-rail-muted hover:bg-rail-hover hover:text-rail-text'}`}
                      >
                        All monitors
                      </Link>
                      {MONITOR_TYPES.map((definition) => {
                        const childActive = monitorType === definition.type;
                        return (
                          <Link
                            key={definition.type}
                            href={`${base}/${definition.slug}`}
                            {...(onNavigate ? { onClick: onNavigate } : {})}
                            aria-current={childActive ? 'page' : undefined}
                            className={`flex min-h-8 items-center rounded-rail-control px-3 text-xs no-underline transition-colors ${childActive ? 'bg-rail-selected font-medium text-rail-text' : 'text-rail-muted hover:bg-rail-hover hover:text-rail-text'}`}
                          >
                            {definition.label}
                          </Link>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            }

            if (item.disabled || !item.href) {
              return (
                <span
                  key={item.label}
                  aria-disabled="true"
                  title={collapsed ? `${item.label} — coming soon` : undefined}
                  className={sharedClassName}
                >
                  {content}
                </span>
              );
            }

            return (
              <Link
                key={item.label}
                href={item.href}
                {...(onNavigate ? { onClick: onNavigate } : {})}
                aria-current={active ? 'page' : undefined}
                title={collapsed ? item.label : undefined}
                className={`${sharedClassName} no-underline`}
              >
                {content}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function MobileNavigation({
  page,
  projectId,
  workspaceId,
  monitorType,
}: {
  page: Page;
  projectId?: string | undefined;
  workspaceId?: string | undefined;
  monitorType?: MonitorType | undefined;
}) {
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
        className="grid size-10 place-items-center rounded-rail-control border border-rail-border text-rail-subtle transition-colors hover:bg-rail-hover hover:text-rail-text"
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
          className="absolute top-[calc(100%+0.5rem)] right-0 z-50 w-[min(18rem,calc(100vw-2rem))] rounded-rail-panel border border-rail-border bg-rail-overlay p-2 shadow-[0_18px_50px_var(--color-rail-shadow)]"
        >
          <p className="px-3 pt-2 pb-3 text-xs font-medium text-rail-muted">Workspace</p>
          <Navigation
            page={page}
            projectId={projectId}
            workspaceId={workspaceId}
            monitorType={monitorType}
            onNavigate={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

export function AppShell({
  children,
  page,
  projectId,
  workspaceId,
  monitorType,
}: {
  children: ReactNode;
  page: Page;
  projectId?: string | undefined;
  workspaceId?: string | undefined;
  monitorType?: MonitorType | undefined;
}) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const storedMode = window.localStorage.getItem('watchrail.sidebar-mode');
      setSidebarCollapsed(
        storedMode === 'collapsed' ||
          window.localStorage.getItem('watchrail.sidebar-collapsed') === 'true',
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem('watchrail.sidebar-collapsed', String(next));
      window.localStorage.removeItem('watchrail.sidebar-mode');
      return next;
    });
  }

  return (
    <div className="min-h-screen bg-rail-workspace text-rail-text">
      <a
        href="#main-content"
        className="fixed top-3 left-3 z-[100] -translate-y-20 rounded-lg bg-rail-accent px-4 py-2 text-sm font-semibold text-rail-on-accent no-underline transition-transform focus:translate-y-0"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-50 border-b border-rail-border bg-rail-header">
        <div className="flex min-h-12 items-center gap-1.5 px-3 sm:px-4">
          <WatchrailLogo compact />
          <div className="min-w-0">
            <OrgSwitcher workspaceId={workspaceId} />
          </div>
          <ProjectSwitcher projectId={projectId} />
          <div className="ml-auto flex items-center gap-2">
            <GlobalSearch />
            <div className="lg:hidden">
              <MobileNavigation
                page={page}
                projectId={projectId}
                workspaceId={workspaceId}
                monitorType={monitorType}
              />
            </div>
          </div>
        </div>
      </header>

      <div
        className={`min-h-[calc(100vh-3rem)] transition-[grid-template-columns] duration-200 ease-out lg:grid ${sidebarCollapsed ? 'lg:grid-cols-[56px_minmax(0,1fr)]' : 'lg:grid-cols-[220px_minmax(0,1fr)]'}`}
      >
        <aside
          className={`sticky top-12 hidden h-[calc(100vh-3rem)] flex-col overflow-x-hidden border-r border-rail-border bg-rail-sidebar pt-3 pb-3 transition-[padding] duration-200 ease-out lg:flex ${sidebarCollapsed ? 'px-2' : 'px-3'}`}
          aria-label="Workspace"
        >
          <Navigation
            page={page}
            projectId={projectId}
            workspaceId={workspaceId}
            collapsed={sidebarCollapsed}
            monitorType={monitorType}
          />
          <div className="mt-auto">
            <button
              type="button"
              className={`group flex min-h-9 w-full appearance-none items-center border-0 bg-transparent p-0 text-[13px] text-rail-muted transition-colors hover:text-rail-text ${sidebarCollapsed ? 'justify-center' : 'justify-end'}`}
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!sidebarCollapsed}
              onClick={toggleSidebar}
              title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              <span
                className={`grid size-8 place-items-center rounded-rail-control transition-[color,background-color,transform] duration-200 group-hover:bg-rail-hover ${sidebarCollapsed ? 'rotate-180' : ''}`}
              >
                <ShellIcon name="sidebar-control" />
              </span>
            </button>
          </div>
        </aside>

        <div className="min-w-0">
          <div className="mx-auto max-w-[1700px] min-w-0 px-4 pb-16 sm:px-6 lg:px-10 xl:px-16">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
