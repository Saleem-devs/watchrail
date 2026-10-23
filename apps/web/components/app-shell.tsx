import Link from 'next/link';
import type { ReactNode } from 'react';
import { OrgSwitcher } from './org-switcher';
import styles from './app-shell.module.css';

type Page = 'overview' | 'organization';

interface AppShellProps {
  children: ReactNode;
  page: Page;
}

const navigation = [
  { name: 'Overview', href: '/', page: 'overview' },
  { name: 'Monitors', href: '/#monitor-inventory', page: null },
  { name: 'New monitor', href: '/#create-monitor', page: null },
  { name: 'Organization', href: '/settings/organization', page: 'organization' },
] as const;

function Navigation({ page }: { page: Page }) {
  return (
    <nav className={styles.navigation} aria-label="Workspace navigation">
      <span className={styles.navCaption}>Workspace</span>
      {navigation.map((item) => (
        <Link
          key={item.name}
          href={item.href}
          className={styles.navLink}
          aria-current={item.page === page ? 'page' : undefined}
        >
          <span className={styles.navGlyph} aria-hidden="true">
            {item.name === 'Overview'
              ? '◫'
              : item.name === 'Monitors'
                ? '⌁'
                : item.name === 'New monitor'
                  ? '+'
                  : '⚙'}
          </span>
          <span>{item.name}</span>
        </Link>
      ))}
    </nav>
  );
}

export function AppShell({ children, page }: AppShellProps) {
  const title = page === 'overview' ? 'Overview' : 'Organization';
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar} aria-label="Workspace">
        <Link href="/" className={styles.brand} aria-label="Watchrail home">
          <span className={styles.brandMark} aria-hidden="true">
            <svg viewBox="0 0 32 32" fill="none" focusable="false">
              <path d="M3 19h7l4-9 5 15 4-8h6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span>watchrail<span className={styles.brandDot}>.</span></span>
        </Link>
        <Navigation page={page} />
        <div className={styles.sidebarFooter}>
          <span className={styles.liveIndicator} aria-hidden="true" />
          Open-source monitoring
        </div>
      </aside>
      <div className={styles.workspace}>
        <header className={styles.topbar}>
          <div className={styles.breadcrumb}>
            <span>Workspace</span>
            <span className={styles.breadcrumbDivider} aria-hidden="true">/</span>
            <strong>{title}</strong>
          </div>
          <OrgSwitcher />
        </header>
        <div className={styles.mobileNavigation}>
          <Navigation page={page} />
        </div>
        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
