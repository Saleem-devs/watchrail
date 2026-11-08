import { fireEvent, render, screen } from '@testing-library/react';
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
                beforeAnswers: ['203.0.113.10', '203.0.113.20'],
                afterAnswers: ['203.0.113.10', '203.0.113.20'],
                beforeLocationEvidence: [
                  {
                    location: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                    answers: ['203.0.113.10'],
                  },
                  {
                    location: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                    answers: ['203.0.113.20'],
                  },
                ],
                afterLocationEvidence: [
                  {
                    location: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                    answers: ['203.0.113.20'],
                  },
                  {
                    location: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                    answers: ['203.0.113.10'],
                  },
                ],
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

    expect((await screen.findAllByText('A api.example.com')).length).toBeGreaterThan(0);
    expect(screen.getByText('Possible change awaiting confirmation')).toBeInTheDocument();
    expect(screen.getAllByText('203.0.113.10').length).toBeGreaterThan(0);
    expect(screen.getAllByText('203.0.113.20').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'View 2 locations' }));
    expect(screen.getAllByText('Probe aaaaaaaa').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Probe bbbbbbbb').length).toBeGreaterThan(0);
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

  it('keeps short answers intact while allowing long DNS values to wrap', async () => {
    const shortIpv4 = '203.0.113.20';
    const longIpv6 = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';
    const longTxt =
      'v=spf1 include:_spf.example.com include:_spf.notifications.example.com include:_spf.transactional.example.com -all';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            current: {
              dnsName: 'example.com',
              recordType: 'TXT',
              answers: [shortIpv4, longIpv6, longTxt],
              locationEvidence: [{ location: 'local', answers: [shortIpv4, longIpv6, longTxt] }],
              observedAt: '2026-11-08T10:05:00.000Z',
              configurationVersionId: '11111111-1111-4111-8111-111111111111',
            },
            candidate: null,
            items: [],
          },
          page: { nextCursor: null },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<DnsRecordHistory monitorId="monitor-1" />);

    const shortAnswer = await screen.findByText(shortIpv4);
    expect(screen.getByText(longIpv6)).toBeInTheDocument();
    expect(screen.getByText(longTxt)).toBeInTheDocument();

    for (const answer of [shortAnswer, screen.getByText(longIpv6), screen.getByText(longTxt)]) {
      expect(answer).toHaveClass('wrap-anywhere', 'whitespace-normal');
      expect(answer).not.toHaveClass('whitespace-nowrap', 'break-all');
    }
  });
});
