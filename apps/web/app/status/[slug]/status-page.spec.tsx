import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { PublicStatusPageProjectionV1 } from '@watchrail/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { StatusPageRefresh, STATUS_PAGE_REFRESH_INTERVAL_MS } from './status-page-refresh';
import { StatusPageView, publicStatusLabel } from './status-page-view';

describe('public status page', () => {
  afterEach(() => {
    vi.useRealTimers();
    refresh.mockReset();
  });

  it.each([
    ['OPERATIONAL', 'All systems operational'],
    ['PARTIAL_OUTAGE', 'Partial outage'],
    ['MAJOR_OUTAGE', 'Major outage'],
    ['MONITORING_IMPAIRED', 'Monitoring impaired'],
  ] as const)('renders %s as visible text', (status, label) => {
    render(<StatusPageView page={projection(status)} />);
    expect(screen.getByRole('heading', { name: label })).toBeInTheDocument();
    expect(publicStatusLabel(status)).toBe(label);
  });

  it('preserves component ordering and renders incidents without invented lifecycle states', () => {
    const page = projection('PARTIAL_OUTAGE');
    page.components = [
      { id: 'b', displayName: 'Dashboard', position: 0, status: 'MAJOR_OUTAGE' },
      { id: 'a', displayName: 'API', position: 1, status: 'OPERATIONAL' },
    ];
    page.activeIncidents = [
      {
        id: 'open',
        componentId: 'b',
        status: 'OPEN',
        startedAt: '2026-10-10T20:00:00.000Z',
        openedAt: '2026-10-10T20:05:00.000Z',
        resolvedAt: null,
      },
    ];
    page.resolvedIncidents = [
      {
        id: 'closed',
        componentId: 'a',
        status: 'RESOLVED',
        startedAt: '2026-10-08T12:14:00.000Z',
        openedAt: '2026-10-08T12:16:00.000Z',
        resolvedAt: '2026-10-08T12:23:00.000Z',
      },
    ];
    render(<StatusPageView page={page} />);
    const section = screen.getByRole('heading', { name: 'Components' }).closest('section');
    const components = within(section as HTMLElement)
      .getByRole('list')
      .querySelectorAll('li');
    expect(components[0]).toHaveTextContent('DashboardMajor outage');
    expect(components[1]).toHaveTextContent('APIOperational');
    expect(screen.getByText('Active incident')).toBeInTheDocument();
    expect(screen.getByText('Recovered')).toBeInTheDocument();
    expect(screen.queryByText(/investigating|identified/i)).not.toBeInTheDocument();
  });

  it('refreshes manually and every 30 seconds while visible', () => {
    vi.useFakeTimers();
    render(<StatusPageRefresh />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    expect(refresh).toHaveBeenCalledTimes(1);
    void act(() => vi.advanceTimersByTime(STATUS_PAGE_REFRESH_INTERVAL_MS));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('pauses while hidden and refreshes immediately when visible again', () => {
    vi.useFakeTimers();
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    render(<StatusPageRefresh />);

    hidden = true;
    fireEvent(document, new Event('visibilitychange'));
    void act(() => vi.advanceTimersByTime(STATUS_PAGE_REFRESH_INTERVAL_MS * 2));
    expect(refresh).not.toHaveBeenCalled();

    hidden = false;
    fireEvent(document, new Event('visibilitychange'));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

function projection(status: PublicStatusPageProjectionV1['status']): PublicStatusPageProjectionV1 {
  return {
    contractVersion: 1,
    name: 'Acme Status',
    slug: 'acme-status',
    status,
    components: [{ id: 'api', displayName: 'API', position: 0, status }],
    activeIncidents: [],
    resolvedIncidents: [],
    generatedAt: '2026-10-10T21:00:00.000Z',
  };
}
