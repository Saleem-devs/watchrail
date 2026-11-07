import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IncidentTable } from './incident-table';
import type { WorkspaceIncident } from './types';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const incident: WorkspaceIncident = {
  id: 'incident-1',
  groupKey: 'availability:monitor-1',
  monitorId: 'monitor-1',
  monitorName: 'Parqo',
  monitorUrl: 'https://parqo.xyz',
  status: 'OPEN',
  severity: 'DOWN',
  startedAt: '2026-11-01T12:45:56.000Z',
  openedAt: '2026-11-01T12:48:10.000Z',
  resolvedAt: null,
  acknowledgedAt: null,
  acknowledgedByActorId: null,
  silencedAt: null,
  silencedUntil: null,
  notificationsSilenced: false,
  silencedByActorId: null,
  resolvedByActorId: null,
  resolutionNote: null,
};

describe('incident table project navigation', () => {
  beforeEach(() => push.mockReset());

  it('keeps row and action navigation inside the selected project', async () => {
    const user = userEvent.setup();
    const origin = '/projects/project-1/incidents?status=all&page=1&limit=25';
    const expectedMonitor =
      '/projects/project-1/monitors/monitor-1?from=%2Fprojects%2Fproject-1%2Fincidents%3Fstatus%3Dall%26page%3D1%26limit%3D25';
    const expectedIncident = '/projects/project-1/incidents/incident-1';

    render(
      <IncidentTable
        incidents={[incident]}
        origin={origin}
        projectId="project-1"
        onAcknowledge={vi.fn()}
        onSilence={vi.fn()}
        onUnsilence={vi.fn()}
        onResolve={vi.fn()}
      />,
    );

    const row = screen.getByRole('row', { name: 'Open Parqo incident' });
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith(expectedIncident);

    await user.click(screen.getByRole('button', { name: 'Actions for Parqo incident' }));
    expect(screen.getByRole('menuitem', { name: 'View monitor' })).toHaveAttribute(
      'href',
      expectedMonitor,
    );
  });
});
