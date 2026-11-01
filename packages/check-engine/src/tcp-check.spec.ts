import { describe, expect, it, vi } from 'vitest';
import { executeTcpCheck } from './tcp-check.js';
import type { DnsResolver, TcpConnector, TcpConnectResult } from './index.js';

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

const publicResolver: DnsResolver = {
  lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
};

describe('executeTcpCheck', () => {
  it('returns protocol-specific connection latency for an established socket', async () => {
    const clock = createClock();
    const connector: TcpConnector = {
      connect: vi.fn(() => {
        clock.advance(42);
        return Promise.resolve({ type: 'CONNECTED' as const, connectionTimeMs: 39 });
      }),
    };

    await expect(
      executeTcpCheck(
        { host: 'db.example.com', port: 5432, timeoutMs: 10_000 },
        { connector, resolver: publicResolver, clock },
      ),
    ).resolves.toEqual({
      outcome: 'PASS',
      stage: 'CONNECT',
      reason: 'CONNECTED',
      connectionTimeMs: 39,
      attemptDurationMs: 42,
      checkedAt,
    });
  });

  it('classifies refused connections as an availability failure', async () => {
    const connector: TcpConnector = {
      connect: vi.fn().mockResolvedValue({ type: 'CONNECTION_REFUSED' }),
    };
    await expect(
      executeTcpCheck(
        { host: 'db.example.com', port: 5432, timeoutMs: 10_000 },
        { connector, resolver: publicResolver, clock: createClock() },
      ),
    ).resolves.toMatchObject({
      outcome: 'FAIL',
      stage: 'CONNECT',
      reason: 'CONNECTION_REFUSED',
      connectionTimeMs: null,
    });
  });

  it('distinguishes an unreachable host from a refused port', async () => {
    const connector: TcpConnector = {
      connect: vi.fn().mockResolvedValue({ type: 'HOST_UNREACHABLE' }),
    };
    await expect(
      executeTcpCheck(
        { host: 'db.example.com', port: 5432, timeoutMs: 10_000 },
        { connector, resolver: publicResolver, clock: createClock() },
      ),
    ).resolves.toMatchObject({
      outcome: 'FAIL',
      stage: 'CONNECT',
      reason: 'HOST_UNREACHABLE',
      connectionTimeMs: null,
    });
  });

  it('classifies DNS failures separately from connection failures', async () => {
    const resolver: DnsResolver = {
      lookup: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOTFOUND' })),
    };
    await expect(
      executeTcpCheck(
        { host: 'missing.example.com', port: 443, timeoutMs: 10_000 },
        { connector: { connect: vi.fn() }, resolver, clock: createClock() },
      ),
    ).resolves.toMatchObject({ outcome: 'FAIL', stage: 'DNS', reason: 'NAME_NOT_FOUND' });
  });

  it('does not connect to private or reserved destinations', async () => {
    const connect = vi.fn();
    const connector: TcpConnector = { connect };
    await expect(
      executeTcpCheck(
        { host: '127.0.0.1', port: 5432, timeoutMs: 10_000 },
        { connector, clock: createClock() },
      ),
    ).resolves.toMatchObject({
      outcome: 'UNKNOWN',
      stage: 'DNS',
      reason: 'PROHIBITED_DESTINATION',
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it('enforces one timeout across DNS and connection establishment', async () => {
    vi.useFakeTimers();
    const connector: TcpConnector = {
      connect: vi.fn(() => new Promise<TcpConnectResult>(() => undefined)),
    };
    const result = executeTcpCheck(
      { host: 'db.example.com', port: 5432, timeoutMs: 1_000 },
      { connector, resolver: publicResolver, clock: createClock() },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({
      outcome: 'FAIL',
      stage: 'CONNECT',
      reason: 'CONNECTION_TIMEOUT',
    });
    vi.useRealTimers();
  });
});
