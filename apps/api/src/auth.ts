/**
 * Better Auth instance for Watchrail.
 *
 * This module is imported by the NestJS AppModule and provides:
 *  - Email OTP authentication (6-digit codes, no passwords)
 *  - GitHub / GitLab / Google OAuth social providers
 *  - Organization plugin (multi-tenancy, membership, invitations)
 *  - Bearer token plugin (converts Bearer tokens to sessions for API key support)
 *
 * It is mounted in main.ts so that all /api/auth/* requests are handled
 * directly by Better Auth before NestJS routes see them.
 */

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { organization } from 'better-auth/plugins/organization';
import { bearer } from 'better-auth/plugins/bearer';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  authUser,
  authSession,
  authAccount,
  authVerification,
  authOrganization,
  authMember,
  authInvitation,
} from '@watchrail/db';
import { createMailTransport, type MailConfig, type MailTransport } from './mail.js';
import { organizationAccessControl, organizationRoles } from './permissions.js';

export interface AuthConfig {
  baseUrl: string;
  secret: string;
  trustedOrigins: string[];
  mail: MailConfig;
  github?: { clientId: string; clientSecret: string } | undefined;
  gitlab?: { clientId: string; clientSecret: string } | undefined;
  google?: { clientId: string; clientSecret: string } | undefined;
  otpExpiresInSeconds: number;
  mailTransport?: MailTransport;
}

export type WatchrailAuth = ReturnType<typeof createAuth>;

export function createAuth(db: NodePgDatabase<Record<string, unknown>>, config: AuthConfig) {
  const mailer = config.mailTransport ?? createMailTransport(config.mail);

  const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
  if (config.github) socialProviders['github'] = config.github;
  if (config.gitlab) socialProviders['gitlab'] = config.gitlab;
  if (config.google) socialProviders['google'] = config.google;

  const instance = betterAuth({
    baseURL: config.baseUrl,
    secret: config.secret,
    trustedOrigins: config.trustedOrigins,

    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: authUser,
        session: authSession,
        account: authAccount,
        verification: authVerification,
        organization: authOrganization,
        member: authMember,
        invitation: authInvitation,
      },
    }),

    // ─── Authentication methods ──────────────────────────────────────────────

    emailAndPassword: {
      enabled: false,
    },

    socialProviders,

    // ─── Plugins ─────────────────────────────────────────────────────────────

    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: config.otpExpiresInSeconds,
        allowedAttempts: 5,
        storeOTP: 'hashed',
        resendStrategy: 'rotate',
        rateLimit: { window: 60, max: 3 },

        sendVerificationOTP: async ({ email, otp, type }) => {
          if (type === 'sign-in') {
            await mailer.sendOTP({ to: email, otp });
          }
        },
      }),

      organization({
        allowUserToCreateOrganization: true,
        creatorRole: 'owner',
        ac: organizationAccessControl,
        roles: organizationRoles,
      }),

      // Converts Authorization: Bearer <token> to a session cookie,
      // enabling API clients to authenticate with bearer tokens.
      bearer(),
    ],

    // ─── Session ─────────────────────────────────────────────────────────────

    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24, // refresh session token daily
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes
      },
    },

    // ─── User lifecycle hooks ─────────────────────────────────────────────────

    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            // Provision a personal workspace on every new sign-up.
            const slug = `personal-${user.id.slice(0, 8)}`;
            try {
              await instance.api.createOrganization({
                body: {
                  name: `${user.name}'s Workspace`,
                  slug,
                  userId: user.id,
                },
              });
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              // Duplicate slug means the org was already created (idempotent).
              if (!message.includes('UNIQUE') && !message.includes('unique')) {
                throw err;
              }
            }
          },
        },
      },
    },

    // ─── Advanced ────────────────────────────────────────────────────────────

    advanced: {
      database: {
        generateId: 'uuid',
      },
      useSecureCookies: process.env.NODE_ENV === 'production',
      defaultCookieAttributes: {
        sameSite: 'lax',
        httpOnly: true,
        path: '/',
      },
    },
  });

  return instance;
}
