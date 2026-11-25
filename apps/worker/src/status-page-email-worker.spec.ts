import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { encryptAuthEmail, type StatusPageSubscriptionRepository } from '@watchrail/db';
import { StatusPageEmailWorker } from './status-page-email-worker.js';

const keyring = { activeKeyId: 'test', keys: new Map([['test', Buffer.alloc(32, 5)]]) };
const options = { leaseMs: 30_000, sendTimeoutMs: 10_000, maxAttempts: 3 };
function fixture() {
  const authorization = {
    kind: 'EVENT',
    subscriberId: 'subscriber',
    generation: 'generation',
    name: 'Service status',
    slug: 'service',
    subject: 'Incident update',
    body: 'Investigating elevated errors.',
    remainingMs: 30_000,
    details: encryptAuthEmail(
      { email: 'visitor@example.com', unsubscribe: 'u'.repeat(43) },
      'subscriber:subscriber:generation',
      keyring,
    ),
    payload: encryptAuthEmail(
      { verification: 'v'.repeat(43) },
      'status-verification:delivery',
      keyring,
    ),
  };
  const store = {
    expandNext: vi.fn().mockResolvedValue(false),
    claimNext: vi.fn().mockResolvedValue({ id: 'delivery', token: 'claim', attempts: 1 }),
    authorize: vi.fn().mockResolvedValue(authorization),
    finish: vi.fn().mockResolvedValue(true),
  };
  const sender = {
    send: vi.fn().mockResolvedValue({ accepted: ['visitor@example.com'], rejected: [] }),
  };
  const worker = new StatusPageEmailWorker(
    store as unknown as StatusPageSubscriptionRepository,
    sender,
    keyring,
    'https://status.example.com',
    options,
  );
  return { store, sender, worker, authorization };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('status subscriber email worker', () => {
  it('sends one recipient and includes an unsubscribe link without identifiers', async () => {
    const f = fixture();
    await f.worker.processNext();
    expect(f.sender.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['visitor@example.com'],
        text: expect.stringContaining('/status/subscriptions/manage#unsubscribe='),
      }),
      expect.anything(),
    );
    expect(f.store.finish).toHaveBeenCalledWith('delivery', 'claim', 'DELIVERED');
  });
  it('marks normalized mailbox acceptance delivered without retrying', async () => {
    const f = fixture();
    f.authorization.details = encryptAuthEmail(
      { email: ' Visitor@Example.COM ', unsubscribe: 'u'.repeat(43) },
      'subscriber:subscriber:generation',
      keyring,
    );
    await f.worker.processNext();
    expect(f.sender.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['visitor@example.com'] }),
      expect.anything(),
    );
    expect(f.store.finish).toHaveBeenCalledExactlyOnceWith('delivery', 'claim', 'DELIVERED');
  });
  it('does not send legacy formatted mailboxes', async () => {
    const f = fixture();
    f.authorization.details = encryptAuthEmail(
      { email: 'Alice<visitor@example.com>', unsubscribe: 'u'.repeat(43) },
      'subscriber:subscriber:generation',
      keyring,
    );
    await f.worker.processNext();
    expect(f.sender.send).not.toHaveBeenCalled();
    expect(f.store.finish).toHaveBeenCalledWith(
      'delivery',
      'claim',
      'DEAD',
      'INVALID_SUBSCRIPTION_MAILBOX',
    );
  });
  it('sends verification links without activating the subscription', async () => {
    const f = fixture();
    f.authorization.kind = 'VERIFY';
    await f.worker.processNext();
    expect(f.sender.send.mock.calls[0]![0].text).toContain('#verify=');
    expect(f.sender.send.mock.calls[0]![0].text).toContain('expires in 24 hours');
  });
  it('does not send after unsubscribe, unpublish, expiry or generation invalidation', async () => {
    const f = fixture();
    f.store.authorize.mockResolvedValue(null);
    await f.worker.processNext();
    expect(f.sender.send).not.toHaveBeenCalled();
    expect(f.store.finish).toHaveBeenCalledWith('delivery', 'claim', 'SUPPRESSED');
  });
  it('subtracts pre-dispatch time and avoids exhausted lease sends', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(3001);
    const f = fixture();
    f.authorization.remainingMs = 8000;
    await f.worker.processNext();
    expect(f.sender.send).not.toHaveBeenCalled();
    expect(f.store.finish).toHaveBeenCalledWith(
      'delivery',
      'claim',
      'PENDING',
      'LEASE_BUDGET_EXHAUSTED',
      5000,
    );
  });
  it('aborts a stalled SMTP send before its lease and schedules the same delivery', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let signal: AbortSignal | undefined;
    f.sender.send.mockImplementation((_message, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    const running = f.worker.processNext();
    await vi.advanceTimersByTimeAsync(10_001);
    await running;
    expect(signal!.aborted).toBe(true);
    expect(f.store.finish).toHaveBeenCalledWith(
      'delivery',
      'claim',
      'PENDING',
      'STATUS_EMAIL_DELIVERY_FAILED',
      10_000,
    );
  });
  it('dead-letters exhausted delivery failures without exposing SMTP errors', async () => {
    const f = fixture();
    f.store.claimNext.mockResolvedValue({ id: 'delivery', token: 'claim', attempts: 3 });
    f.sender.send.mockRejectedValue(new Error('sensitive provider response'));
    await f.worker.processNext();
    expect(f.store.finish).toHaveBeenCalledWith(
      'delivery',
      'claim',
      'DEAD',
      'STATUS_EMAIL_DELIVERY_FAILED',
      40_000,
    );
  });
});
