import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledRoundRepository } from '@watchrail/db';
import type { BullMqCheckJobConsumer, BullMqCheckJobPublisher } from '@watchrail/queue';
import type { CheckOutboxRelay } from './check-outbox-relay.js';
import type { WorkerConfig } from './config.js';
import { WorkerRuntime } from './worker-runtime.js';

const config = {
  idlePollIntervalMs: 500,
  dependencyErrorDelayMs: 1_000,
  scheduleDispatchBatchSize: 100,
  scheduleIdlePollIntervalMs: 1_000,
} as WorkerConfig;

describe('WorkerRuntime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs and shuts down the outbox and scheduled-dispatch loops independently', async () => {
    vi.useFakeTimers();
    const processNext = vi.fn().mockResolvedValue('IDLE');
    const dispatchDue = vi.fn().mockResolvedValue([]);
    const closeConsumer = vi.fn().mockResolvedValue(undefined);
    const closePublisher = vi.fn().mockResolvedValue(undefined);
    const runtime = new WorkerRuntime(
      { processNext } as unknown as CheckOutboxRelay,
      { close: closeConsumer } as unknown as BullMqCheckJobConsumer,
      { close: closePublisher } as unknown as BullMqCheckJobPublisher,
      { dispatchDue } as unknown as ScheduledRoundRepository,
      config,
    );

    runtime.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);

    expect(processNext).toHaveBeenCalledOnce();
    expect(dispatchDue).toHaveBeenCalledWith(100);

    const stopping = runtime.beforeApplicationShutdown();
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;
    expect(closeConsumer).toHaveBeenCalledOnce();

    await runtime.onApplicationShutdown();
    expect(closePublisher).toHaveBeenCalledOnce();
  });
});
