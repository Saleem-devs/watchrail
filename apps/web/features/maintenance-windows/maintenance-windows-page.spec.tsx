import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MaintenanceWindowDetailPage } from './maintenance-window-detail-page';
import { MaintenanceWindowsPage } from './maintenance-windows-page';
import type { MaintenanceWindow } from './types';

vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const projectId = '11111111-1111-4111-8111-111111111111';
const maintenanceWindow: MaintenanceWindow = {
  id: '22222222-2222-4222-8222-222222222222',
  projectId,
  versionNumber: 1,
  name: 'System Maintenance',
  schedule: {
    type: 'RECURRING',
    timezone: 'UTC',
    localTime: '20:00',
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    durationMinutes: 60,
    startsOn: '2026-11-01',
    endsOn: null,
  },
  target: { type: 'PROJECT' },
  effects: {
    suppressNotifications: true,
    suppressIncidentCreation: true,
    excludeFromUptime: true,
    publishToStatusPage: true,
  },
  effectiveAt: '2026-11-01T00:00:00.000Z',
  archivedAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

afterEach(() => vi.restoreAllMocks());

describe('maintenance windows page', () => {
  it('keeps view, edit, and archive in the standard row action menu', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ data: [maintenanceWindow] }));

    render(<MaintenanceWindowsPage projectId={projectId} />);
    await screen.findByText(maintenanceWindow.name);

    await user.click(screen.getByRole('button', { name: `Actions for ${maintenanceWindow.name}` }));
    expect(screen.getByRole('menuitem', { name: 'View' })).toHaveAttribute(
      'href',
      `/projects/${projectId}/maintenance/${maintenanceWindow.id}`,
    );
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveAttribute(
      'href',
      `/projects/${projectId}/maintenance/${maintenanceWindow.id}/edit`,
    );

    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(`Archive ${maintenanceWindow.name}?`);
  });

  it('shows the overview and history on the dedicated view page', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: maintenanceWindow }))
      .mockResolvedValueOnce(
        json({ data: [], page: { number: 1, limit: 100, total: 0, totalPages: 1 } }),
      )
      .mockResolvedValueOnce(
        json({
          data: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              action: 'CREATED',
              versionNumber: 1,
              actorId: '44444444-4444-4444-8444-444444444444',
              occurredAt: '2026-11-01T00:00:00.000Z',
            },
          ],
        }),
      );

    render(
      <MaintenanceWindowDetailPage
        projectId={projectId}
        maintenanceWindowId={maintenanceWindow.id}
      />,
    );

    expect(
      await screen.findByRole('heading', { name: maintenanceWindow.name }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Maintenance overview' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Behavior' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Maintenance history' })).toBeInTheDocument();
    expect(screen.getByText('Maintenance window created')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit window' })).toHaveAttribute(
      'href',
      `/projects/${projectId}/maintenance/${maintenanceWindow.id}/edit`,
    );
    expect(screen.getByRole('button', { name: 'Archive window' })).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock.mock.calls[2]?.[0]).toBe(
        `/api/projects/${projectId}/maintenance-windows/${maintenanceWindow.id}/audit-events`,
      ),
    );
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
