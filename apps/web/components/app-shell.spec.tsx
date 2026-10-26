import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppShell } from './app-shell';

vi.mock('./org-switcher', () => ({
  OrgSwitcher: () => <button type="button">Acme workspace</button>,
}));

describe('AppShell', () => {
  it('marks the current workspace page and keeps creation separate from navigation', () => {
    render(
      <AppShell page="overview">
        <main id="main-content">
          <h1>Dashboard</h1>
        </main>
      </AppShell>,
    );

    expect(screen.getByRole('navigation', { name: 'Workspace navigation' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Overview' })[0]).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getAllByRole('link', { name: 'New monitor' })[0]).toHaveAttribute(
      'href',
      '/monitors/new',
    );
    expect(screen.getAllByRole('link', { name: 'Monitors' })[0]).toHaveAttribute(
      'href',
      '/monitors',
    );
    expect(screen.getByRole('main')).toContainElement(
      screen.getByRole('heading', { name: 'Dashboard' }),
    );
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  it('collapses the sidebar directly without removing accessible link names', async () => {
    const user = userEvent.setup();
    render(
      <AppShell page="overview">
        <main id="main-content">Overview</main>
      </AppShell>,
    );

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));

    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getAllByRole('link', { name: 'Monitors' })[0]).toBeInTheDocument();
    expect(window.localStorage.getItem('watchrail.sidebar-collapsed')).toBe('true');
  });

  it('provides a compact mobile navigation disclosure that closes after navigation', async () => {
    const user = userEvent.setup();
    render(
      <AppShell page="organization">
        <main id="main-content">
          <p>Settings</p>
        </main>
      </AppShell>,
    );

    const trigger = screen.getByRole('button', { name: 'Open workspace navigation' });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('link', { name: 'Organization' })[0]).toHaveAttribute(
      'aria-current',
      'page',
    );
    await user.click(screen.getAllByRole('link', { name: 'Monitors' })[1]!);
    expect(screen.getByRole('button', { name: 'Open workspace navigation' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('opens the UI-only workspace search without presenting invented results', async () => {
    const user = userEvent.setup();
    render(
      <AppShell page="overview">
        <main id="main-content">Overview</main>
      </AppShell>,
    );

    await user.click(screen.getByRole('button', { name: 'Search Watchrail' }));
    expect(screen.getByRole('dialog', { name: 'Search Watchrail' })).toBeInTheDocument();
    expect(screen.getByText('Workspace-wide search is coming soon.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close search' }));
    expect(screen.queryByRole('dialog', { name: 'Search Watchrail' })).not.toBeInTheDocument();
  });
});
