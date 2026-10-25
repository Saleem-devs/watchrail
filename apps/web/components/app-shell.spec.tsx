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
        <h1>Dashboard</h1>
      </AppShell>,
    );

    expect(screen.getByRole('navigation', { name: 'Workspace navigation' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Overview' })[0]).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getAllByRole('link', { name: 'Add monitor' })[0]).toHaveAttribute(
      'href',
      '/#create-monitor',
    );
    expect(screen.getByRole('main')).toContainElement(
      screen.getByRole('heading', { name: 'Dashboard' }),
    );
  });

  it('provides a compact mobile navigation disclosure that closes after navigation', async () => {
    const user = userEvent.setup();
    render(
      <AppShell page="organization">
        <p>Settings</p>
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
});
