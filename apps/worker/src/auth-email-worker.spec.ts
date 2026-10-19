import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encryptAuthEmail,
  type AuthEmailKeyring,
  type AuthEmailOutboxRepository,
} from '@watchrail/db';
import type { BullMqAuthEmailPublisher } from '@watchrail/queue';

const sendMail = vi.hoisted(() => vi.fn());
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail }) },
}));

import { AuthEmailJobHandler, AuthEmailOutboxRelay } from './auth-email-worker.js';

const messageId = '72dc5a63-9ab0-4bf7-898d-778b2bb22af7';
const claimToken = '69158a0e-046b-47bc-b610-b4172115642e';
const keyring: AuthEmailKeyring = {
  activeKeyId: 'primary',
  keys: new Map([['primary', Buffer.alloc(32, 9)]]),
};

describe('AuthEmailOutboxRelay', () => {
  it('publishes only the opaque message identity and acknowledges the claim', async () => {
    const outbox = {
      claimNext: vi.fn().mockResolvedValue({ id: messageId, claimToken }),
      markPublished: vi.fn().mockResolvedValue(true),
      release: vi.fn(),
    };
    const publisher = { publish: vi.fn().mockResolvedValue(undefined) };
    const relay = new AuthEmailOutboxRelay(
      outbox as unknown as AuthEmailOutboxRepository,
      publisher as unknown as BullMqAuthEmailPublisher,
    );

    await expect(relay.processNext()).resolves.toBe('PUBLISHED');
    expect(publisher.publish).toHaveBeenCalledWith(messageId);
    expect(outbox.markPublished).toHaveBeenCalledWith(messageId, claimToken);
  });

  it('releases a failed publication without leaking the dependency error', async () => {
    const outbox = {
      claimNext: vi.fn().mockResolvedValue({ id: messageId, claimToken }),
      markPublished: vi.fn(),
      release: vi.fn().mockResolvedValue(true),
    };
    const publisher = { publish: vi.fn().mockRejectedValue(new Error('PRIVATE_REDIS_DETAIL')) };
    const relay = new AuthEmailOutboxRelay(
      outbox as unknown as AuthEmailOutboxRepository,
      publisher as unknown as BullMqAuthEmailPublisher,
    );

    await expect(relay.processNext()).resolves.toBe('RETRY');
    expect(outbox.release).toHaveBeenCalledWith(
      messageId,
      claimToken,
      expect.any(Date),
      'QUEUE_UNAVAILABLE',
    );
  });
});

describe('AuthEmailJobHandler', () => {
  beforeEach(() => sendMail.mockReset().mockResolvedValue(undefined));

  it('decrypts and delivers an OTP before recording completion', async () => {
    const encryptedPayload = encryptAuthEmail(
      { type: 'OTP', to: 'person@example.test', otp: '123456' },
      messageId,
      keyring,
    );
    const outbox = {
      forDelivery: vi.fn().mockResolvedValue({ id: messageId, encryptedPayload }),
      markDelivered: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn(),
    };
    const handler = new AuthEmailJobHandler(
      outbox as unknown as AuthEmailOutboxRepository,
      keyring,
      {
        host: 'smtp.example.test',
        port: 587,
        secure: false,
        from: 'Watchrail <noreply@example.test>',
      },
    );

    await handler.handle(messageId);

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'person@example.test',
        text: expect.stringContaining('123456'),
      }),
    );
    expect(outbox.markDelivered).toHaveBeenCalledWith(messageId);
  });

  it('does not send superseded, expired, or previously delivered messages', async () => {
    const outbox = {
      forDelivery: vi.fn().mockResolvedValue(null),
      markDelivered: vi.fn(),
      markFailed: vi.fn(),
    };
    const handler = new AuthEmailJobHandler(
      outbox as unknown as AuthEmailOutboxRepository,
      keyring,
      {
        host: 'smtp.example.test',
        port: 587,
        secure: false,
        from: 'Watchrail <noreply@example.test>',
      },
    );

    await handler.handle(messageId);

    expect(sendMail).not.toHaveBeenCalled();
    expect(outbox.markDelivered).not.toHaveBeenCalled();
  });

  it('does not deliver an invitation revoked after queue publication', async () => {
    const encryptedPayload = encryptAuthEmail(
      {
        type: 'INVITATION',
        to: 'invitee@example.test',
        invitationId: '72dc5a63-9ab0-4bf7-898d-778b2bb22af7',
        organizationName: 'Example Org',
        frontendOrigin: 'https://watchrail.example.test',
      },
      messageId,
      keyring,
    );
    const outbox = {
      forDelivery: vi.fn().mockResolvedValue({ id: messageId, encryptedPayload }),
      isInvitationPending: vi.fn().mockResolvedValue(false),
      markDelivered: vi.fn(),
      markFailed: vi.fn().mockResolvedValue(undefined),
    };
    const handler = new AuthEmailJobHandler(
      outbox as unknown as AuthEmailOutboxRepository,
      keyring,
      {
        host: 'smtp.example.test',
        port: 587,
        secure: false,
        from: 'Watchrail <noreply@example.test>',
      },
    );

    await handler.handle(messageId);

    expect(outbox.isInvitationPending).toHaveBeenCalledWith('72dc5a63-9ab0-4bf7-898d-778b2bb22af7');
    expect(sendMail).not.toHaveBeenCalled();
    expect(outbox.markFailed).toHaveBeenCalledWith(messageId, 'INVITATION_INACTIVE');
  });

  it('replaces provider failures with a secret-free retry error', async () => {
    const encryptedPayload = encryptAuthEmail(
      { type: 'OTP', to: 'person@example.test', otp: '987654' },
      messageId,
      keyring,
    );
    const outbox = {
      forDelivery: vi.fn().mockResolvedValue({ id: messageId, encryptedPayload }),
      markDelivered: vi.fn(),
      markFailed: vi.fn(),
    };
    sendMail.mockImplementationOnce(() => {
      throw new Error('SMTP rejected person@example.test with one-time code 987654');
    });
    const handler = new AuthEmailJobHandler(
      outbox as unknown as AuthEmailOutboxRepository,
      keyring,
      {
        host: 'smtp.example.test',
        port: 587,
        secure: false,
        from: 'Watchrail <noreply@example.test>',
      },
    );

    const error = await handler.handle(messageId).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Auth email delivery failed.');
    expect(JSON.stringify(error)).not.toContain('person@example.test');
    expect(JSON.stringify(error)).not.toContain('987654');
  });
});
