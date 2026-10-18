import { describe, expect, it } from 'vitest';
import { parseDeliverAuthEmailJob } from './auth-email-job.js';

describe('deliver auth email job', () => {
  it('accepts only the version and opaque message identity', () => {
    expect(
      parseDeliverAuthEmailJob({
        contractVersion: 1,
        messageId: '72dc5a63-9ab0-4bf7-898d-778b2bb22af7',
      }),
    ).toEqual({
      contractVersion: 1,
      messageId: '72dc5a63-9ab0-4bf7-898d-778b2bb22af7',
    });
  });

  it.each([
    null,
    {},
    { contractVersion: 2, messageId: '72dc5a63-9ab0-4bf7-898d-778b2bb22af7' },
    { contractVersion: 1, messageId: 'not-a-uuid' },
    {
      contractVersion: 1,
      messageId: '72dc5a63-9ab0-4bf7-898d-778b2bb22af7',
      otp: '123456',
    },
  ])('rejects malformed or secret-bearing jobs', (value) => {
    expect(() => parseDeliverAuthEmailJob(value)).toThrow('Invalid auth email job.');
  });
});
