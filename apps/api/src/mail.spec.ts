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
  });

  it('prints the OTP only when explicitly enabled outside production', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const config = loadMailConfig({
      NODE_ENV: 'development',
      MAIL_PROVIDER: 'console',
      MAIL_CONSOLE_SHOW_OTP: 'true',
    });

    await createMailTransport(config).sendOTP({
      to: 'user@example.test',
      otp: '654321',
    });

    expect(log).toHaveBeenCalledWith('[mail] Development OTP for user@example.test: 654321');
  });

  it('refuses console OTP disclosure in production', () => {
    expect(() =>
      loadMailConfig({
        NODE_ENV: 'production',
        MAIL_PROVIDER: 'console',
        MAIL_CONSOLE_SHOW_OTP: 'true',
      }),
    ).toThrow('MAIL_CONSOLE_SHOW_OTP cannot be true in production.');
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
