import { describe, expect, it, vi } from 'vitest';
import { executeIcmpCheck } from './icmp-check.js';
import type { DnsResolver, IcmpPinger, IcmpPingResult } from './index.js';

const checkedAt = new Date('2026-11-08T12:00:00.000Z');

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

const publicResolver: DnsResolver = {
  lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
};

describe('executeIcmpCheck', () => {
  it('returns ICMP response latency for a reply', async () => {
    const clock = createClock();
    const pinger: IcmpPinger = {
      ping: vi.fn(() => {
        clock.advance(34);
        return Promise.resolve({ type: 'REPLY' as const, responseTimeMs: 31 });
      }),
    };

    await expect(
      executeIcmpCheck(
        { host: 'edge.example.com', timeoutMs: 5_000 },
        { pinger, resolver: publicResolver, clock },
      ),
    ).resolves.toEqual({
      outcome: 'PASS',
      stage: 'ICMP',
      reason: 'PING_REPLIED',
      responseTimeMs: 31,
      attemptDurationMs: 34,
      checkedAt,
    });
  });

  it('classifies an unreachable host as a failure', async () => {
    await expect(
      executeIcmpCheck(
        { host: 'edge.example.com', timeoutMs: 5_000 },
        {
          pinger: { ping: vi.fn().mockResolvedValue({ type: 'HOST_UNREACHABLE' }) },
          resolver: publicResolver,
          clock: createClock(),
        },
      ),
    ).resolves.toMatchObject({
      outcome: 'FAIL',
      stage: 'ICMP',
      reason: 'PING_HOST_UNREACHABLE',
      responseTimeMs: null,
    });
  });

  it('treats a missing or unauthorized ping capability as indeterminate', async () => {
    await expect(
      executeIcmpCheck(
        { host: 'edge.example.com', timeoutMs: 5_000 },
        {
          pinger: { ping: vi.fn().mockResolvedValue({ type: 'ICMP_UNAVAILABLE' }) },
          resolver: publicResolver,
          clock: createClock(),
        },
      ),
    ).resolves.toMatchObject({
      outcome: 'UNKNOWN',
      stage: 'PROBE',
      reason: 'ICMP_UNAVAILABLE',
    });
  });

  it('does not ping private or reserved destinations', async () => {
    const ping = vi.fn();
    await expect(
      executeIcmpCheck(
        { host: '127.0.0.1', timeoutMs: 5_000 },
        { pinger: { ping }, clock: createClock() },
      ),
    ).resolves.toMatchObject({
      outcome: 'UNKNOWN',
      stage: 'DNS',
      reason: 'PROHIBITED_DESTINATION',
    });
    expect(ping).not.toHaveBeenCalled();
  });

  it('classifies DNS failures separately from ICMP failures', async () => {
    const resolver: DnsResolver = {
      lookup: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOTFOUND' })),
    };
    await expect(
      executeIcmpCheck(
        { host: 'missing.example.com', timeoutMs: 5_000 },
        { pinger: { ping: vi.fn() }, resolver, clock: createClock() },
      ),
    ).resolves.toMatchObject({ outcome: 'FAIL', stage: 'DNS', reason: 'NAME_NOT_FOUND' });
  });

  it('enforces one timeout across DNS resolution and ping execution', async () => {
    vi.useFakeTimers();
    const pinger: IcmpPinger = {
      ping: vi.fn(() => new Promise<IcmpPingResult>(() => undefined)),
    };
    const result = executeIcmpCheck(
      { host: 'edge.example.com', timeoutMs: 1_000 },
      { pinger, resolver: publicResolver, clock: createClock() },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({
      outcome: 'FAIL',
      stage: 'ICMP',
      reason: 'PING_TIMEOUT',
    });
    vi.useRealTimers();
  });
});
