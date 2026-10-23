import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMailTransport, loadMailConfig } from './mail.js';

describe('console mail transport', () => {
  afterEach(() => vi.restoreAllMocks());

  it('redacts OTPs by default', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const transport = createMailTransport({
      provider: 'console',
      from: 'Watchrail <noreply@example.test>',
    });

    await transport.sendOTP({ to: 'user@example.test', otp: '123456' });

    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.join(' ')).not.toContain('123456');
    expect(log.mock.calls[0]?.join(' ')).not.toContain('user@example.test');
  });

  it('refuses the non-delivering console provider in production', () => {
    expect(() =>
      loadMailConfig({
        NODE_ENV: 'production',
        MAIL_PROVIDER: 'console',
      }),
    ).toThrow('MAIL_PROVIDER=console cannot be used in production.');
  });
});
