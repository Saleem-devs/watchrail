import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test } from '@nestjs/testing';
import request from 'supertest';
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
import { AppModule } from '../src/app.module.js';
import { WATCHRAIL_AUTH } from '../src/auth.tokens.js';

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

  it('lets a real production session reach protected reads while enforcing viewer RBAC', async () => {
    const delivered = new Map<string, string>();
    const email = `production-session-${randomUUID()}@example.test`;
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
    await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } });
    const signedIn = await auth.api.signInEmailOTP({
      body: { email, otp: delivered.get(email)! },
    });
    const [membership] = await database
      .select({ id: authMember.id, organizationId: authMember.organizationId })
      .from(authMember)
      .where(eq(authMember.userId, signedIn.user.id));
    expect(membership).toBeDefined();
    const headers = new Headers({ authorization: `Bearer ${signedIn.token}` });
    await auth.api.setActiveOrganization({
      body: { organizationId: membership!.organizationId },
      headers,
    });
    Object.assign(process.env, {
      NODE_ENV: 'production',
      DATABASE_URL: container.getConnectionUri(),
      DEV_IDENTITY_ENABLED: 'false',
      BETTER_AUTH_SECRET: 'production-test-secret-with-at-least-32-characters',
      BETTER_AUTH_URL: 'http://localhost:4000',
      FRONTEND_URL: 'http://localhost:3010',
      MAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example.test',
      PUBLIC_STATUS_PAGE_INTERNAL_TOKEN: 'production-status-page-token-at-least-32-characters',
      HTTP_HEADER_ACTIVE_KEY_ID: 'test',
      HTTP_HEADER_ENCRYPTION_KEYS: JSON.stringify({
        test: Buffer.alloc(32).toString('base64'),
      }),
      ASSERTION_ACTIVE_KEY_ID: 'test',
      ASSERTION_ENCRYPTION_KEYS: JSON.stringify({
        test: Buffer.alloc(32).toString('base64'),
      }),
      WEBHOOK_SIGNING_SECRET_ACTIVE_KEY_ID: 'test',
      WEBHOOK_SIGNING_SECRET_ENCRYPTION_KEYS: JSON.stringify({
        test: Buffer.alloc(32).toString('base64'),
      }),
    });

    const testingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WATCHRAIL_AUTH)
      .useValue(auth)
      .compile();
    const app = testingModule.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix('api');
    await app.init();
    try {
      const createdCredential = await request(app.getHttpServer())
        .post('/api/api-credentials')
        .set('Authorization', `Bearer ${signedIn.token}`)
        .send({ name: 'Read-only automation', permissions: ['monitor:read'] })
        .expect(201);
      expect(createdCredential.body.data.token).toMatch(/^wrk_[A-Za-z0-9_-]{43}$/u);

      await database
        .update(authMember)
        .set({ role: 'viewer' })
        .where(eq(authMember.id, membership!.id));

      await request(app.getHttpServer())
        .get('/api/monitors')
        .set('Authorization', `Bearer ${signedIn.token}`)
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/monitors')
        .set('Authorization', `Bearer ${signedIn.token}`)
        .send({ name: 'Forbidden write', url: 'https://example.test' })
        .expect(403);
      await request(app.getHttpServer())
        .get('/api/monitors')
        .set('Authorization', `Bearer ${createdCredential.body.data.token as string}`)
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/monitors')
        .set('Authorization', `Bearer ${createdCredential.body.data.token as string}`)
        .send({ name: 'Forbidden key write', url: 'https://example.test' })
        .expect(403);

      await database
        .update(authMember)
        .set({ role: 'owner' })
        .where(eq(authMember.id, membership!.id));
      await request(app.getHttpServer())
        .delete(`/api/api-credentials/${createdCredential.body.data.id as string}`)
        .set('Authorization', `Bearer ${signedIn.token}`)
        .expect(204);
      await request(app.getHttpServer())
        .get('/api/monitors')
        .set('Authorization', `Bearer ${createdCredential.body.data.token as string}`)
        .expect(401);
    } finally {
      await app.close();
    }
  });
});
