import { performance } from 'node:perf_hooks';
import {
  decryptAuthEmail,
  type AuthEmailKeyring,
  type StatusPageSubscriptionRepository,
} from '@watchrail/db';
import { withSendDeadline, type NotificationEmailSender } from './email-notification-worker.js';

export class StatusPageEmailWorker {
  constructor(
    private readonly store: StatusPageSubscriptionRepository,
    private readonly sender: NotificationEmailSender,
    private readonly keyring: AuthEmailKeyring,
    private readonly origin: string,
    private readonly options: { leaseMs: number; sendTimeoutMs: number; maxAttempts: number },
  ) {
    if (options.leaseMs < options.sendTimeoutMs + 5000)
      throw new Error('Status email lease is too short.');
  }

  async processNext(): Promise<'IDLE' | 'PROCESSED'> {
    const expanded = await this.store.expandNext();
    const claim = await this.store.claimNext(this.options.leaseMs);
    if (!claim) return expanded ? 'PROCESSED' : 'IDLE';
    if (claim.attempts > this.options.maxAttempts) {
      await this.store.finish(claim.id, claim.token, 'DEAD', 'MAX_ATTEMPTS');
      return 'PROCESSED';
    }
    const started = performance.now();
    const authorized = await this.store.authorize(claim.id, claim.token);
    if (!authorized) {
      await this.store.finish(claim.id, claim.token, 'SUPPRESSED');
      return 'PROCESSED';
    }
    try {
      const details = decryptAuthEmail(
        authorized.details,
        `subscriber:${authorized.subscriberId}:${authorized.generation}`,
        this.keyring,
      ) as { email: string; unsubscribe: string };
      const unsubscribeUrl = `${this.origin}/status/subscriptions/manage#unsubscribe=${encodeURIComponent(details.unsubscribe)}`;
      let subject: string;
      let text: string;
      if (authorized.kind === 'VERIFY') {
        const payload = decryptAuthEmail(
          authorized.payload,
          `status-verification:${claim.id}`,
          this.keyring,
        ) as { verification: string };
        subject = `Confirm your subscription — ${authorized.name}`;
        text = `Confirm your email to receive future incident and maintenance updates from ${authorized.name}.\n\n${this.origin}/status/subscriptions/manage#verify=${encodeURIComponent(payload.verification)}\n\nThis link expires in 24 hours. If you did not request this, ignore this email.\n\nCancel this request: ${unsubscribeUrl}`;
      } else {
        subject = `${authorized.subject} — ${authorized.name}`;
        text = `${authorized.body}\n\nView status: ${this.origin}/status/${encodeURIComponent(authorized.slug)}\n\nUnsubscribe: ${unsubscribeUrl}`;
      }
      // Include authorization-query latency, decryption and rendering in the send budget.
      const timeout = Math.floor(
        Math.min(
          this.options.sendTimeoutMs,
          authorized.remainingMs - (performance.now() - started) - 5000,
        ),
      );
      if (timeout <= 0) {
        await this.store.finish(
          claim.id,
          claim.token,
          claim.attempts >= this.options.maxAttempts ? 'DEAD' : 'PENDING',
          'LEASE_BUDGET_EXHAUSTED',
          5000,
        );
        return 'PROCESSED';
      }
      const result = await withSendDeadline(
        (signal) => this.sender.send({ to: [details.email], subject, text }, { signal }),
        timeout,
      );
      if (!result.accepted.some((value) => value.toLowerCase() === details.email.toLowerCase()))
        throw new Error('SMTP rejected recipient');
      await this.store.finish(claim.id, claim.token, 'DELIVERED');
    } catch {
      await this.store.finish(
        claim.id,
        claim.token,
        claim.attempts >= this.options.maxAttempts ? 'DEAD' : 'PENDING',
        'STATUS_EMAIL_DELIVERY_FAILED',
        Math.min(3_600_000, 5000 * 2 ** Math.min(claim.attempts, 10)),
      );
    }
    return 'PROCESSED';
  }
}
