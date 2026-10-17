import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  authMember,
  authOrganization,
  createDatabaseConnection,
  createWatchrailDatabase,
  migrateDatabase,
  type WatchrailDatabase,
} from '@watchrail/db';
import { eq } from '@watchrail/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth } from '../src/auth.js';

describe('passwordless identity provisioning', () => {
  let container: StartedPostgreSqlContainer;
  let database: WatchrailDatabase;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    const migrationConnection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(migrationConnection, resolve(process.cwd(), '../../packages/db/drizzle'));
    await migrationConnection.pool.end();
    database = createWatchrailDatabase(container.getConnectionUri());
  });

  afterAll(async () => {
    await database?.$client.end();
    await container?.stop();
  });

  it('signs in with an OTP and provisions one UUID-backed personal workspace', async () => {
    const delivered = new Map<string, string>();
    const email = `identity-${randomUUID()}@example.test`;
    const auth = createAuth(database, {
      baseUrl: 'http://localhost:4000',
      secret: 'identity-integration-secret-with-at-least-32-characters',
      trustedOrigins: ['http://localhost:3010'],
      otpExpiresInSeconds: 600,
      mail: { provider: 'console', from: 'Watchrail <noreply@example.test>' },
      mailTransport: {
        sendOTP({ to, otp }) {
          delivered.set(to, otp);
          return Promise.resolve();
        },
      },
    });

    await auth.api.sendVerificationOTP({
      body: { email, type: 'sign-in' },
    });

    const otp = delivered.get(email);
    expect(otp).toMatch(/^\d{6}$/u);

    const signedIn = await auth.api.signInEmailOTP({
      body: { email, otp: otp! },
    });

    expect(signedIn.user.email).toBe(email);
    expect(signedIn.token).toEqual(expect.any(String));

    const memberships = await database
      .select({
        role: authMember.role,
        organizationId: authMember.organizationId,
        organizationName: authOrganization.name,
      })
      .from(authMember)
      .innerJoin(authOrganization, eq(authOrganization.id, authMember.organizationId))
      .where(eq(authMember.userId, signedIn.user.id));

    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({
      role: 'owner',
      organizationName: expect.stringContaining('Workspace'),
    });
    expect(memberships[0]?.organizationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );

    const headers = new Headers({ authorization: `Bearer ${signedIn.token}` });
    await auth.api.setActiveOrganization({
      body: { organizationId: memberships[0]!.organizationId },
      headers,
    });
    const session = await auth.api.getSession({ headers });
    expect(session?.session.activeOrganizationId).toBe(memberships[0]?.organizationId);
  });
});
