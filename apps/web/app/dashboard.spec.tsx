import { render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dashboard } from './dashboard';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock('../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

describe('Dashboard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not present a failed monitor load as an empty workspace', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('API unavailable'));

    render(<Dashboard />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Watchrail could not load your monitors',
    );
    expect(screen.getByText('Monitor inventory is unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('No monitors yet')).not.toBeInTheDocument();
  });

  it.each([
    [99.94, 98.7, '99.94%', '98.70%'],
    [null, 0, '—', '0.00%'],
    [null, null, '—', '—'],
  ])(
    'shows separate uptime and coverage without turning null into 100%%',
    async (uptimePercent, coveragePercent, uptimeText, coverageText) => {
      const monitor = {
        id: 'metrics-monitor',
        name: 'Metrics monitor',
        url: 'https://example.com',
        method: 'GET',
        lifecycleState: 'ENABLED',
        timeoutMs: 10000,
        followRedirects: true,
        statusPolicy: { type: 'ANY_2XX' },
        locations: ['local'],
        createdAt: new Date().toISOString(),
        currentCheck: null,
        incidentState: { failureStreak: null, currentIncident: null },
        uptime: { uptimePercent, coveragePercent },
      };
      vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ data: [monitor] }), { status: 200 })),
      );
      const first = render(<Dashboard />);
      const group = await screen.findByLabelText('Uptime metrics for Metrics monitor');
      const values = group.querySelectorAll('dd');
      expect(within(group).getByText('7-day uptime')).toBeInTheDocument();
      expect(values[0]).toHaveTextContent(uptimeText);
      expect(values[1]).toHaveTextContent(coverageText);
      first.unmount();
      render(<Dashboard />);
      const reloaded = await screen.findByLabelText('Uptime metrics for Metrics monitor');
      expect(reloaded.querySelectorAll('dd')[0]).toHaveTextContent(uptimeText);
      expect(reloaded.querySelectorAll('dd')[1]).toHaveTextContent(coverageText);
    },
  );

  it('creates a monitor from the dedicated creation view', async () => {
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

    render(<Dashboard view="create" />);
    expect(await screen.findByRole('heading', { name: 'Create monitor' })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Monitor name'), 'Production API');
    await userEvent.type(
      screen.getByRole('textbox', { name: /HTTP\(S\) URL/i }),
      'https://example.com/health',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save monitor' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Production API is ready for its first check.',
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/monitors',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('creates a TCP monitor with protocol-specific fields and no HTTP payload', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              id: 'tcp-monitor-1',
              type: 'TCP',
              name: 'Primary database',
              url: '',
              configuration: { type: 'TCP', host: 'db.example.com', port: 5432 },
              method: 'GET',
              lifecycleState: 'ENABLED',
              timeoutMs: 8_000,
              followRedirects: false,
              statusPolicy: { type: 'ANY_2XX' },
              locations: ['local'],
              createdAt: new Date().toISOString(),
            },
          }),
          { status: 201 },
        ),
      );

    render(<Dashboard view="create" />);
    await screen.findByRole('heading', { name: 'Create monitor' });
    await userEvent.click(screen.getByText('TCP port'));
    expect(screen.queryByRole('button', { name: 'Test configuration' })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Monitor name'), 'Primary database');
    await userEvent.type(await screen.findByLabelText(/Hostname or IP address/), 'db.example.com');
    const port = screen.getByLabelText('Port');
    await userEvent.clear(port);
    await userEvent.type(port, '5432');
    const timeout = screen.getByLabelText(/Timeout/);
    await userEvent.clear(timeout);
    await userEvent.type(timeout, '8');
    await userEvent.click(screen.getByRole('button', { name: 'Save monitor' }));

    const request = fetchMock.mock.calls.at(-1)?.[1];
    if (typeof request?.body !== 'string') throw new Error('Expected a JSON request body.');
    expect(JSON.parse(request.body)).toEqual({
      type: 'TCP',
      name: 'Primary database',
      host: 'db.example.com',
      port: 5432,
      timeoutMs: 8_000,
      locations: ['local'],
      lifecycleState: 'ENABLED',
    });
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Primary database is ready for its first check.',
    );
  });

  it('presents a paused monitor neutrally despite a successful historical check', async () => {
    const monitor = {
      id: 'paused-monitor',
      name: 'Paused API',
      url: 'https://example.com/health',
      method: 'GET',
      lifecycleState: 'PAUSED',
      timeoutMs: 10_000,
      followRedirects: true,
      statusPolicy: { type: 'ANY_2XX' },
      locations: ['local'],
      createdAt: new Date().toISOString(),
      currentCheck: {
        availability: 'AVAILABLE',
        responseTimeMs: 42,
        checkedAt: '2026-09-24T12:00:00.000Z',
        roundId: 'round-1',
        trigger: 'SCHEDULED',
      },
      incidentState: { failureStreak: null, currentIncident: null },
      uptime: { uptimePercent: 100, coveragePercent: 100 },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [monitor] }), { status: 200 }),
    );

    render(<Dashboard />);

    const status = await screen.findByLabelText('Monitoring paused');
    expect(status).toHaveAttribute('data-monitor-status', 'PAUSED');
    expect(screen.queryByLabelText('Current availability: available')).not.toBeInTheDocument();
  });

  it('refreshes time-sensitive probe health whenever the location selector is reopened', async () => {
    const monitor = {
      id: 'location-monitor',
      name: 'Location monitor',
      url: 'https://example.com',
      method: 'GET',
      lifecycleState: 'ENABLED',
      timeoutMs: 10_000,
      followRedirects: true,
      statusPolicy: { type: 'ANY_2XX' },
      locations: ['local'],
      createdAt: new Date().toISOString(),
      currentCheck: null,
      incidentState: { failureStreak: null, currentIncident: null },
      uptime: { uptimePercent: null, coveragePercent: null },
    };
    const online = {
      id: 'location-1',
      name: 'Lagos',
      status: 'ACTIVE',
      health: 'ONLINE',
      activeAgentCount: 1,
    };
    const offline = { ...online, health: 'OFFLINE' };
    let resolveOnline: (response: Response) => void = () => undefined;
    const firstLocationRequest = new Promise<Response>((resolve) => {
      resolveOnline = resolve;
    });
    let locationRequestCount = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (requestUrl(input) !== '/api/probe-locations') {
        return Promise.resolve(new Response(JSON.stringify({ data: [monitor] }), { status: 200 }));
      }
      locationRequestCount += 1;
      return locationRequestCount === 1
        ? firstLocationRequest
        : Promise.resolve(new Response(JSON.stringify({ data: [offline] }), { status: 200 }));
    });

    render(<Dashboard />);
    await screen.findByRole('heading', { name: monitor.name });
    await userEvent.click(screen.getByText('Configure monitor'));
    const selector = await screen.findByRole('combobox', { name: 'Execution location' });
    await userEvent.click(selector);
    resolveOnline(new Response(JSON.stringify({ data: [online] }), { status: 200 }));
    expect(await screen.findByRole('option', { name: /Lagos/ })).toHaveTextContent(
      'Lagos — online',
    );
    const requestsAfterFirstOpen = fetchMock.mock.calls.filter(
      ([url]) => url === '/api/probe-locations',
    ).length;
    await userEvent.keyboard('{Escape}');
    await userEvent.click(selector);
    expect(await screen.findByRole('option', { name: /Lagos/ })).toHaveTextContent(
      'Lagos — offline',
    );
    expect(
      fetchMock.mock.calls.filter(([url]) => url === '/api/probe-locations').length,
    ).toBeGreaterThan(requestsAfterFirstOpen);
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

    render(<Dashboard view="create" />);
    await screen.findByRole('heading', { name: 'Create monitor' });
    await userEvent.click(screen.getByRole('button', { name: 'Save monitor' }));

    await waitFor(() => {
      expect(screen.getByText('Enter a monitor name.')).toBeInTheDocument();
      expect(screen.getByText('Enter a valid absolute URL.')).toBeInTheDocument();
    });
  });

  it('removes a completed configuration-test result when the form changes', async () => {
    const projectId = '00000000-0000-4000-8000-000000000003';
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === '/api/projects') return Promise.resolve(projectListResponse(projectId));
      return Promise.resolve(
        url.includes('/test-configuration')
          ? configurationTestResponse()
          : new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    });

    render(<Dashboard view="create" projectId={projectId} />);
    const urlInput = await screen.findByRole('textbox', { name: /HTTP\(S\) URL/i });
    await userEvent.type(screen.getByRole('textbox', { name: 'Monitor name' }), 'Production API');
    await userEvent.type(urlInput, 'https://status.watchrail.app/health');
    await userEvent.click(screen.getByRole('button', { name: 'Test configuration' }));

    expect(await screen.findByLabelText('Configuration test result')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: /HTTP\(S\) URL/i }), '?version=2');
    expect(screen.queryByLabelText('Configuration test result')).not.toBeInTheDocument();
  });

  it('ignores an in-flight configuration-test response after the form changes', async () => {
    const projectId = '00000000-0000-4000-8000-000000000003';
    let resolveTest: (response: Response) => void = () => undefined;
    const pendingTest = new Promise<Response>((resolve) => {
      resolveTest = resolve;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === '/api/projects') return Promise.resolve(projectListResponse(projectId));
      return url.includes('/test-configuration')
        ? pendingTest
        : Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    });

    render(<Dashboard view="create" projectId={projectId} />);
    const urlInput = await screen.findByRole('textbox', { name: /HTTP\(S\) URL/i });
    await userEvent.type(screen.getByRole('textbox', { name: 'Monitor name' }), 'Production API');
    await userEvent.type(urlInput, 'https://status.watchrail.app/health');
    await userEvent.click(screen.getByRole('button', { name: 'Test configuration' }));
    expect(screen.getByRole('button', { name: 'Testing…' })).toBeDisabled();

    await userEvent.type(screen.getByRole('textbox', { name: /HTTP\(S\) URL/i }), '?version=2');
    expect(screen.getByRole('button', { name: 'Test configuration' })).toBeEnabled();
    resolveTest(configurationTestResponse());
    await waitFor(() => {
      expect(screen.queryByLabelText('Configuration test result')).not.toBeInTheDocument();
    });
  });

  it('invalidates configuration-test results for custom selects and dynamic assertion rows', async () => {
    const projectId = '00000000-0000-4000-8000-000000000003';
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === '/api/projects') return Promise.resolve(projectListResponse(projectId));
      return Promise.resolve(
        url.includes('/test-configuration')
          ? configurationTestResponse()
          : new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    });

    render(<Dashboard view="create" projectId={projectId} />);
    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Monitor name' }),
      'Production API',
    );
    await userEvent.type(
      screen.getByRole('textbox', { name: /HTTP\(S\) URL/i }),
      'https://status.watchrail.app/health',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Test configuration' }));
    expect(await screen.findByLabelText('Configuration test result')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('combobox', { name: 'Method' }));
    await userEvent.click(screen.getByRole('option', { name: 'HEAD' }));
    expect(screen.queryByLabelText('Configuration test result')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('combobox', { name: 'Method' }));
    await userEvent.click(screen.getByRole('option', { name: 'GET' }));
    await userEvent.click(screen.getByRole('button', { name: 'Test configuration' }));
    expect(await screen.findByLabelText('Configuration test result')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add text' }));
    expect(screen.getByText('Text body')).toBeInTheDocument();
    expect(screen.queryByLabelText('Configuration test result')).not.toBeInTheDocument();
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
      currentCheck: null,
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
                assertionEvaluation: {
                  contractVersion: 1,
                  outcome: 'PASS',
                  diagnostics: [],
                },
              },
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                ...monitor,
                currentCheck: {
                  availability: 'AVAILABLE',
                  responseTimeMs: 42.5,
                  checkedAt: '2026-09-24T12:00:00.000Z',
                  roundId: round.id,
                  trigger: 'MANUAL',
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );

    render(<Dashboard />);
    await screen.findByRole('heading', { name: monitor.name });

    await userEvent.click(screen.getByRole('button', { name: 'Run now' }));

    expect(await screen.findByText('Queued')).toBeInTheDocument();
    expect(
      await within(screen.getByLabelText('Latest manual diagnostic')).findAllByText(
        'Healthy',
        {},
        { timeout: 2_000 },
      ),
    ).not.toHaveLength(0);
    expect(screen.getByText('200')).toBeInTheDocument();
    expect(screen.getByText('43 ms')).toBeInTheDocument();
    expect(screen.getByText('46 ms')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Redirect chain' })).toHaveTextContent(
      '#1 https://example.com:443',
    );
    expect(screen.getByRole('list', { name: 'Redirect chain' })).toHaveTextContent(
      '#2 https://status.example:443',
    );
    expect(screen.getByRole('list', { name: 'Redirect chain' })).toHaveTextContent(
      '302 · 12 ms · stripped',
    );
    expect(screen.getByRole('button', { name: 'Run now' })).toBeEnabled();
    expect(await screen.findByLabelText('Current availability: available')).toBeInTheDocument();
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

  it('renders durable current availability after reload and lazily loads mixed history', async () => {
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
      currentCheck: {
        availability: 'UNAVAILABLE',
        responseTimeMs: 91,
        checkedAt: '2026-09-24T12:00:00.000Z',
        roundId: 'scheduled-round',
        trigger: 'SCHEDULED',
      },
      incidentState: {
        failureStreak: {
          count: 2,
          threshold: 3,
          startedAt: '2026-09-24T11:59:00.000Z',
          startedByRoundId: 'scheduled-round-previous',
        },
        currentIncident: null,
      },
    };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [monitor] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'scheduled-round',
                monitorId: monitor.id,
                trigger: 'SCHEDULED',
                status: 'COMPLETED',
                assignmentStatus: 'COMPLETED',
                createdAt: monitor.currentCheck.checkedAt,
                result: {
                  outcome: 'FAIL',
                  stage: 'HTTP',
                  reason: 'UNEXPECTED_STATUS',
                  statusCode: 503,
                  responseTimeMs: 91,
                  attemptDurationMs: 94,
                  assertionOutcome: 'PASS',
                  checkedAt: monitor.currentCheck.checkedAt,
                },
              },
            ],
            page: { nextCursor: null },
          }),
          { status: 200 },
        ),
      );

    render(<Dashboard />);
    expect(await screen.findByLabelText('Current availability: unavailable')).toBeInTheDocument();
    expect(screen.getByText('No manual diagnostic started.')).toBeInTheDocument();
    expect(screen.getByLabelText('Incident state')).toHaveTextContent(
      'Incident watch: Failure 2/3',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Show history' }));
    expect(await screen.findByRole('region', { name: 'Check history' })).toHaveTextContent(
      'SCHEDULED Unhealthy · UNEXPECTED_STATUS',
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/monitors/monitor-1/check-rounds?limit=10',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
  });

  it('renders one aggregate current state and history row for a multi-location round', async () => {
    const checkedAt = '2026-10-17T12:00:00.000Z';
    const monitor = {
      id: 'monitor-1',
      name: 'Regional API',
      url: 'https://example.com/health',
      method: 'GET',
      lifecycleState: 'ENABLED',
      timeoutMs: 10_000,
      followRedirects: true,
      statusPolicy: { type: 'ANY_2XX' },
      locations: ['location-a', 'location-b', 'location-c'],
      createdAt: checkedAt,
      currentCheck: {
        kind: 'MULTI_LOCATION',
        availability: 'UNAVAILABLE',
        aggregateOutcome: 'DEGRADED',
        coverage: { numerator: 3, denominator: 3 },
        reachability: { numerator: 2, denominator: 3 },
        responseTimeMs: null,
        checkedAt,
        roundId: 'regional-round',
        trigger: 'SCHEDULED',
      },
      incidentState: {
        failureStreak: null,
        currentIncident: {
          id: 'incident-1',
          status: 'OPEN',
          startedAt: checkedAt,
          openedAt: checkedAt,
          startedByRoundId: 'regional-round',
          openedByRoundId: 'regional-round',
        },
        multiLocationIncident: {
          severity: 'DEGRADED',
          healthyRecoveryStreak: 1,
          healthyRecoveryThreshold: 2,
        },
      },
      uptime: { uptimePercent: null, coveragePercent: null },
    };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [monitor] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'regional-round',
                monitorId: monitor.id,
                trigger: 'SCHEDULED',
                status: 'COMPLETED',
                assignmentStatus: 'COMPLETED',
                createdAt: checkedAt,
                result: {
                  kind: 'MULTI_LOCATION',
                  outcome: 'DEGRADED',
                  coverage: { numerator: 3, denominator: 3 },
                  reachability: { numerator: 2, denominator: 3 },
                  finalizedAt: checkedAt,
                },
              },
            ],
            page: { nextCursor: null },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              id: 'regional-round',
              monitorId: monitor.id,
              trigger: 'SCHEDULED',
              status: 'COMPLETED',
              assignmentStatus: 'COMPLETED',
              createdAt: checkedAt,
              result: {
                kind: 'MULTI_LOCATION',
                outcome: 'DEGRADED',
                counts: {
                  selected: 3,
                  pass: 2,
                  confirmedFail: 1,
                  unknown: 0,
                  conclusive: 3,
                },
                coverage: { numerator: 3, denominator: 3 },
                reachability: { numerator: 2, denominator: 3 },
                finalizedAt: checkedAt,
                regions: [
                  {
                    location: 'Lagos',
                    phase: 'TERMINAL',
                    outcome: 'CONFIRMED_FAIL',
                    terminalReason: 'CONFIRMED_FAILURE',
                    executions: [
                      {
                        id: 'execution-1',
                        role: 'PRIMARY',
                        diagnosticSummary: {
                          stage: 'HTTP',
                          reason: 'UNEXPECTED_STATUS',
                          statusCode: 503,
                          responseTimeMs: 41,
                          attemptDurationMs: 44,
                          checkedAt,
                        },
                      },
                    ],
                  },
                ],
              },
            },
          }),
          { status: 200 },
        ),
      );

    render(<Dashboard />);
    expect(await screen.findByLabelText('Current aggregate health: degraded')).toBeInTheDocument();
    const aggregate = screen.getByLabelText('Latest regional aggregate for Regional API');
    expect(aggregate).toHaveTextContent('DEGRADED');
    expect(aggregate).toHaveTextContent('100.0%');
    expect(aggregate).toHaveTextContent('66.7%');
    expect(screen.getByLabelText('Incident state')).toHaveTextContent('Incident: PARTIAL OUTAGE');
    expect(screen.getByLabelText('Incident state')).toHaveTextContent(
      'Recovery 1/2 healthy rounds',
    );
    expect(screen.getByLabelText('Incident state')).not.toHaveTextContent('consecutive failures');

    await userEvent.click(screen.getByRole('button', { name: 'Show history' }));
    expect(await screen.findByRole('region', { name: 'Check history' })).toHaveTextContent(
      'SCHEDULED DEGRADED · 100.0%',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Show diagnostic evidence' }));
    const evidence = await screen.findByText('Historical regional evidence');
    const evidencePanel = evidence.closest('.manual-diagnostic');
    expect(evidencePanel).toHaveTextContent('Lagos');
    expect(evidencePanel).toHaveTextContent('Confirmed failure');
    expect(evidencePanel).toHaveTextContent('primary · HTTP 503 · 41 ms');
    await userEvent.click(screen.getByRole('button', { name: 'Hide diagnostic evidence' }));
    await userEvent.click(screen.getByRole('button', { name: 'Show diagnostic evidence' }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('prevents duplicate incident-history pagination requests', async () => {
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
      currentCheck: null,
      incidentState: { failureStreak: null, currentIncident: null },
    };
    let resolveNextPage: (response: Response) => void = () => undefined;
    const nextPage = new Promise<Response>((resolve) => {
      resolveNextPage = resolve;
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [monitor] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'incident-2',
                status: 'RESOLVED',
                startedAt: '2026-09-24T12:00:00.000Z',
                openedAt: '2026-09-24T12:02:00.000Z',
                resolvedAt: '2026-09-24T12:04:00.000Z',
              },
            ],
            page: { nextCursor: 'cursor-1' },
          }),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(() => nextPage);

    render(<Dashboard />);
    await screen.findByRole('heading', { name: monitor.name });
    await userEvent.click(screen.getByRole('button', { name: 'Show incident history' }));
    const loadMore = await screen.findByRole('button', { name: 'Load more' });
    loadMore.click();
    loadMore.click();

    expect(
      fetchMock.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('/incidents?limit=10&cursor=cursor-1'),
      ),
    ).toHaveLength(1);
    await waitFor(() => expect(loadMore).toBeDisabled());

    resolveNextPage(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'incident-1',
              status: 'RESOLVED',
              startedAt: '2026-09-23T12:00:00.000Z',
              openedAt: '2026-09-23T12:02:00.000Z',
              resolvedAt: '2026-09-23T12:04:00.000Z',
            },
          ],
          page: { nextCursor: null },
        }),
        { status: 200 },
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('region', { name: 'Incident history' }).querySelectorAll('li'),
      ).toHaveLength(2),
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
    await userEvent.click(screen.getByText('Configure monitor'));

    await userEvent.click(screen.getByRole('combobox', { name: 'Expected status' }));
    await userEvent.click(screen.getByRole('option', { name: 'Specific status codes' }));
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

  it('keeps loaded monitors visible when a configuration update fails', async () => {
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
      currentCheck: null,
      incidentState: { failureStreak: null, currentIncident: null },
      uptime: { uptimePercent: null, coveragePercent: null },
    };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [monitor] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 500 }));

    render(<Dashboard />);
    await screen.findByRole('heading', { name: monitor.name });
    await userEvent.click(screen.getByText('Configure monitor'));
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not update status policy.');
    expect(screen.getByRole('heading', { name: monitor.name })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Monitor overview' })).toBeInTheDocument();
    expect(screen.queryByText('Monitor inventory is unavailable.')).not.toBeInTheDocument();
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
      currentCheck: {
        availability: 'AVAILABLE',
        responseTimeMs: 42,
        checkedAt: '2026-09-24T12:00:00.000Z',
        roundId: 'round-1',
        trigger: 'MANUAL',
      },
      incidentState: {
        failureStreak: {
          count: 3,
          threshold: 3,
          startedAt: '2026-09-24T11:58:00.000Z',
          startedByRoundId: 'round-a',
        },
        currentIncident: {
          id: 'incident-1',
          status: 'OPEN',
          startedAt: '2026-09-24T11:58:00.000Z',
          openedAt: '2026-09-24T12:00:00.000Z',
          startedByRoundId: 'round-a',
          openedByRoundId: 'round-1',
        },
      },
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
    await userEvent.click(screen.getByText('Configure monitor'));

    const url = screen.getByRole('textbox', { name: 'URL' });
    await userEvent.clear(url);
    await userEvent.type(url, updated.url);
    await userEvent.click(screen.getByRole('combobox', { name: 'Method' }));
    await userEvent.click(screen.getByRole('option', { name: 'HEAD' }));
    const timeout = screen.getByRole('spinbutton', { name: 'Timeout (seconds)' });
    await userEvent.clear(timeout);
    await userEvent.type(timeout, '5');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Follow redirects' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save HTTP settings' }));

    expect(await screen.findByText('redirects final')).toBeInTheDocument();
    expect(screen.getByLabelText('Current availability: available')).toBeInTheDocument();
    expect(screen.getByLabelText('Incident state')).toHaveTextContent('Incident: OPEN');
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

  it('keeps the overview focused on project health and a compact monitored-services table', async () => {
    const monitor = {
      id: 'overview-monitor',
      name: 'Production API',
      url: 'https://example.com/health',
      method: 'GET',
      lifecycleState: 'ENABLED',
      timeoutMs: 10_000,
      followRedirects: true,
      statusPolicy: { type: 'ANY_2XX' },
      locations: ['local'],
      createdAt: new Date().toISOString(),
      currentCheck: null,
      incidentState: { failureStreak: null, currentIncident: null },
      uptime: { uptimePercent: null, coveragePercent: null },
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data:
              url === '/api/overview/response-times'
                ? {
                    range: {
                      start: '2026-10-21T00:00:00.000Z',
                      end: '2026-10-27T10:00:00.000Z',
                      timezone: 'UTC',
                    },
                    series: [],
                  }
                : [monitor],
          }),
          { status: 200 },
        ),
      );
    });

    render(<Dashboard view="overview" />);

    expect(await screen.findByRole('heading', { name: 'Monitored services' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Production API' })).toHaveAttribute(
      'href',
      '/monitors/overview-monitor?from=%2F',
    );
    expect(screen.queryByRole('textbox', { name: 'Monitor name' })).not.toBeInTheDocument();
    expect(screen.queryByText('Configure monitor')).not.toBeInTheDocument();
  });

  it('deletes a monitor through the existing archived lifecycle transition', async () => {
    const monitor = {
      id: 'delete-monitor',
      name: 'Retired API',
      url: 'https://retired.example.com',
      method: 'GET',
      lifecycleState: 'ENABLED',
      timeoutMs: 10_000,
      followRedirects: true,
      statusPolicy: { type: 'ANY_2XX' },
      locations: ['local'],
      createdAt: '2026-10-27T10:00:00.000Z',
      currentCheck: null,
      incidentState: { failureStreak: null, currentIncident: null },
      uptime: { uptimePercent: null, coveragePercent: null },
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === `/api/monitors/${monitor.id}/lifecycle`) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { ...monitor, lifecycleState: 'ARCHIVED' } }), {
            status: 200,
          }),
        );
      }
      if (url === '/api/overview/response-times') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                range: {
                  start: '2026-10-21T00:00:00.000Z',
                  end: '2026-10-27T10:00:00.000Z',
                  timezone: 'UTC',
                },
                series: [],
              },
            }),
            { status: 200 },
          ),
        );
      }
      expect(init?.method).toBeUndefined();
      return Promise.resolve(new Response(JSON.stringify({ data: [monitor] }), { status: 200 }));
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<Dashboard view="overview" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for Retired API' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/monitors/${monitor.id}/lifecycle`,
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ lifecycleState: 'ARCHIVED' }),
        }),
      ),
    );
    expect(await screen.findByText('No monitors yet')).toBeInTheDocument();
  });

  it('separates monitor inventory and creation into dedicated views', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );

    const inventory = render(<Dashboard view="monitors" />);
    expect(await screen.findByRole('heading', { name: 'No monitors yet' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Monitor name' })).not.toBeInTheDocument();
    inventory.unmount();

    render(<Dashboard view="create" />);
    expect(await screen.findByRole('heading', { name: 'Create monitor' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Monitor name' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Monitors' })).not.toBeInTheDocument();
  });
});

