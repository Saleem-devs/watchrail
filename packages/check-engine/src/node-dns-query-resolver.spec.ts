import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeDnsCheck } from './dns-check.js';
import { NodeDnsQueryResolver } from './node-dns-query-resolver.js';

function createPendingResolver() {
  let rejectQuery: ((error: Error) => void) | undefined;
  const query = new Promise<string[]>((_, reject) => {
    rejectQuery = reject;
  });
  const resolver = {
    cancel: vi.fn(() =>
      rejectQuery?.(Object.assign(new Error('cancelled'), { code: 'ECANCELLED' })),
    ),
    resolve4: vi.fn(() => query),
    resolve6: vi.fn(() => query),
    resolveCname: vi.fn(() => query),
    resolveMx: vi.fn(() => Promise.resolve([])),
    resolveNs: vi.fn(() => query),
    resolveTxt: vi.fn(() => Promise.resolve([])),
  };
  return resolver;
}

describe('NodeDnsQueryResolver', () => {
  afterEach(() => vi.useRealTimers());

  it('cancels the native DNS operation when the check deadline expires', async () => {
    vi.useFakeTimers();
    const nativeResolver = createPendingResolver();
    const resolver = new NodeDnsQueryResolver(() => nativeResolver);
    const result = executeDnsCheck(
      { name: 'example.com', recordType: 'A', expectedValues: [], timeoutMs: 1_000 },
      { resolver },
    );

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toMatchObject({ reason: 'DNS_TIMEOUT' });
    expect(nativeResolver.cancel).toHaveBeenCalledOnce();
  });

  it('cancels an outstanding DNS operation when the signal aborts', async () => {
    const nativeResolver = createPendingResolver();
    const resolver = new NodeDnsQueryResolver(() => nativeResolver);
    const controller = new AbortController();
    const result = resolver.resolve({
      name: 'example.com',
      recordType: 'A',
      signal: controller.signal,
    });

    controller.abort();

    await expect(result).rejects.toMatchObject({ code: 'ECANCELLED' });
    expect(nativeResolver.cancel).toHaveBeenCalledOnce();
  });

  it('does not start a DNS operation for an already-aborted signal', async () => {
    const nativeResolver = createPendingResolver();
    const resolver = new NodeDnsQueryResolver(() => nativeResolver);
    const controller = new AbortController();
    controller.abort(new Error('cancelled before query'));

    await expect(
      resolver.resolve({
        name: 'example.com',
        recordType: 'AAAA',
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled before query');
    expect(nativeResolver.resolve6).not.toHaveBeenCalled();
    expect(nativeResolver.cancel).not.toHaveBeenCalled();
  });
});
