/**
 * Better Auth browser client for Watchrail.
 *
 * The client targets /api/auth, which Next.js rewrites to the NestJS API
 * (see next.config.ts). All auth operations therefore reach Better Auth
 * running inside the NestJS process without any cross-origin issues.
 *
 * Plugins:
 *   - organizationClient: org switching, member management, invitations.
 *   - emailOTPClient:    send / verify 6-digit OTP codes.
 */

import { createAuthClient } from 'better-auth/react';
import { organizationClient } from 'better-auth/client/plugins';
import { emailOTPClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  plugins: [organizationClient(), emailOTPClient()],
});

export async function ensureActiveOrganization(): Promise<boolean> {
  const session = await authClient.getSession();
  if (session.data?.session.activeOrganizationId) return true;

  const organizations = await authClient.organization.list();
  const first = organizations.data?.[0];
  if (!first) return false;

  const activated = await authClient.organization.setActive({
    organizationId: first.id,
  });
  return activated.error == null;
}

export type Session = Awaited<ReturnType<typeof authClient.getSession>>['data'];
