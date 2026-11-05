import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMonitor, EMPTY_ASSERTION_CONFIGURATION } from '@watchrail/domain';
import { decryptWorkspaceSecret, encryptWorkspaceSecret } from '@watchrail/secret-vault-security';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import { migrateDatabase } from './migration.js';
import { MonitorRepository, WorkspaceSecretBindingError } from './monitor-repository.js';
import {
  WorkspaceSecretConflictError,
  WorkspaceSecretRepository,
} from './workspace-secret-repository.js';
import { workspaceSecretBindings } from './schema.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const vaultKeyring = { activeKeyId: 'test', keys: new Map([['test', Buffer.alloc(32, 4)]]) };

describe('workspace secret monitor bindings', () => {
  let container: StartedPostgreSqlContainer;
  let connection: DatabaseConnection;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    connection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));
  }, 60_000);

  beforeEach(async () => {
    await connection.pool.query('truncate table workspace_secrets, monitors cascade');
  });

  afterAll(async () => {
    await connection?.pool.end();
    await container?.stop();
  });

  it('atomically permits either archival or reference creation, never both', async () => {
    const secrets = new WorkspaceSecretRepository(connection.db);
    const secret = await secrets.create(organizationId, actorId, { key: 'API_TOKEN' }, (context) =>
      encryptWorkspaceSecret('Bearer token', { organizationId, ...context }, vaultKeyring),
    );

    const [createResult, archiveResult] = await Promise.allSettled([
      createMonitorWithReference(secret.id),
      secrets.archive(organizationId, secret.id, actorId),
    ]);

    expect([createResult.status, archiveResult.status].sort()).toEqual(['fulfilled', 'rejected']);
    if (createResult.status === 'rejected') {
      expect(createResult.reason).toBeInstanceOf(WorkspaceSecretBindingError);
    }
    if (archiveResult.status === 'rejected') {
      expect(archiveResult.reason).toBeInstanceOf(WorkspaceSecretConflictError);
    }

    const current = await secrets.findForOrganization(organizationId, secret.id);
    const bindings = await connection.db.select().from(workspaceSecretBindings);
    expect(Boolean(current?.archivedAt) && bindings.length > 0).toBe(false);
    expect(current?.archivedAt ? bindings : bindings.map(({ secretId }) => secretId)).toEqual(
      current?.archivedAt ? [] : [secret.id],
    );
  });

  it('pins one secret version for the lifetime of an execution resolver', async () => {
    const secrets = new WorkspaceSecretRepository(connection.db);
    const secret = await secrets.create(
      organizationId,
      actorId,
      { key: 'ROTATING_TOKEN' },
      (context) =>
        encryptWorkspaceSecret('version-one', { organizationId, ...context }, vaultKeyring),
    );
    const decrypt = (
      encryptedValue: Parameters<typeof decryptWorkspaceSecret>[0],
      context: { secretId: string; versionNumber: number },
    ) => decryptWorkspaceSecret(encryptedValue, { organizationId, ...context }, vaultKeyring);
    const executionResolver = secrets.createExecutionValueResolver(organizationId, decrypt);

    await expect(executionResolver(secret.id.toUpperCase())).resolves.toBe('version-one');
    await secrets.rotate(organizationId, secret.id, actorId, (context) =>
      encryptWorkspaceSecret('version-two', { organizationId, ...context }, vaultKeyring),
    );
    await expect(executionResolver(secret.id.toLowerCase())).resolves.toBe('version-one');
    await expect(
      secrets.createExecutionValueResolver(organizationId, decrypt)(secret.id),
    ).resolves.toBe('version-two');
  });

  it('rolls back configuration and bindings when a referenced secret is unavailable', async () => {
    const secrets = new WorkspaceSecretRepository(connection.db);
    const secret = await secrets.create(
      organizationId,
      actorId,
      { key: 'STABLE_TOKEN' },
      (context) =>
        encryptWorkspaceSecret('stable-value', { organizationId, ...context }, vaultKeyring),
    );
    const monitor = await createMonitorWithReference(secret.id);
    const unavailableSecretId = randomUUID();
    const repository = new MonitorRepository(connection.db);

    await expect(
      repository.updateRequestHeaders(organizationId, monitor.id, () => [
        {
          name: 'authorization',
          sensitive: true,
          secretReference: { contractVersion: 1, secretId: unavailableSecretId },
        },
      ]),
    ).rejects.toBeInstanceOf(WorkspaceSecretBindingError);

    const [storedMonitor] = (
      await connection.pool.query<{
        request_headers: unknown;
      }>('select request_headers from monitors where id = $1', [monitor.id])
    ).rows;
    const versions = await connection.pool.query<{ version_number: number }>(
      'select version_number from monitor_configuration_versions where monitor_id = $1 order by version_number',
      [monitor.id],
    );
    const bindings = await connection.db.select().from(workspaceSecretBindings);
    expect(storedMonitor?.request_headers).toEqual([
      {
        name: 'authorization',
        sensitive: true,
        secretReference: { contractVersion: 1, secretId: secret.id },
      },
    ]);
    expect(versions.rows).toEqual([{ version_number: 1 }]);
    expect(bindings.map(({ secretId }) => secretId)).toEqual([secret.id]);
  });

  async function createMonitorWithReference(secretId: string) {
    const monitorId = randomUUID();
    const monitor = createMonitor({
      name: 'Vault-backed monitor',
      url: 'https://example.com/health',
      requestHeaders: [
        {
          name: 'authorization',
          sensitive: true,
          secretReference: { contractVersion: 1, secretId },
        },
      ],
    });
    if (monitor.type !== 'HTTP') throw new Error('Expected an HTTP monitor.');
    const requestHeaders = [
      {
        name: 'authorization',
        sensitive: true as const,
        secretReference: { contractVersion: 1 as const, secretId },
      },
    ];
    return new MonitorRepository(connection.db).create(
      organizationId,
      monitorId,
      monitor,
      requestHeaders,
      EMPTY_ASSERTION_CONFIGURATION,
    );
  }
});
