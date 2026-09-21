import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dashboard } from './dashboard';

describe('Dashboard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the empty state and creates a monitor', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              id: 'monitor-1',
              name: 'Production API',
              url: 'https://example.com/health',
              method: 'GET',
              lifecycleState: 'ENABLED',
              timeoutMs: 10_000,
              locations: ['local'],
              createdAt: new Date().toISOString(),
            },
          }),
          { status: 201 },
        ),
      );

    render(<Dashboard />);
    expect(await screen.findByText('No monitors yet')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Monitor name'), 'Production API');
    await userEvent.type(screen.getByLabelText('HTTP(S) URL'), 'https://example.com/health');
    await userEvent.click(screen.getByRole('button', { name: 'Create monitor' }));

    expect(await screen.findByRole('heading', { name: 'Production API' })).toBeInTheDocument();
    expect(screen.getByText('10s timeout')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/monitors',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('renders field-level validation errors from the API', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 'VALIDATION_FAILED',
            fields: { name: ['Enter a monitor name.'], url: ['Enter a valid absolute URL.'] },
          }),
          { status: 400 },
        ),
      );

    render(<Dashboard />);
    await screen.findByText('No monitors yet');
    await userEvent.click(screen.getByRole('button', { name: 'Create monitor' }));

    await waitFor(() => {
      expect(screen.getByText('Enter a monitor name.')).toBeInTheDocument();
      expect(screen.getByText('Enter a valid absolute URL.')).toBeInTheDocument();
    });
  });
});
