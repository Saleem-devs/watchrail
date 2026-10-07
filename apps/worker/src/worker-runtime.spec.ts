import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AvailabilityRepository, ScheduledRoundRepository } from '@watchrail/db';
import type { BullMqCheckJobConsumer, BullMqCheckJobPublisher } from '@watchrail/queue';
import type { CheckOutboxRelay } from './check-outbox-relay.js';
import type { WorkerConfig } from './config.js';
import { WorkerRuntime } from './worker-runtime.js';

const config = {
  idlePollIntervalMs: 500,
  dependencyErrorDelayMs: 1_000,
  scheduleDispatchBatchSize: 100,
  scheduleIdlePollIntervalMs: 1_000,
  availabilityFlushBatchSize: 100,
  availabilityFlushIntervalMs: 60_000,
  webhookDeliveryConcurrency: 2,
  webhookDeliveryIdlePollIntervalMs: 500,
} as WorkerConfig;

describe('WorkerRuntime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('drains full availability batches immediately, then sleeps independently', async () => {
    vi.useFakeTimers();
    const processNext = vi.fn().mockResolvedValue('IDLE');
    const dispatchDue = vi.fn().mockResolvedValue([]);
    const flushDue = vi.fn().mockResolvedValueOnce(100).mockResolvedValue(0);
    const runtime = new WorkerRuntime(
      { processNext } as unknown as CheckOutboxRelay,
      { close: vi.fn().mockResolvedValue(undefined) } as unknown as BullMqCheckJobConsumer,
      { close: vi.fn().mockResolvedValue(undefined) } as unknown as BullMqCheckJobPublisher,
      { dispatchDue } as unknown as ScheduledRoundRepository,
      { flushDue } as unknown as AvailabilityRepository,
      config,
    );
    runtime.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(flushDue).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(flushDue).toHaveBeenCalledTimes(2);
    expect(processNext.mock.calls.length).toBeGreaterThan(1);
    expect(dispatchDue.mock.calls.length).toBeGreaterThan(1);
    await runtime.beforeApplicationShutdown();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries failed flushes without interrupting other loops or logging dependency details', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const flushDue = vi
      .fn()
      .mockRejectedValueOnce(new Error('PRIVATE_DATABASE_DETAIL'))
      .mockResolvedValue(0);
    const processNext = vi.fn().mockResolvedValue('IDLE');
    const runtime = new WorkerRuntime(
      { processNext } as unknown as CheckOutboxRelay,
      { close: vi.fn().mockResolvedValue(undefined) } as unknown as BullMqCheckJobConsumer,
      { close: vi.fn().mockResolvedValue(undefined) } as unknown as BullMqCheckJobPublisher,
      { dispatchDue: vi.fn().mockResolvedValue([]) } as unknown as ScheduledRoundRepository,
      { flushDue } as unknown as AvailabilityRepository,
      config,
    );
    runtime.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(flushDue).toHaveBeenCalledTimes(2);
    expect(processNext.mock.calls.length).toBeGreaterThan(1);
    expect(log).toHaveBeenCalledWith('Availability flush dependency failure.');
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_DATABASE_DETAIL');
    await runtime.beforeApplicationShutdown();
  });

  it('waits for an in-flight flush during shutdown without waiting out the idle interval', async () => {
    vi.useFakeTimers();
    let finish!: (count: number) => void;
    const flushDue = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    const runtime = new WorkerRuntime(
      { processNext: vi.fn().mockResolvedValue('IDLE') } as unknown as CheckOutboxRelay,
      { close: vi.fn().mockResolvedValue(undefined) } as unknown as BullMqCheckJobConsumer,
      { close: vi.fn().mockResolvedValue(undefined) } as unknown as BullMqCheckJobPublisher,
      { dispatchDue: vi.fn().mockResolvedValue([]) } as unknown as ScheduledRoundRepository,
      { flushDue } as unknown as AvailabilityRepository,
      config,
    );
    runtime.onApplicationBootstrap();
    const stopped = vi.fn();
    const shutdown = runtime.beforeApplicationShutdown().then(stopped);
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).not.toHaveBeenCalled();
    finish(0);
    await shutdown;
    expect(stopped).toHaveBeenCalledOnce();
    expect(flushDue).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs and shuts down the outbox and scheduled-dispatch loops independently', async () => {
    vi.useFakeTimers();
    const processNext = vi.fn().mockResolvedValue('IDLE');
    const dispatchDue = vi.fn().mockResolvedValue([]);
    const flushDue = vi.fn().mockResolvedValue(0);
    const closeConsumer = vi.fn().mockResolvedValue(undefined);
    const closePublisher = vi.fn().mockResolvedValue(undefined);
    const runtime = new WorkerRuntime(
      { processNext } as unknown as CheckOutboxRelay,
      { close: closeConsumer } as unknown as BullMqCheckJobConsumer,
      { close: closePublisher } as unknown as BullMqCheckJobPublisher,
      { dispatchDue } as unknown as ScheduledRoundRepository,
      { flushDue } as unknown as AvailabilityRepository,
      config,
    );

    runtime.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);

    expect(processNext).toHaveBeenCalledOnce();
    expect(dispatchDue).toHaveBeenCalledWith(100);
    expect(flushDue).toHaveBeenCalledWith(100, 60_000);

    const stopping = runtime.beforeApplicationShutdown();
    await stopping;
    expect(vi.getTimerCount()).toBe(0);
    expect(closeConsumer).toHaveBeenCalledOnce();

    await runtime.onApplicationShutdown();
    expect(closePublisher).toHaveBeenCalledOnce();
  });

  it('runs concurrent webhook loops and waits for in-flight delivery without waiting out idle polls', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const processWebhook = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<'DELIVERED'>((resolve) => {
            finish = () => resolve('DELIVERED');
          }),
      )
      .mockResolvedValue('IDLE');
    const runtime = new WorkerRuntime(
      { processNext: vi.fn().mockResolvedValue('IDLE') } as unknown as CheckOutboxRelay,
      { close: vi.fn().mockResolvedValue(undefined) } as unknown as BullMqCheckJobConsumer,
      { close: vi.fn().mockResolvedValue(undefined) } as unknown as BullMqCheckJobPublisher,
      { dispatchDue: vi.fn().mockResolvedValue([]) } as unknown as ScheduledRoundRepository,
      { flushDue: vi.fn().mockResolvedValue(0) } as unknown as AvailabilityRepository,
      config,
      { processNext: processWebhook },
    );
    runtime.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(processWebhook).toHaveBeenCalledTimes(2);
    const stopped = vi.fn();
    const shutdown = runtime.beforeApplicationShutdown().then(stopped);
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).not.toHaveBeenCalled();
    finish();
    await shutdown;
    expect(stopped).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries webhook dependency failures without logging sensitive error details', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const processWebhook = vi
      .fn()
      .mockRejectedValueOnce(new Error('WATCHRAIL_SENTINEL_SIGNING_SECRET'))
      .mockResolvedValue('IDLE');
    const runtime = new WorkerRuntime(
      { processNext: vi.fn().mockResolvedValue('IDLE') } as unknown as CheckOutboxRelay,
      { close: vi.fn().mockResolvedValue(undefined) } as unknown as BullMqCheckJobConsumer,
      { close: vi.fn().mockResolvedValue(undefined) } as unknown as BullMqCheckJobPublisher,
      { dispatchDue: vi.fn().mockResolvedValue([]) } as unknown as ScheduledRoundRepository,
      { flushDue: vi.fn().mockResolvedValue(0) } as unknown as AvailabilityRepository,
      { ...config, webhookDeliveryConcurrency: 1 },
      { processNext: processWebhook },
    );

    runtime.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(config.dependencyErrorDelayMs);

    expect(processWebhook).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith('Webhook delivery dependency failure.');
    expect(JSON.stringify(error.mock.calls)).not.toContain('WATCHRAIL_SENTINEL_SIGNING_SECRET');
    await runtime.beforeApplicationShutdown();
  });
});
