import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DnsRecordHistory } from './dns-record-history';

describe('DnsRecordHistory', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the confirmed baseline, pending candidate, and before-and-after history', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            current: {
              dnsName: 'api.example.com',
              recordType: 'A',
              answers: ['203.0.113.20'],
              locationEvidence: [{ location: 'local', answers: ['203.0.113.20'] }],
              observedAt: '2026-11-08T10:05:00.000Z',
              configurationVersionId: '11111111-1111-4111-8111-111111111111',
            },
            candidate: {
              answers: ['203.0.113.30'],
              locationEvidence: [{ location: 'local', answers: ['203.0.113.30'] }],
              firstObservedAt: '2026-11-08T10:10:00.000Z',
            },
            items: [
              {
                id: '22222222-2222-4222-8222-222222222222',
                dnsName: 'api.example.com',
                recordType: 'A',
                beforeAnswers: ['203.0.113.10'],
                afterAnswers: ['203.0.113.20'],
                beforeLocationEvidence: [{ location: 'local', answers: ['203.0.113.10'] }],
                afterLocationEvidence: [{ location: 'local', answers: ['203.0.113.20'] }],
                detectedAt: '2026-11-08T10:03:00.000Z',
                confirmedAt: '2026-11-08T10:05:00.000Z',
                configurationVersionId: '11111111-1111-4111-8111-111111111111',
              },
            ],
          },
          page: { nextCursor: null },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<DnsRecordHistory monitorId="monitor-1" />);

    expect(await screen.findByText('A api.example.com')).toBeInTheDocument();
    expect(screen.getByText('Possible change awaiting confirmation')).toBeInTheDocument();
    expect(screen.getAllByText('203.0.113.10').length).toBeGreaterThan(0);
    expect(screen.getAllByText('203.0.113.20').length).toBeGreaterThan(0);
  });

  it('explains when no scheduled baseline exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { current: null, candidate: null, items: [] },
          page: { nextCursor: null },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<DnsRecordHistory monitorId="monitor-1" />);

    expect(await screen.findByText('Waiting for a DNS baseline')).toBeInTheDocument();
    expect(screen.getByText('No confirmed DNS changes yet.')).toBeInTheDocument();
  });
});
