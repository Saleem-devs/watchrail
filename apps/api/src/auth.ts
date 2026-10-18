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
  eq,
  AuthEmailOutboxRepository,
  type AuthEmailKeyring,
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
  authEmailKeyring?: AuthEmailKeyring;
}

export type WatchrailAuth = ReturnType<typeof createAuth>;

export function createAuth(db: NodePgDatabase<Record<string, unknown>>, config: AuthConfig) {
  const mailer = config.mailTransport ?? createMailTransport(config.mail);
  const emailOutbox = config.authEmailKeyring ? new AuthEmailOutboxRepository(db as never) : null;

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
            if (emailOutbox && config.authEmailKeyring) {
              // Do not delete Better Auth's verification record on staging failure:
              // another concurrent resend may already have replaced it.
              // Failed delivery intent leaves an undisclosed, short-lived OTP to expire.
              await emailOutbox.stage({
                kind: 'OTP',
                recipient: email,
                supersessionKey: `otp:sign-in:${email.toLowerCase()}`,
                payload: { type: 'OTP', to: email, otp },
                expiresAt: new Date(Date.now() + config.otpExpiresInSeconds * 1000),
                keyring: config.authEmailKeyring,
              });
            } else {
              await mailer.sendOTP({ to: email, otp });
            }
          }
        },
      }),

      organization({
        allowUserToCreateOrganization: true,
        creatorRole: 'owner',
        ac: organizationAccessControl,
        roles: organizationRoles,
        sendInvitationEmail: async (invitation) => {
          if (!emailOutbox || !config.authEmailKeyring) {
            throw new Error('Durable invitation email delivery is unavailable.');
          }
          try {
            await emailOutbox.stage({
              kind: 'INVITATION',
              recipient: invitation.email,
              supersessionKey: `invitation:${invitation.id}`,
              payload: {
                type: 'INVITATION',
                to: invitation.email,
                invitationId: invitation.id,
                organizationName: invitation.organization.name,
                inviterName: invitation.inviter.user.name,
                frontendOrigin: config.trustedOrigins[0],
              },
              expiresAt: new Date(invitation.invitation.expiresAt),
              keyring: config.authEmailKeyring,
            });
          } catch (error) {
            await db.delete(authInvitation).where(eq(authInvitation.id, invitation.id));
            throw error;
          }
        },
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
            await ensurePersonalWorkspace(user.id, user.name, user.email);
          },
        },
      },
      session: {
        create: {
          after: async (session) => {
            const [user] = await db
              .select({ name: authUser.name, email: authUser.email })
              .from(authUser)
              .where(eq(authUser.id, session.userId))
              .limit(1);
            if (user) await ensurePersonalWorkspace(session.userId, user.name, user.email);
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

  async function ensurePersonalWorkspace(
    userId: string,
    userName: string,
    userEmail: string,
  ): Promise<void> {
    const slug = `personal-${userId.slice(0, 8)}`;
    const fallbackName = userEmail.split('@')[0]?.trim() || 'Personal';
    const workspaceName = `${userName.trim() || fallbackName}'s Workspace`;
    const [existing] = await db
      .select({
        id: authMember.id,
        organizationId: authOrganization.id,
        organizationName: authOrganization.name,
        organizationSlug: authOrganization.slug,
      })
      .from(authMember)
      .innerJoin(authOrganization, eq(authOrganization.id, authMember.organizationId))
      .where(eq(authMember.userId, userId))
      .limit(1);
    if (existing) {
      // Repair only the malformed name produced by the original passwordless
      // onboarding path. Never overwrite a name chosen by an operator.
      if (existing.organizationSlug === slug && existing.organizationName === "'s Workspace") {
        await db
          .update(authOrganization)
          .set({ name: workspaceName })
          .where(eq(authOrganization.id, existing.organizationId));
      }
      return;
    }

    try {
      await instance.api.createOrganization({
        body: {
          name: workspaceName,
          slug,
          userId,
        },
      });
    } catch (err: unknown) {
      // A concurrent sign-in or the original sign-up hook may have won. Verify
      // durable membership rather than treating every uniqueness failure as
      // successful onboarding.
      const [repaired] = await db
        .select({ id: authMember.id })
        .from(authMember)
        .where(eq(authMember.userId, userId))
        .limit(1);
      if (!repaired) throw err;
    }
  }

  return instance;
}
