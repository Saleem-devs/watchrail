import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadStatusPageIncidents } from './status-page-api';
import { StatusPageIncidentsList } from './status-page-incidents-list';
import { StatusPageIncidentsPanel } from './status-page-incidents-panel';
import type { StatusPageIncidentState, WorkspaceStatusPageIncident } from './types';

vi.mock('./status-page-api', () => ({ loadStatusPageIncidents: vi.fn() }));
vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const loadIncidents = vi.mocked(loadStatusPageIncidents);

describe('status-page incident management navigation', () => {
  beforeEach(() => {
    loadIncidents.mockReset();
  });

  it('keeps an older active incident visible ahead of six newer resolved incidents', async () => {
    const resolved = Array.from({ length: 6 }, (_, index) =>
      incident(`resolved-${index + 1}`, `Resolved incident ${index + 1}`, 'RESOLVED'),
    );
    loadIncidents.mockResolvedValue([
      ...resolved,
      incident('older-active', 'Older active incident', 'INVESTIGATING'),
    ]);

    render(<StatusPageIncidentsPanel projectBase="/projects/project-1" statusPageId="page-1" />);

    expect(await screen.findByText('Older active incident')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View all 7 incidents' })).toHaveAttribute(
      'href',
      '/projects/project-1/status-pages/page-1/incidents',
    );
    expect(screen.queryByText('Resolved incident 6')).not.toBeInTheDocument();
  });

  it('keeps more than six active incidents and older resolved history reachable in the full list', async () => {
    const active = Array.from({ length: 7 }, (_, index) =>
      incident(`active-${index + 1}`, `Active incident ${index + 1}`, 'IDENTIFIED'),
    );
    const incidents = [
      ...active,
      incident('recent-resolved', 'Recent resolved incident', 'RESOLVED'),
      incident('older-resolved', 'Older resolved incident', 'RESOLVED'),
    ];
    loadIncidents.mockResolvedValue(incidents);

    render(<StatusPageIncidentsList projectId="project-1" statusPageId="page-1" />);

    expect(await screen.findByRole('heading', { name: 'Active incidents' })).toBeInTheDocument();
    for (const item of incidents) {
      expect(screen.getByRole('link', { name: new RegExp(item.title) })).toHaveAttribute(
        'href',
        `/projects/project-1/status-pages/page-1/incidents/${item.id}`,
      );
    }
    expect(screen.getByRole('heading', { name: 'Resolved history' })).toBeInTheDocument();
    expect(screen.getByText('7 active · 2 resolved')).toBeInTheDocument();
  });
});

function incident(
  id: string,
  title: string,
  state: StatusPageIncidentState,
): WorkspaceStatusPageIncident {
  return {
    id,
    statusPageId: 'page-1',
    title,
    impact: 'DEGRADED',
    state,
    startedAt: '2026-11-10T10:00:00.000Z',
    resolvedAt: state === 'RESOLVED' ? '2026-11-10T11:00:00.000Z' : null,
    updatedAt: '2026-11-10T11:00:00.000Z',
    components: [{ id: 'component-1', displayName: 'Public API', position: 0 }],
    updates: [],
  };
}
