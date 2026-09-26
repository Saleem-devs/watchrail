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
              followRedirects: true,
              statusPolicy: { type: 'ANY_2XX' },
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

  it('runs a manual diagnostic and replaces its pending state with the result', async () => {
    const monitor = {
      id: 'monitor-1',
      name: 'Production API',
      url: 'https://example.com/health',
      method: 'GET',
      lifecycleState: 'ENABLED',
      timeoutMs: 10_000,
      followRedirects: true,
      statusPolicy: { type: 'ANY_2XX' },
      locations: ['local'],
      createdAt: new Date().toISOString(),
    };
    const round = {
      id: 'round-1',
      monitorId: monitor.id,
      status: 'PENDING',
      assignmentStatus: 'PENDING',
      createdAt: new Date().toISOString(),
      result: null,
    };

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [monitor] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: round }), { status: 202 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              ...round,
              status: 'COMPLETED',
              assignmentStatus: 'COMPLETED',
              result: {
                outcome: 'PASS',
                stage: 'HTTP',
                reason: 'COMPLETED',
                statusCode: 200,
                responseTimeMs: 42.5,
                attemptDurationMs: 46.25,
                redirects: [
                  {
                    sequence: 1,
                    statusCode: 302,
                    source: { targetId: 1, origin: 'https://example.com:443' },
                    destination: { targetId: 2, origin: 'https://status.example:443' },
                    responseTimeMs: 12.25,
                    headers: 'STRIPPED',
                  },
                ],
                checkedAt: '2026-09-24T12:00:00.000Z',
              },
            },
          }),
          { status: 200 },
        ),
      );

    render(<Dashboard />);
    await screen.findByRole('heading', { name: monitor.name });

    await userEvent.click(screen.getByRole('button', { name: 'Run now' }));

    expect(await screen.findByText('Queued')).toBeInTheDocument();
    expect(await screen.findByText('PASS', {}, { timeout: 2_000 })).toBeInTheDocument();
    expect(screen.getByText('200')).toBeInTheDocument();
    expect(screen.getByText('43 ms')).toBeInTheDocument();
    expect(screen.getByText('46 ms')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Redirect chain' })).toHaveTextContent(
      '#1 https://example.com:443 → #2 https://status.example:443',
    );
    expect(screen.getByRole('list', { name: 'Redirect chain' })).toHaveTextContent(
      '302 · 12 ms · stripped',
    );
    expect(screen.getByRole('button', { name: 'Run now' })).toBeEnabled();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/monitors/monitor-1/check-rounds',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/monitors/monitor-1/check-rounds/round-1',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
  });

  it('updates a monitor to an exact status policy', async () => {
    const monitor = {
      id: 'monitor-1',
      name: 'Maintenance endpoint',
      url: 'https://example.com/health',
      method: 'GET',
      lifecycleState: 'ENABLED',
      timeoutMs: 10_000,
      followRedirects: true,
      statusPolicy: { type: 'ANY_2XX' },
      locations: ['local'],
      createdAt: new Date().toISOString(),
    };
    const updated = {
      ...monitor,
      statusPolicy: { type: 'EXACT', statusCodes: [404] },
    };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [monitor] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: updated }), { status: 200 }));

    render(<Dashboard />);
    await screen.findByRole('heading', { name: monitor.name });

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Expected status' }),
      'EXACT',
    );
    const codes = screen.getByLabelText(`Specific status codes for ${monitor.name}`);
    await userEvent.type(codes, '404');
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    expect(await screen.findByText('status 404')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/monitors/monitor-1/status-policy',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ statusPolicy: { type: 'EXACT', statusCodes: [404] } }),
      }),
    );
  });

  it('updates the complete HTTP settings object', async () => {
    const monitor = {
      id: 'monitor-1',
      name: 'Production API',
      url: 'https://old.example.com/health',
      method: 'GET',
      lifecycleState: 'ENABLED',
      timeoutMs: 10_000,
      followRedirects: true,
      statusPolicy: { type: 'ANY_2XX' },
      locations: ['local'],
      createdAt: new Date().toISOString(),
    };
    const updated = {
      ...monitor,
      url: 'https://new.example.com/ready',
      method: 'HEAD',
      timeoutMs: 5_000,
      followRedirects: false,
    };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [monitor] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: updated }), { status: 200 }));

    render(<Dashboard />);
    await screen.findByRole('heading', { name: monitor.name });

    const url = screen.getByRole('textbox', { name: 'URL' });
    await userEvent.clear(url);
    await userEvent.type(url, updated.url);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Method' }), 'HEAD');
    const timeout = screen.getByRole('spinbutton', { name: 'Timeout (seconds)' });
    await userEvent.clear(timeout);
    await userEvent.type(timeout, '5');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Follow redirects' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save HTTP settings' }));

    expect(await screen.findByText('redirects final')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/monitors/monitor-1/http-settings',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          url: updated.url,
          method: 'HEAD',
          timeoutMs: 5_000,
          followRedirects: false,
        }),
      }),
    );
  });
});
