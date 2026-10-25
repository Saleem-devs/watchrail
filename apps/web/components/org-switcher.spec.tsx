import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrgSwitcher } from './org-switcher';

const { push, refresh, list, setActive, signOut } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  list: vi.fn(),
  setActive: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
}));

vi.mock('../lib/auth-client', () => ({
  authClient: {
    useSession: () => ({
      data: {
        user: { name: 'Saleem' },
        session: { activeOrganizationId: 'org-1' },
      },
    }),
    organization: { list, setActive },
    signOut,
  },
}));

describe('OrgSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue({
      data: [
        { id: 'org-1', name: 'Watchrail', slug: 'watchrail' },
        { id: 'org-2', name: 'Operations', slug: 'operations' },
      ],
    });
  });

  it('exposes organization choices and account actions as native controls', async () => {
    const user = userEvent.setup();
    render(<OrgSwitcher />);

    const trigger = await screen.findByRole('button', { name: /Watchrail/i });
    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const switcher = screen.getByRole('group', { name: 'Organization switcher' });
    expect(switcher).toBeInTheDocument();
    expect(within(switcher).getByRole('button', { name: 'Watchrail' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('link', { name: 'Organization settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('closes on Escape and restores focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<OrgSwitcher />);

    const trigger = await screen.findByRole('button', { name: /Watchrail/i });
    await user.click(trigger);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('group', { name: 'Organization switcher' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('reloads only after Better Auth confirms the organization switch', async () => {
    const user = userEvent.setup();
    const reload = vi.fn();
    setActive.mockResolvedValue({ data: {}, error: null });
    render(<OrgSwitcher reload={reload} />);

    await user.click(await screen.findByRole('button', { name: /Watchrail/i }));
    await user.click(screen.getByRole('button', { name: 'Operations' }));

    expect(setActive).toHaveBeenCalledWith({ organizationId: 'org-2' });
    expect(reload).toHaveBeenCalledOnce();
    expect(screen.queryByRole('group', { name: 'Organization switcher' })).not.toBeInTheDocument();
  });

  it('keeps the switcher open and announces a failed organization switch', async () => {
    const user = userEvent.setup();
    const reload = vi.fn();
    setActive.mockResolvedValue({ data: null, error: { message: 'Forbidden' } });
    render(<OrgSwitcher reload={reload} />);

    await user.click(await screen.findByRole('button', { name: /Watchrail/i }));
    await user.click(screen.getByRole('button', { name: 'Operations' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not switch organizations. Try again.',
    );
    expect(screen.getByRole('group', { name: 'Organization switcher' })).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });
});
