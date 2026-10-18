import nodemailer from 'nodemailer';
import {
  decryptAuthEmail,
  type AuthEmailKeyring,
  type AuthEmailOutboxRepository,
} from '@watchrail/db';
import type { BullMqAuthEmailPublisher } from '@watchrail/queue';

export class AuthEmailOutboxRelay {
  constructor(
    private readonly outbox: AuthEmailOutboxRepository,
    private readonly publisher: BullMqAuthEmailPublisher,
  ) {}
  async processNext(): Promise<'IDLE' | 'PUBLISHED' | 'RETRY' | 'LOST_CLAIM'> {
    const claim = await this.outbox.claimNext(30_000);
    if (!claim) return 'IDLE';
    try {
      await this.publisher.publish(claim.id);
      return (await this.outbox.markPublished(claim.id, claim.claimToken))
        ? 'PUBLISHED'
        : 'LOST_CLAIM';
    } catch {
      return (await this.outbox.release(
        claim.id,
        claim.claimToken,
        new Date(Date.now() + 5_000),
        'QUEUE_UNAVAILABLE',
      ))
        ? 'RETRY'
        : 'LOST_CLAIM';
    }
  }
}

export class AuthEmailJobHandler {
  private readonly transport: ReturnType<typeof nodemailer.createTransport>;
  private readonly from: string;
  constructor(
    private readonly outbox: AuthEmailOutboxRepository,
    private readonly keyring: AuthEmailKeyring,
    smtp: {
      host: string;
      port: number;
      secure: boolean;
      user?: string;
      pass?: string;
      from: string;
    },
  ) {
    this.from = smtp.from;
    this.transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user && smtp.pass ? { user: smtp.user, pass: smtp.pass } : undefined,
    });
  }

  async handle(messageId: string): Promise<void> {
    const message = await this.outbox.forDelivery(messageId);
    if (!message) return;
    const payload = decryptAuthEmail(message.encryptedPayload, message.id, this.keyring) as Record<
      string,
      unknown
    >;
    if (
      payload['type'] === 'OTP' &&
      typeof payload['to'] === 'string' &&
      payload['to'].length <= 320 &&
      typeof payload['otp'] === 'string' &&
      /^\d{6}$/u.test(payload['otp'])
    ) {
      await this.send({
        from: this.from,
        to: payload['to'],
        subject: 'Your Watchrail sign-in code',
        text: `Your sign-in code is: ${payload['otp']}`,
      });
    } else if (
      payload['type'] === 'INVITATION' &&
      typeof payload['to'] === 'string' &&
      payload['to'].length <= 320 &&
      typeof payload['invitationId'] === 'string' &&
      payload['invitationId'].length >= 1 &&
      payload['invitationId'].length <= 200 &&
      typeof payload['organizationName'] === 'string' &&
      payload['organizationName'].length <= 120 &&
      typeof payload['frontendOrigin'] === 'string' &&
      isHttpOrigin(payload['frontendOrigin'])
    ) {
      // Revocation, acceptance and expiry may happen after the email was queued.
      // Checking the outbox alone is insufficient (Better Auth can cancel directly).
      if (!(await this.outbox.isInvitationPending(payload['invitationId']))) {
        await this.outbox.markFailed(messageId, 'INVITATION_INACTIVE');
        return;
      }
      const url = `${payload['frontendOrigin']}/accept-invitation?id=${encodeURIComponent(payload['invitationId'])}`;
      await this.send({
        from: this.from,
        to: payload['to'],
        subject: `You're invited to join ${String(payload['organizationName'])} on Watchrail`,
        text: `Accept your invitation: ${url}`,
      });
    } else {
      await this.outbox.markFailed(messageId, 'INVALID_PAYLOAD');
      return;
    }
    await this.outbox.markDelivered(messageId);
  }

  markTerminalFailure(messageId: string): Promise<void> {
    return this.outbox.markFailed(messageId, 'DELIVERY_RETRIES_EXHAUSTED');
  }

  private async send(message: Parameters<typeof this.transport.sendMail>[0]): Promise<void> {
    try {
      await this.transport.sendMail(message);
    } catch {
      throw new Error('Auth email delivery failed.');
    }
  }
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}
