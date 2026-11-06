import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ManualDiagnostic } from './monitor-evidence';
import type { ManualRound } from './types';

describe('heartbeat diagnostic evidence', () => {
  it('presents a received heartbeat without HTTP response semantics', () => {
    render(
      <ManualDiagnostic
        protocol="HEARTBEAT"
        error={undefined}
        round={heartbeatRound({
          outcome: 'PASS',
          reason: 'SIGNAL_RECEIVED',
          heartbeatResult: {
            contractVersion: 1,
            signal: 'COMPLETE',
            runId: 'backup-42',
            message: 'Backup completed',
            metadata: { rows: 42 },
            expectedAt: '2026-11-06T02:10:00.000Z',
            receivedAt: '2026-11-06T02:09:30.000Z',
            runtimeMs: 30_000,
          },
        })}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Latest heartbeat evidence' })).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText('Complete')).toBeInTheDocument();
    expect(screen.getByText('backup-42')).toBeInTheDocument();
    expect(screen.queryByText(/HTTP execution/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Response validation/i)).not.toBeInTheDocument();
  });

  it('presents a missed heartbeat as unhealthy with no fabricated received evidence', () => {
    render(
      <ManualDiagnostic
        protocol="HEARTBEAT"
        error={undefined}
        round={heartbeatRound({
          outcome: 'FAIL',
          reason: 'MISSED_HEARTBEAT',
          heartbeatResult: {
            contractVersion: 1,
            signal: 'MISSED',
            runId: null,
            message: null,
            metadata: {},
            expectedAt: '2026-11-06T02:10:00.000Z',
            receivedAt: null,
            runtimeMs: null,
          },
        })}
      />,
    );

    expect(screen.getByText('Unhealthy')).toBeInTheDocument();
    expect(screen.getByText(/No heartbeat arrived/)).toBeInTheDocument();
    expect(screen.getByText('Missed')).toBeInTheDocument();
  });
});

function heartbeatRound(
  result: Pick<
    Extract<NonNullable<ManualRound['result']>, { kind?: 'SINGLE_LOCATION' }>,
    'outcome' | 'reason' | 'heartbeatResult'
  >,
): ManualRound {
  return {
    id: 'round-1',
    monitorId: 'monitor-1',
    trigger: 'SCHEDULED',
    status: 'COMPLETED',
    assignmentStatus: 'COMPLETED',
    createdAt: '2026-11-06T02:09:30.000Z',
    result: {
      kind: 'SINGLE_LOCATION',
      stage: 'HEARTBEAT',
      statusCode: null,
      responseTimeMs: null,
      attemptDurationMs: 0,
      redirects: [],
      checkedAt: '2026-11-06T02:09:30.000Z',
      ...result,
    },
  };
}
