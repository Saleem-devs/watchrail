import { describe, expect, it, vi } from 'vitest';
import { executeDnsCheck } from './dns-check.js';
import type { DnsQueryResolver } from './dns-types.js';

const checkedAt = new Date('2026-11-01T12:00:00.000Z');

function createClock() {
  let elapsedMs = 0;
  return {
    now: () => checkedAt,
    monotonicNow: () => elapsedMs,
    advance: (ms: number) => {
      elapsedMs += ms;
    },
  };
}

describe('executeDnsCheck', () => {
  it('passes when every configured answer is present', async () => {
    const clock = createClock();
    const resolver: DnsQueryResolver = {
      resolve: vi.fn(() => {
        clock.advance(18);
        return Promise.resolve(['203.0.113.20', '203.0.113.10']);
      }),
    };
    await expect(
      executeDnsCheck(
        {
          name: 'api.example.com',
          recordType: 'A',
          expectedValues: ['203.0.113.10'],
          timeoutMs: 10_000,
        },
        { resolver, clock },
      ),
    ).resolves.toEqual({
      outcome: 'PASS',
      stage: 'DNS',
      reason: 'RECORDS_MATCHED',
      queryTimeMs: 18,
      answers: ['203.0.113.10', '203.0.113.20'],
      attemptDurationMs: 18,
      checkedAt,
    });
  });

  it('fails with bounded evidence when expected answers are missing', async () => {
    const resolver: DnsQueryResolver = {
      resolve: vi.fn().mockResolvedValue(['origin.example.com.']),
    };
    await expect(
      executeDnsCheck(
        {
          name: 'api.example.com',
          recordType: 'CNAME',
          expectedValues: ['other.example.com'],
          timeoutMs: 10_000,
        },
        { resolver, clock: createClock() },
      ),
    ).resolves.toMatchObject({
      outcome: 'FAIL',
      stage: 'DNS',
      reason: 'RECORD_MISMATCH',
      answers: ['origin.example.com'],
    });
  });

  it('matches against the complete answer set while retaining bounded evidence', async () => {
    const answers = Array.from(
      { length: 40 },
      (_, index) => `answer-${String(index).padStart(2, '0')}`,
    );
    const resolver: DnsQueryResolver = { resolve: vi.fn().mockResolvedValue(answers) };

    await expect(
      executeDnsCheck(
        {
          name: 'records.example.com',
          recordType: 'TXT',
          expectedValues: ['answer-39'],
          timeoutMs: 10_000,
        },
        { resolver, clock: createClock() },
      ),
    ).resolves.toMatchObject({
      outcome: 'PASS',
      reason: 'RECORDS_MATCHED',
      answers: answers.slice(0, 32),
    });
  });

  it('distinguishes missing records from a missing name', async () => {
    const noData: DnsQueryResolver = {
      resolve: vi.fn().mockRejectedValue(Object.assign(new Error('no data'), { code: 'ENODATA' })),
    };
    const notFound: DnsQueryResolver = {
      resolve: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOTFOUND' })),
    };
    const input = {
      name: 'example.com',
      recordType: 'TXT' as const,
      expectedValues: [],
      timeoutMs: 10_000,
    };
    await expect(
      executeDnsCheck(input, { resolver: noData, clock: createClock() }),
    ).resolves.toMatchObject({
      reason: 'NO_RECORDS',
    });
    await expect(
      executeDnsCheck(input, { resolver: notFound, clock: createClock() }),
    ).resolves.toMatchObject({
      reason: 'NAME_NOT_FOUND',
    });
  });

  it('enforces the query deadline', async () => {
    vi.useFakeTimers();
    const resolver: DnsQueryResolver = {
      resolve: vi.fn(() => new Promise<string[]>(() => undefined)),
    };
    const result = executeDnsCheck(
      { name: 'example.com', recordType: 'A', expectedValues: [], timeoutMs: 1_000 },
      { resolver, clock: createClock() },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({
      outcome: 'FAIL',
      stage: 'DNS',
      reason: 'DNS_TIMEOUT',
    });
    vi.useRealTimers();
  });
});
