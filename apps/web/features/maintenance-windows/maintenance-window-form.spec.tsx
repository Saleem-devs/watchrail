import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MaintenanceWindowForm } from './maintenance-window-form';
import type { MaintenanceWindow } from './types';

describe('MaintenanceWindowForm', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serializes an unsaved one-time project window with explicit effects', async () => {
    const user = userEvent.setup();
    const saved = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: responseWindow() }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      <>
        <MaintenanceWindowForm
          formId="maintenance-form"
          projectId="project-1"
          monitors={[]}
          onSaved={saved}
        />
        <button type="submit" form="maintenance-form">
          Schedule maintenance
        </button>
      </>,
    );

    await user.type(screen.getByLabelText('Name'), 'Database upgrade');
    await user.click(screen.getByRole('checkbox', { name: /Publish on status pages/ }));
    await user.click(screen.getByRole('button', { name: 'Schedule maintenance' }));

    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0]!;
    const requestBody = (init as RequestInit).body;
    if (typeof requestBody !== 'string') throw new Error('Expected a JSON request body.');
    const body = JSON.parse(requestBody) as Record<string, unknown>;
    expect(body).toMatchObject({
      name: 'Database upgrade',
      schedule: { type: 'ONE_TIME' },
      target: { type: 'PROJECT' },
      effects: {
        suppressNotifications: true,
        suppressIncidentCreation: true,
        excludeFromUptime: true,
        publishToStatusPage: true,
      },
    });
  });

  it('requires a monitor when selected-monitor scope is chosen', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <>
        <MaintenanceWindowForm
          formId="maintenance-form"
          projectId="project-1"
          monitors={[]}
          onSaved={vi.fn()}
        />
        <button type="submit" form="maintenance-form">
          Schedule maintenance
        </button>
      </>,
    );

    await user.type(screen.getByLabelText('Name'), 'Targeted maintenance');
    await user.click(screen.getByLabelText(/Selected monitors/));
    await user.click(screen.getByRole('button', { name: 'Schedule maintenance' }));

    expect(await screen.findByText('Choose at least one monitor.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows and serializes UTC as the recurring schedule default', async () => {
    const user = userEvent.setup();
    const saved = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            ...responseWindow(),
            schedule: {
              type: 'RECURRING',
              timezone: 'UTC',
              localTime: '02:00',
              daysOfWeek: [1, 2, 3, 4, 5],
              durationMinutes: 60,
              startsOn: '2026-11-07',
              endsOn: null,
            },
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      <>
        <MaintenanceWindowForm
          formId="maintenance-form"
          projectId="project-1"
          monitors={[]}
          onSaved={saved}
        />
        <button type="submit" form="maintenance-form">
          Schedule maintenance
        </button>
      </>,
    );

    await user.type(screen.getByLabelText('Name'), 'Weekly database maintenance');
    await user.click(screen.getByLabelText(/Recurring/));
    expect(screen.getByRole('combobox', { name: 'Timezone' })).toHaveTextContent('UTC');
    await user.click(screen.getByRole('button', { name: 'Schedule maintenance' }));

    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0]!;
    const requestBody = (init as RequestInit).body;
    if (typeof requestBody !== 'string') throw new Error('Expected a JSON request body.');
    expect(JSON.parse(requestBody)).toMatchObject({
      schedule: {
        type: 'RECURRING',
        timezone: 'UTC',
        localTime: '02:00',
        daysOfWeek: [1, 2, 3, 4, 5],
        durationMinutes: 60,
      },
    });
  });
});

function responseWindow(): MaintenanceWindow {
  return {
    id: 'window-1',
    projectId: 'project-1',
    versionNumber: 1,
    name: 'Database upgrade',
    schedule: {
      type: 'ONE_TIME',
      startsAt: '2026-11-10T01:00:00.000Z',
      endsAt: '2026-11-10T02:00:00.000Z',
    },
    target: { type: 'PROJECT' },
    effects: {
      suppressNotifications: true,
      suppressIncidentCreation: true,
      excludeFromUptime: true,
      publishToStatusPage: true,
    },
    effectiveAt: '2026-11-06T12:00:00.000Z',
    archivedAt: null,
    createdAt: '2026-11-06T12:00:00.000Z',
    updatedAt: '2026-11-06T12:00:00.000Z',
  };
}
