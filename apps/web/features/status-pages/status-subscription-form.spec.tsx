import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusSubscriptionForm, StatusSubscriptionAction } from './status-subscription-form';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});
describe('public status subscription', () => {
  it('submits email without credentials and renders a generic confirmation', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: 'Check your inbox.' }),
    });
    vi.stubGlobal('fetch', fetch);
    render(<StatusSubscriptionForm slug="service" />);
    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'visitor@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Subscribe to updates' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Check your inbox.'));
    expect(fetch).toHaveBeenCalledWith(
      '/api/public/status-subscriptions',
      expect.objectContaining({
        credentials: 'omit',
        body: JSON.stringify({ slug: 'service', email: 'visitor@example.com' }),
      }),
    );
  });
  it('does not unsubscribe from a GET or link preview; requires an explicit action', async () => {
    window.location.hash = `unsubscribe=${'u'.repeat(43)}`;
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({ message: 'Unsubscribed.' }) });
    vi.stubGlobal('fetch', fetch);
    render(<StatusSubscriptionAction />);
    const button = await screen.findByRole('button', { name: 'Unsubscribe' });
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Unsubscribed.'));
    expect(window.location.hash).toBe('');
  });
  it('shows actionable errors and allows retry', async () => {
    window.location.hash = `verify=${'v'.repeat(43)}`;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ message: 'This link has expired. Subscribe again.' }),
      }),
    );
    render(<StatusSubscriptionAction />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm subscription' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('expired'));
    expect(screen.getByRole('button', { name: 'Confirm subscription' })).not.toBeDisabled();
  });

  it('resets a completed confirmation when another email link opens in the same tab', async () => {
    window.location.hash = `verify=${'v'.repeat(43)}`;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ message: 'Confirmed.', statusPageSlug: 'service' }),
        }),
    );
    render(<StatusSubscriptionAction />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm subscription' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Confirmed.'));
    expect(screen.getByRole('link', { name: 'Back to status page' })).toHaveAttribute(
      'href',
      '/status/service',
    );
    window.location.hash = `unsubscribe=${'u'.repeat(43)}`;
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(await screen.findByRole('button', { name: 'Unsubscribe' })).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
