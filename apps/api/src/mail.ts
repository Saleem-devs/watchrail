/**
 * Mail transport for Watchrail.
 *
 * In development/test, messages are logged to stdout (no actual delivery).
 * In production, a real SMTP/API provider must be configured.
 *
 * Provider selection is driven by MAIL_PROVIDER:
 *   - "console"  – log to stdout (default in development)
 *   - "smtp"     – use SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
 *
 * Nodemailer is used as the underlying transport layer.
 * No OTPs or secrets are written to logs.
 */

import nodemailer from 'nodemailer';

export interface MailConfig {
  provider: 'console' | 'smtp';
  from: string;
  showConsoleOtp?: boolean;
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    pass?: string;
  };
}

export interface MailTransport {
  sendOTP(options: { to: string; otp: string }): Promise<void>;
}

export function createMailTransport(config: MailConfig): MailTransport {
  if (config.provider === 'console') {
    return {
      sendOTP({ to, otp }) {
        if (config.showConsoleOtp) {
          console.log(`[mail] Development OTP for ${to}: ${otp}`);
        } else {
          console.log(
            `[mail] OTP delivery suppressed for ${to}; configure SMTP or enable MAIL_CONSOLE_SHOW_OTP outside production.`,
          );
        }
        return Promise.resolve();
      },
    };
  }

  if (config.provider === 'smtp') {
    if (!config.smtp) throw new Error('SMTP config is required when MAIL_PROVIDER=smtp');

    const transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth:
        config.smtp.user && config.smtp.pass
          ? { user: config.smtp.user, pass: config.smtp.pass }
          : undefined,
    });

    return {
      async sendOTP({ to, otp }) {
        await transporter.sendMail({
          from: config.from,
          to,
          subject: 'Your Watchrail sign-in code',
          text: `Your sign-in code is: ${otp}\n\nThis code expires in 10 minutes. Do not share it with anyone.`,
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
              <h2 style="color:#070b0c">Sign in to Watchrail</h2>
              <p>Your sign-in code is:</p>
              <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#63f5af;margin:24px 0">${otp}</div>
              <p style="color:#666;font-size:14px">This code expires in 10 minutes. Do not share it with anyone.</p>
            </div>
          `,
        });
      },
    };
  }

  throw new Error(`Unknown MAIL_PROVIDER: ${config.provider as string}`);
}

export function loadMailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig {
  const provider = (env.MAIL_PROVIDER ?? 'console') as MailConfig['provider'];
  const from = env.MAIL_FROM ?? 'Watchrail <noreply@watchrail.dev>';
  const showConsoleOtp = parseBoolean(env.MAIL_CONSOLE_SHOW_OTP, 'MAIL_CONSOLE_SHOW_OTP');

  if (showConsoleOtp && env.NODE_ENV === 'production') {
    throw new Error('MAIL_CONSOLE_SHOW_OTP cannot be true in production.');
  }

  if (provider === 'smtp') {
    const host = env.SMTP_HOST;
    if (!host) throw new Error('SMTP_HOST is required when MAIL_PROVIDER=smtp');

    return {
      provider,
      from,
      smtp: {
        host,
        port: Number(env.SMTP_PORT ?? 587),
        secure: env.SMTP_SECURE === 'true',
        ...(env.SMTP_USER ? { user: env.SMTP_USER } : {}),
        ...(env.SMTP_PASS ? { pass: env.SMTP_PASS } : {}),
      },
    };
  }

  if (provider !== 'console') {
    throw new Error('MAIL_PROVIDER must be console or smtp.');
  }

  return { provider, from, showConsoleOtp };
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} must be true or false.`);
}
