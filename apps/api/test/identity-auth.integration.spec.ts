import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  authMember,
  authOrganization,
  authEmailOutbox,
  authApiKey,
  authInvitation,
  AuthEmailOutboxRepository,
  decryptAuthEmail,
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
import { APP_CONFIG, loadAppConfig } from '../src/config.js';

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
      organizationName: `${email.split('@')[0]}'s Workspace`,
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

  it('durably stages an encrypted OTP without sending SMTP on the request path', async () => {
    const email = `outbox-${randomUUID()}@example.test`;
    const keyring = { activeKeyId: 'test', keys: new Map([['test', Buffer.alloc(32, 9)]]) };
    const auth = createAuth(database, {
      baseUrl: 'http://localhost:4000',
      secret: 'identity-integration-secret-with-at-least-32-characters',
      trustedOrigins: ['http://localhost:3010'],
      otpExpiresInSeconds: 600,
      mail: { provider: 'console', from: 'Watchrail <noreply@example.test>' },
      authEmailKeyring: keyring,
    });

    await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } });
    const [message] = await database
      .select()
      .from(authEmailOutbox)
      .where(eq(authEmailOutbox.recipientHash, createHash('sha256').update(email).digest('hex')));
    expect(message).toBeDefined();
    expect(JSON.stringify(message)).not.toContain(email);
    const payload = decryptAuthEmail(message!.encryptedPayload, message!.id, keyring);
    expect(payload).toMatchObject({
      type: 'OTP',
      to: email,
      otp: expect.stringMatching(/^\d{6}$/u),
    });

    await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } });
    const messages = await database
      .select()
      .from(authEmailOutbox)
      .where(eq(authEmailOutbox.recipientHash, createHash('sha256').update(email).digest('hex')));
    expect(messages).toHaveLength(2);
    expect(messages.filter((item) => item.supersededAt === null)).toHaveLength(1);
    const activeMessage = messages.find((item) => item.supersededAt === null)!;
    const activePayload = decryptAuthEmail(
      activeMessage.encryptedPayload,
      activeMessage.id,
      keyring,
    ) as { otp: string };
    const signedIn = await auth.api.signInEmailOTP({
      body: { email, otp: activePayload.otp },
    });
    const [membership] = await database
      .select({ organizationId: authMember.organizationId })
      .from(authMember)
      .where(eq(authMember.userId, signedIn.user.id));
    const headers = new Headers({ authorization: `Bearer ${signedIn.token}` });
    await auth.api.setActiveOrganization({
      body: { organizationId: membership!.organizationId },
      headers,
    });
    const inviteEmail = `invite-${randomUUID()}@example.test`;
    await auth.api.createInvitation({
      body: { organizationId: membership!.organizationId, email: inviteEmail, role: 'viewer' },
      headers,
    });
    const invitationMessages = await database
      .select()
      .from(authEmailOutbox)
      .where(eq(authEmailOutbox.kind, 'INVITATION'));
    expect(invitationMessages).toHaveLength(1);
    expect(JSON.stringify(invitationMessages[0])).not.toContain(inviteEmail);

    const outbox = new AuthEmailOutboxRepository(database);
    await database.update(authEmailOutbox).set({ publishedAt: new Date() });
    const claimableId = await outbox.stage({
      kind: 'OTP',
      recipient: 'claimable@example.test',
      supersessionKey: 'claimable',
      payload: { type: 'OTP', to: 'claimable@example.test', otp: '654321' },
      expiresAt: new Date(Date.now() + 60_000),
      keyring,
    });
    const concurrentClaims = await Promise.all([
      outbox.claimNext(30_000),
      outbox.claimNext(30_000),
    ]);
    expect(concurrentClaims.filter(Boolean)).toHaveLength(1);
    expect(concurrentClaims.find(Boolean)?.id).toBe(claimableId);

    await database.update(authEmailOutbox).set({ publishedAt: new Date() });
    const expiredId = await outbox.stage({
      kind: 'OTP',
      recipient: 'expired@example.test',
      supersessionKey: 'expired',
      payload: { type: 'OTP', to: 'expired@example.test', otp: '123456' },
      expiresAt: new Date(Date.now() - 1),
      keyring,
    });
    expect(await outbox.claimNext(30_000)).toBeNull();
    const [expired] = await database
      .select({ failedAt: authEmailOutbox.failedAt, lastErrorCode: authEmailOutbox.lastErrorCode })
      .from(authEmailOutbox)
      .where(eq(authEmailOutbox.id, expiredId));
    expect(expired).toMatchObject({
      failedAt: expect.any(Date),
      lastErrorCode: 'EXPIRED',
    });
  });

  it('serializes concurrent staging and expires previously published deliveries', async () => {
    const keyring = { activeKeyId: 'test', keys: new Map([['test', Buffer.alloc(32, 7)]]) };
    const outbox = new AuthEmailOutboxRepository(database);
    const supersessionKey = `otp:sign-in:parallel-${randomUUID()}@example.test`;
    const ids = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        outbox.stage({
          kind: 'OTP',
          recipient: 'parallel@example.test',
          supersessionKey,
          payload: {
            type: 'OTP',
            to: 'parallel@example.test',
            otp: String(index).padStart(6, '0'),
          },
          expiresAt: new Date(Date.now() + 60_000),
          keyring,
        }),
      ),
    );
    const staged = await database
      .select()
      .from(authEmailOutbox)
      .where(
        eq(
          authEmailOutbox.supersessionKey,
          createHash('sha256').update(supersessionKey).digest('hex'),
        ),
      );
    expect(staged).toHaveLength(8);
    expect(staged.filter((row) => row.supersededAt === null).map((row) => row.id)).toHaveLength(1);

    const publishedId = ids[0]!;
    await database
      .update(authEmailOutbox)
      .set({ publishedAt: new Date(), supersededAt: null, expiresAt: new Date(Date.now() - 1) })
      .where(eq(authEmailOutbox.id, publishedId));
    expect(await outbox.forDelivery(publishedId)).toBeNull();
    const [expired] = await database
      .select()
      .from(authEmailOutbox)
      .where(eq(authEmailOutbox.id, publishedId));
    expect(expired?.lastErrorCode).toBe('EXPIRED');
    expect(expired?.failedAt).toBeInstanceOf(Date);
  });

  it('accepts, revokes, and expires organization invitations', async () => {
    const keyring = { activeKeyId: 'test', keys: new Map([['test', Buffer.alloc(32, 4)]]) };
    const auth = createAuth(database, {
      baseUrl: 'http://localhost:4000',
      secret: 'identity-integration-secret-with-at-least-32-characters',
      trustedOrigins: ['http://localhost:3010'],
      otpExpiresInSeconds: 600,
      mail: { provider: 'console', from: 'Watchrail <noreply@example.test>' },
      authEmailKeyring: keyring,
    });

    async function signIn(email: string) {
      await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } });
      const [message] = await database
        .select()
        .from(authEmailOutbox)
        .where(eq(authEmailOutbox.recipientHash, createHash('sha256').update(email).digest('hex')));
      const payload = decryptAuthEmail(message!.encryptedPayload, message!.id, keyring) as {
        otp: string;
      };
      const signedIn = await auth.api.signInEmailOTP({ body: { email, otp: payload.otp } });
      const [membership] = await database
        .select({ organizationId: authMember.organizationId })
        .from(authMember)
        .where(eq(authMember.userId, signedIn.user.id))
        .limit(1);
      const headers = new Headers({ authorization: `Bearer ${signedIn.token}` });
      await auth.api.setActiveOrganization({
        body: { organizationId: membership!.organizationId },
        headers,
      });
      return { ...signedIn, headers, personalOrganizationId: membership!.organizationId };
    }

    const owner = await signIn(`owner-${randomUUID()}@example.test`);
    const inviteeEmail = `invitee-${randomUUID()}@example.test`;
    const invitee = await signIn(inviteeEmail);
    const invitation = await auth.api.createInvitation({
      body: {
        organizationId: owner.personalOrganizationId,
        email: inviteeEmail,
        role: 'viewer',
      },
      headers: owner.headers,
    });
    await auth.api.acceptInvitation({
      body: { invitationId: invitation.id },
      headers: invitee.headers,
    });
    expect(
      await database
        .select({ role: authMember.role })
        .from(authMember)
        .where(eq(authMember.organizationId, owner.personalOrganizationId)),
    ).toEqual(expect.arrayContaining([{ role: 'owner' }, { role: 'viewer' }]));

    const revoked = await auth.api.createInvitation({
      body: {
        organizationId: owner.personalOrganizationId,
        email: `revoked-${randomUUID()}@example.test`,
        role: 'viewer',
      },
      headers: owner.headers,
    });
    await auth.api.cancelInvitation({ body: { invitationId: revoked.id }, headers: owner.headers });
    const outbox = new AuthEmailOutboxRepository(database);
    expect(await outbox.isInvitationPending(revoked.id)).toBe(false);
    const [revokedRecord] = await database
      .select({ status: authInvitation.status })
      .from(authInvitation)
      .where(eq(authInvitation.id, revoked.id));
    expect(revokedRecord?.status).toBe('canceled');

    const expiredEmail = `expired-${randomUUID()}@example.test`;
    const expiredInvitee = await signIn(expiredEmail);
    const expired = await auth.api.createInvitation({
      body: {
        organizationId: owner.personalOrganizationId,
        email: expiredEmail,
        role: 'editor',
      },
      headers: owner.headers,
    });
    await database
      .update(authInvitation)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(authInvitation.id, expired.id));
    await expect(
      auth.api.acceptInvitation({
        body: { invitationId: expired.id },
        headers: expiredInvitee.headers,
      }),
    ).rejects.toThrow();
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
    const productionConfig = loadAppConfig({
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
      AUTH_EMAIL_ACTIVE_KEY_ID: 'test',
      AUTH_EMAIL_ENCRYPTION_KEYS: JSON.stringify({
        test: Buffer.alloc(32).toString('base64'),
      }),
    });

    const testingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(productionConfig)
      .overrideProvider(WATCHRAIL_AUTH)
      .useValue(auth)
      .compile();
    const app = testingModule.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix('api');
    await app.init();
    try {
      await request(app.getHttpServer())
        .get('/api/organizations/current')
        .set('Authorization', `Bearer ${signedIn.token}`)
        .expect(200);
      const memberPage = await request(app.getHttpServer())
        .get('/api/organizations/current/members')
        .set('Authorization', `Bearer ${signedIn.token}`)
        .expect(200);
      expect(memberPage.body.data).toEqual([
        expect.objectContaining({ userId: signedIn.user.id, role: 'owner' }),
      ]);
      await request(app.getHttpServer())
        .get('/api/organizations/current/invitations')
        .set('Authorization', `Bearer ${signedIn.token}`)
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/api-credentials')
        .set('Authorization', `Bearer ${signedIn.token}`)
        .expect(200);

      const invalidInput = await request(app.getHttpServer())
        .post('/api/api-credentials')
        .set('Authorization', `Bearer ${signedIn.token}`)
        .send({
          name: 'Untrusted',
          permissions: ['monitor:read'],
          organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        })
        .expect(400);
      expect(invalidInput.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        fields: { body: [expect.any(String)] },
      });

      const expiredInput = await request(app.getHttpServer())
        .post('/api/api-credentials')
        .set('Authorization', `Bearer ${signedIn.token}`)
        .send({ name: 'Expired', permissions: ['monitor:read'], expiresAt: '2020-01-01' })
        .expect(400);
      expect(expiredInput.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        fields: { expiresAt: [expect.any(String)] },
      });

      const createdCredential = await request(app.getHttpServer())
        .post('/api/api-credentials')
        .set('Authorization', `Bearer ${signedIn.token}`)
        .send({
          name: 'Read-only automation',
          permissions: ['monitor:read', 'apiKey:manage'],
        })
        .expect(201);
      expect(createdCredential.body.data.token).toMatch(/^wrk_[A-Za-z0-9_-]{43}$/u);
      const listedCredentials = await request(app.getHttpServer())
        .get('/api/api-credentials')
        .set('Authorization', `Bearer ${signedIn.token}`)
        .expect(200);
      expect(listedCredentials.body.data).toEqual([
        expect.objectContaining({
          id: createdCredential.body.data.id,
          permissions: ['monitor:read', 'apiKey:manage'],
        }),
      ]);
      expect(listedCredentials.body.data[0]).not.toHaveProperty('token');
      expect(listedCredentials.body.data[0]).not.toHaveProperty('key');
      expect(listedCredentials.body.data[0]).not.toHaveProperty('keyHash');
      expect(listedCredentials.body.data[0]).not.toHaveProperty('organizationId');
      await request(app.getHttpServer())
        .delete(`/api/api-credentials/${createdCredential.body.data.id as string}`)
        .set('Authorization', `Bearer ${createdCredential.body.data.token as string}`)
        .expect(403);
      await request(app.getHttpServer())
        .post('/api/api-credentials')
        .set('Authorization', `Bearer ${createdCredential.body.data.token as string}`)
        .send({ name: 'Escalated child', permissions: ['monitor:read'] })
        .expect(403);

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
        .post('/api/api-credentials')
        .set('Authorization', `Bearer ${signedIn.token}`)
        .send({ name: 'Viewer may not create keys', permissions: ['monitor:read'] })
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
        .update(authApiKey)
        .set({ expiresAt: new Date(Date.now() - 1) })
        .where(eq(authApiKey.id, createdCredential.body.data.id as string));
      await request(app.getHttpServer())
        .get('/api/monitors')
        .set('Authorization', `Bearer ${createdCredential.body.data.token as string}`)
        .expect(401);
      await database
        .update(authApiKey)
        .set({ expiresAt: new Date(Date.now() + 60_000) })
        .where(eq(authApiKey.id, createdCredential.body.data.id as string));

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
