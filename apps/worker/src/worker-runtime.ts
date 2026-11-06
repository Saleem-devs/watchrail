import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { BullMqCheckJobConsumer, BullMqCheckJobPublisher } from '@watchrail/queue';
import type { BullMqAuthEmailConsumer, BullMqAuthEmailPublisher } from '@watchrail/queue';
import type { AuthEmailOutboxRelay } from './auth-email-worker.js';
import type {
  AvailabilityRepository,
  MultiLocationRoundFinalizationRepository,
  ProbeCoordinatorRepository,
  ScheduledRoundRepository,
  HeartbeatRepository,
} from '@watchrail/db';
import type { CheckOutboxRelay } from './check-outbox-relay.js';
import type { WorkerConfig } from './config.js';
import type { WebhookDeliveryCycleResult } from './webhook-delivery-worker.js';
import type { EmailNotificationCycleResult } from './email-notification-worker.js';

interface WebhookDeliveryProcessor {
  processNext(): Promise<WebhookDeliveryCycleResult>;
}
interface EmailNotificationProcessor {
  processNext(): Promise<EmailNotificationCycleResult>;
}

@Injectable()
export class WorkerRuntime
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerRuntime.name);
  private stopping = false;
  private outboxRunning: Promise<void> | undefined;
  private schedulerRunning: Promise<void> | undefined;
  private heartbeatRunning: Promise<void> | undefined;
  private availabilityRunning: Promise<void> | undefined;
  private probeReconciliationRunning: Promise<void> | undefined;
  private roundFinalizationRunning: Promise<void> | undefined;
  private webhookRunning: Promise<void>[] = [];
  private emailNotificationRunning: Promise<void>[] = [];
  private authEmailRunning: Promise<void> | undefined;
  private readonly wakeups = new Set<() => void>();

  constructor(
    private readonly relay: CheckOutboxRelay,
    private readonly consumer: BullMqCheckJobConsumer,
    private readonly publisher: BullMqCheckJobPublisher,
    private readonly scheduledRounds: ScheduledRoundRepository,
    private readonly availability: AvailabilityRepository,
    private readonly config: WorkerConfig,
    private readonly webhookDelivery?: WebhookDeliveryProcessor,
    private readonly probeCoordinator?: ProbeCoordinatorRepository,
    private readonly multiLocationFinalization?: MultiLocationRoundFinalizationRepository,
    private readonly authEmailRelay?: AuthEmailOutboxRelay,
    private readonly authEmailConsumer?: BullMqAuthEmailConsumer,
    private readonly authEmailPublisher?: BullMqAuthEmailPublisher,
    private readonly heartbeats?: HeartbeatRepository,
    private readonly emailNotifications?: EmailNotificationProcessor,
  ) {}

  onApplicationBootstrap(): void {
    this.outboxRunning = this.runOutboxRelay();
    this.schedulerRunning = this.runScheduledDispatch();
    this.heartbeatRunning = this.heartbeats ? this.runHeartbeatEvaluation() : undefined;
    this.availabilityRunning = this.runAvailabilityFlush();
    this.probeReconciliationRunning = this.probeCoordinator
      ? this.runProbeReconciliation()
      : undefined;
    this.roundFinalizationRunning = this.multiLocationFinalization
      ? this.runRoundFinalization()
      : undefined;
    this.webhookRunning = this.webhookDelivery
      ? Array.from({ length: this.config.webhookDeliveryConcurrency }, () =>
          this.runWebhookDelivery(),
        )
      : [];
    this.authEmailRunning = this.authEmailRelay ? this.runAuthEmailRelay() : undefined;
    this.emailNotificationRunning = this.emailNotifications
      ? Array.from({ length: this.config.emailNotificationConcurrency }, () =>
          this.runEmailNotifications(),
        )
      : [];
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    for (const wakeup of this.wakeups) wakeup();
    await Promise.all([
      this.outboxRunning,
      this.schedulerRunning,
      this.heartbeatRunning,
      this.availabilityRunning,
      this.probeReconciliationRunning,
      this.roundFinalizationRunning,
      ...this.webhookRunning,
      ...this.emailNotificationRunning,
      this.authEmailRunning,
      this.consumer.close(),
      this.authEmailConsumer?.close(),
    ]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.publisher.close();
    await this.authEmailPublisher?.close();
  }

  private async runAuthEmailRelay(): Promise<void> {
    while (!this.stopping) {
      try {
        const result = await this.authEmailRelay!.processNext();
        if (result === 'IDLE') await this.wait(this.config.idlePollIntervalMs);
      } catch {
        this.logger.error('Auth email outbox relay dependency failure.');
        await this.wait(this.config.dependencyErrorDelayMs);
      }
    }
  }

  private async runOutboxRelay(): Promise<void> {
    while (!this.stopping) {
      try {
        const result = await this.relay.processNext();

        if (result === 'IDLE') {
          await this.wait(this.config.idlePollIntervalMs);
        } else if (result === 'BLOCKED_INVALID') {
          this.logger.error('Blocked an invalid check-round outbox event.');
        } else if (result === 'LOST_CLAIM') {
          this.logger.warn('An outbox relay claim expired before its final update.');
        }
      } catch (error) {
        this.logger.error(
          error instanceof Error ? error.message : 'Unknown outbox relay dependency failure.',
        );
        await this.wait(this.config.dependencyErrorDelayMs);
      }
    }
  }

  private async runScheduledDispatch(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.scheduledRounds.dispatchDue(this.config.scheduleDispatchBatchSize);
        await this.wait(this.config.scheduleIdlePollIntervalMs);
      } catch (error) {
        this.logger.error(
          error instanceof Error ? error.message : 'Unknown scheduled dispatch dependency failure.',
        );
        await this.wait(this.config.dependencyErrorDelayMs);
      }
    }
  }
  private async runHeartbeatEvaluation(): Promise<void> {
    while (!this.stopping) {
      try {
        const count = await this.heartbeats!.evaluateDue(this.config.scheduleDispatchBatchSize);
        if (count < this.config.scheduleDispatchBatchSize) {
          await this.wait(this.config.scheduleIdlePollIntervalMs);
        }
      } catch (error) {
        this.logger.error(
          error instanceof Error ? error.message : 'Unknown heartbeat evaluation failure.',
        );
        await this.wait(this.config.dependencyErrorDelayMs);
      }
    }
  }
  private async runAvailabilityFlush(): Promise<void> {
    while (!this.stopping) {
      try {
        const count = await this.availability.flushDue(
          this.config.availabilityFlushBatchSize,
          this.config.availabilityFlushIntervalMs,
        );
        if (count < this.config.availabilityFlushBatchSize) {
          await this.wait(this.config.availabilityFlushIntervalMs);
        }
      } catch {
        this.logger.error('Availability flush dependency failure.');
        await this.wait(this.config.dependencyErrorDelayMs);
      }
    }
  }

  private async runWebhookDelivery(): Promise<void> {
    while (!this.stopping) {
      try {
        const result = await this.webhookDelivery!.processNext();
        if (result === 'IDLE') {
          await this.wait(this.config.webhookDeliveryIdlePollIntervalMs);
        } else if (result === 'LOST_CLAIM') {
          this.logger.warn('A webhook delivery claim expired before its final update.');
        }
      } catch {
        this.logger.error('Webhook delivery dependency failure.');
        await this.wait(this.config.dependencyErrorDelayMs);
      }
    }
  }

  private async runEmailNotifications(): Promise<void> {
    while (!this.stopping) {
      try {
        const result = await this.emailNotifications!.processNext();
        if (result === 'IDLE') await this.wait(this.config.webhookDeliveryIdlePollIntervalMs);
        else if (result === 'LOST_CLAIM')
          this.logger.warn('An email notification claim expired before its final update.');
      } catch {
        this.logger.error('Email notification delivery dependency failure.');
        await this.wait(this.config.dependencyErrorDelayMs);
      }
    }
  }

  private async runProbeReconciliation(): Promise<void> {
    while (!this.stopping) {
      try {
        const count = await this.probeCoordinator!.reconcileExpired(
          this.config.probeReconciliationBatchSize,
          this.config.probePendingAssignmentTimeoutMs,
        );
        if (count < this.config.probeReconciliationBatchSize) {
          await this.wait(this.config.probeReconciliationIntervalMs);
        }
      } catch {
        this.logger.error('Probe lease reconciliation dependency failure.');
        await this.wait(this.config.dependencyErrorDelayMs);
      }
    }
  }

  private async runRoundFinalization(): Promise<void> {
    while (!this.stopping) {
      try {
        const count = await this.multiLocationFinalization!.finalizeDue(
          this.config.probeReconciliationBatchSize,
        );
        if (count < this.config.probeReconciliationBatchSize) {
          await this.wait(this.config.probeReconciliationIntervalMs);
        }
      } catch {
        this.logger.error('Multi-location round finalization dependency failure.');
        await this.wait(this.config.dependencyErrorDelayMs);
      }
    }
  }

  private wait(milliseconds: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const wakeup = () => {
        clearTimeout(timer);
        this.wakeups.delete(wakeup);
        resolve();
      };
      const timer = setTimeout(wakeup, milliseconds);
      this.wakeups.add(wakeup);
    });
  }
}