function configurationTestResponse(): Response {
  return new Response(
    JSON.stringify({
      data: {
        result: {
          outcome: 'PASS',
          stage: 'HTTP',
          reason: 'COMPLETED',
          statusCode: 200,
          responseTimeMs: 12,
          attemptDurationMs: 14,
          checkedAt: '2026-10-31T20:00:00.000Z',
          redirects: [],
          assertionEvaluation: { contractVersion: 1, outcome: 'PASS', diagnostics: [] },
        },
        signals: { transport: 'PASS', statusPolicy: 'PASS', assertions: 'PASS' },
        response: {
          headers: [{ name: 'content-type', values: ['text/plain'], redacted: false }],
          withheldHeaderCount: 0,
          body: { state: 'PREVIEW', contentType: 'text/plain', text: 'ok', truncated: false },
        },
      },
    }),
    { status: 200 },
  );
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

function projectListResponse(projectId: string): Response {
  return new Response(
    JSON.stringify({
      data: [
        {
          id: projectId,
          name: 'Assertions project',
          slug: 'assertions-project',
          monitorCount: 0,
          createdAt: '2026-10-31T20:00:00.000Z',
          updatedAt: '2026-10-31T20:00:00.000Z',
        },
      ],
    }),
    { status: 200 },
  );
}
