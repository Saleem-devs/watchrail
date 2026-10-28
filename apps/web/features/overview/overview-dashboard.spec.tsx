import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Monitor, ResponseTimeOverview } from '../monitors/types';
import { OverviewDashboard } from './overview-dashboard';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

function monitor(overrides: Partial<Monitor> & Pick<Monitor, 'id' | 'name'>): Monitor {
  const { id, name, ...rest } = overrides;
  return {
    id,
    name,
    url: `https://${id}.example.com`,
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
    ...rest,
  };
}

describe('OverviewDashboard', () => {
  it('summarizes authoritative health and keeps paused monitors out of operational totals', () => {
    render(
      <OverviewDashboard
        monitors={[
          monitor({
            id: 'api',
            name: 'API',
            currentCheck: {
              kind: 'SINGLE_LOCATION',
              availability: 'AVAILABLE',
              responseTimeMs: 80,
              checkedAt: '2026-10-27T10:00:00.000Z',
              roundId: 'round-api',
              trigger: 'SCHEDULED',
              aggregateOutcome: null,
              coverage: null,
              reachability: null,
            },
            uptime: { uptimePercent: 99, coveragePercent: 98 },
          }),
          monitor({
            id: 'checkout',
            name: 'Checkout',
            currentCheck: {
              kind: 'MULTI_LOCATION',
              availability: 'AVAILABLE',
              responseTimeMs: 220,
              checkedAt: '2026-10-27T10:00:00.000Z',
              roundId: 'round-checkout',
              trigger: 'SCHEDULED',
              aggregateOutcome: 'DEGRADED',
              coverage: { numerator: 2, denominator: 2 },
              reachability: { numerator: 1, denominator: 2 },
            },
            incidentState: {
              failureStreak: null,
              currentIncident: {
                id: 'incident-1',
                status: 'OPEN',
                startedAt: '2026-10-27T09:55:00.000Z',
                openedAt: '2026-10-27T10:00:00.000Z',
                startedByRoundId: 'round-checkout',
                openedByRoundId: 'round-checkout',
              },
            },
            uptime: { uptimePercent: 95, coveragePercent: 92 },
          }),
          monitor({
            id: 'paused',
            name: 'Paused service',
            lifecycleState: 'PAUSED',
            currentCheck: {
              kind: 'SINGLE_LOCATION',
              availability: 'AVAILABLE',
              responseTimeMs: 15,
              checkedAt: '2026-10-26T10:00:00.000Z',
              roundId: 'round-paused',
              trigger: 'SCHEDULED',
              aggregateOutcome: null,
              coverage: null,
              reachability: null,
            },
          }),
        ]}
        responseTimes={responseTimeOverview}
        responseTimesLoading={false}
        responseTimesError={undefined}
        onRetryResponseTimes={() => undefined}
      />,
    );

    const metrics = screen.getByRole('region', { name: 'Workspace health' });
    expect(within(metrics).getByText('3')).toBeInTheDocument();
    expect(within(metrics).getByText('1 paused')).toBeInTheDocument();
    expect(within(metrics).getByText('97.00%')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Response time trends' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Latest daily average' })).toBeInTheDocument();
    expect(screen.getByText('12 samples')).toBeInTheDocument();
    expect(screen.getByText('8 samples')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Monitored services' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Checkout' })[0]).toHaveAttribute(
      'href',
      '/monitors/checkout',
    );
    expect(
      screen.getByRole('link', { name: 'Open Checkout endpoint in a new tab' }),
    ).toHaveAttribute('target', '_blank');
    expect(screen.getAllByText('220 ms')).toHaveLength(3);
    expect(screen.getByText('98.00%')).toBeInTheDocument();
    expect(screen.getByText('92.00%')).toBeInTheDocument();
    expect(screen.queryByText('15 ms')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Monitoring paused')).toBeInTheDocument();
  });

  it('renders explicit empty evidence states without inventing metrics', () => {
    render(
      <OverviewDashboard
        monitors={[]}
        responseTimes={{
          range: {
            start: '2026-10-21T00:00:00.000Z',
            end: '2026-10-27T10:00:00.000Z',
            timezone: 'UTC',
          },
          series: [],
        }}
        responseTimesLoading={false}
        responseTimesError={undefined}
        onRetryResponseTimes={() => undefined}
      />,
    );

    expect(screen.getByText('Average 7-day uptime').nextElementSibling).toHaveTextContent('—');
    expect(
      screen.getByText('No scheduled response-time evidence has been recorded yet.'),
    ).toBeInTheDocument();
    expect(screen.getByText('No comparison available yet.')).toBeInTheDocument();
    expect(screen.getByText('No monitors yet')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Monitored services' })).toBeInTheDocument();
  });
});

const responseTimeOverview: ResponseTimeOverview = {
  range: {
    start: '2026-10-21T00:00:00.000Z',
    end: '2026-10-27T10:00:00.000Z',
    timezone: 'UTC',
  },
  series: [
    {
      monitorId: 'api',
      monitorName: 'API',
      points: [
        { date: '2026-10-21', averageResponseTimeMs: 80, sampleCount: 12 },
        { date: '2026-10-22', averageResponseTimeMs: 90, sampleCount: 12 },
      ],
    },
    {
      monitorId: 'checkout',
      monitorName: 'Checkout',
      points: [{ date: '2026-10-21', averageResponseTimeMs: 220, sampleCount: 8 }],
    },
  ],
};
