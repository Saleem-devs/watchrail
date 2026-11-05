import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  parseStoredWorkspaceSecret,
  type EncryptedWorkspaceSecretV1,
} from '@watchrail/secret-vault-security';
import type { WatchrailDatabase } from './client.js';
import {
  workspaceSecretAuditEvents,
  workspaceSecretBindings,
  workspaceSecrets,
  workspaceSecretVersions,
} from './schema.js';

type Transaction = Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0];
type SecretAction = 'CREATED' | 'DESCRIPTION_UPDATED' | 'ROTATED' | 'ARCHIVED';

export interface WorkspaceSecretRecord {
  id: string;
  organizationId: string;
  key: string;
  description: string | null;
  versionNumber: number;
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface WorkspaceSecretAuditRecord {
  id: string;
  secretId: string;
  actorId: string;
  action: SecretAction;
  versionNumber: number | null;
  occurredAt: Date;
}

export interface WorkspaceSecretVersionContext {
  secretId: string;
  versionNumber: number;
}

export class WorkspaceSecretNotFoundError extends Error {
  constructor() {
    super('Workspace secret not found.');
    this.name = 'WorkspaceSecretNotFoundError';
  }
}

export class WorkspaceSecretConflictError extends Error {
  constructor(readonly code: 'KEY_EXISTS' | 'IN_USE' | 'ARCHIVED') {
    super(
      code === 'KEY_EXISTS'
        ? 'A workspace secret with this key already exists.'
        : code === 'IN_USE'
          ? 'Workspace secret is still referenced by active configuration.'
          : 'Archived workspace secrets cannot be changed.',
    );
    this.name = 'WorkspaceSecretConflictError';
  }
}

export class WorkspaceSecretInputError extends Error {
  constructor(readonly fields: Record<string, string[]>) {
    super('Workspace secret settings are invalid.');
    this.name = 'WorkspaceSecretInputError';
  }
}

export class WorkspaceSecretRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async create(
    organizationId: string,
    actorId: string,
    input: { key: string; description?: string | null },
    createEnvelope: (context: WorkspaceSecretVersionContext) => EncryptedWorkspaceSecretV1,
  ): Promise<WorkspaceSecretRecord> {
    const settings = parseSettings(input.key, input.description);
    const secretId = randomUUID();
    return this.db.transaction(async (tx) => {
      const duplicate = await this.findByKey(tx, organizationId, settings.key);
      if (duplicate) throw new WorkspaceSecretConflictError('KEY_EXISTS');
      const encryptedValue = parseStoredWorkspaceSecret(
        createEnvelope({ secretId, versionNumber: 1 }),
      );
      const [secret] = await tx
        .insert(workspaceSecrets)
        .values({
          id: secretId,
          organizationId,
          key: settings.key,
          description: settings.description,
        })
        .returning();
      if (!secret) throw new Error('Workspace secret creation returned no record.');
      await tx.insert(workspaceSecretVersions).values({
        organizationId,
        secretId,
        versionNumber: 1,
        encryptedValue,
        createdByActorId: actorId,
      });
      await this.audit(tx, organizationId, secretId, actorId, 'CREATED', 1);
      return toRecord(secret, 0);
    });
  }

  async updateDescription(
    organizationId: string,
    secretId: string,
    actorId: string,
    descriptionValue: string | null,
  ): Promise<WorkspaceSecretRecord> {
    const description = parseDescription(descriptionValue);
    return this.db.transaction(async (tx) => {
      const current = await this.lock(tx, organizationId, secretId);
      this.assertActive(current);
      if (current.description === description) {
        return toRecord(current, await this.usageCount(tx, organizationId, secretId));
      }
      const [updated] = await tx
        .update(workspaceSecrets)
        .set({ description, updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(workspaceSecrets.organizationId, organizationId),
            eq(workspaceSecrets.id, secretId),
          ),
        )
        .returning();
      if (!updated) throw new WorkspaceSecretNotFoundError();
      await this.audit(
        tx,
        organizationId,
        secretId,
        actorId,
        'DESCRIPTION_UPDATED',
        current.currentVersionNumber,
      );
      return toRecord(updated, await this.usageCount(tx, organizationId, secretId));
    });
  }

  async rotate(
    organizationId: string,
    secretId: string,
    actorId: string,
    createEnvelope: (context: WorkspaceSecretVersionContext) => EncryptedWorkspaceSecretV1,
  ): Promise<WorkspaceSecretRecord> {
    return this.db.transaction(async (tx) => {
      const current = await this.lock(tx, organizationId, secretId);
      this.assertActive(current);
      const versionNumber = current.currentVersionNumber + 1;
      const encryptedValue = parseStoredWorkspaceSecret(
        createEnvelope({ secretId, versionNumber }),
      );
      await tx.insert(workspaceSecretVersions).values({
        organizationId,
        secretId,
        versionNumber,
        encryptedValue,
        createdByActorId: actorId,
      });
      const [updated] = await tx
        .update(workspaceSecrets)
        .set({ currentVersionNumber: versionNumber, updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(workspaceSecrets.organizationId, organizationId),
            eq(workspaceSecrets.id, secretId),
          ),
        )
        .returning();
      if (!updated) throw new WorkspaceSecretNotFoundError();
      await this.audit(tx, organizationId, secretId, actorId, 'ROTATED', versionNumber);
      return toRecord(updated, await this.usageCount(tx, organizationId, secretId));
    });
  }

  async archive(
    organizationId: string,
    secretId: string,
    actorId: string,
  ): Promise<WorkspaceSecretRecord> {
    return this.db.transaction(async (tx) => {
      const current = await this.lock(tx, organizationId, secretId);
      this.assertActive(current);
      const usageCount = await this.usageCount(tx, organizationId, secretId);
      if (usageCount > 0) throw new WorkspaceSecretConflictError('IN_USE');
      const [updated] = await tx
        .update(workspaceSecrets)
        .set({
          archivedAt: sql`clock_timestamp()`,
          archivedByActorId: actorId,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(workspaceSecrets.organizationId, organizationId),
            eq(workspaceSecrets.id, secretId),
          ),
        )
        .returning();
      if (!updated) throw new WorkspaceSecretNotFoundError();
      await this.audit(
        tx,
        organizationId,
        secretId,
        actorId,
        'ARCHIVED',
        current.currentVersionNumber,
      );
      return toRecord(updated, 0);
    });
  }

  async listForOrganization(
    organizationId: string,
    options: { includeArchived?: boolean } = {},
  ): Promise<WorkspaceSecretRecord[]> {
    const rows = await this.db
      .select({
        secret: workspaceSecrets,
        usageCount: count(workspaceSecretBindings.secretId),
      })
      .from(workspaceSecrets)
      .leftJoin(
        workspaceSecretBindings,
        and(
          eq(workspaceSecretBindings.organizationId, workspaceSecrets.organizationId),
          eq(workspaceSecretBindings.secretId, workspaceSecrets.id),
        ),
      )
      .where(
        and(
          eq(workspaceSecrets.organizationId, organizationId),
          options.includeArchived ? undefined : isNull(workspaceSecrets.archivedAt),
        ),
      )
      .groupBy(workspaceSecrets.id)
      .orderBy(asc(workspaceSecrets.key), asc(workspaceSecrets.id));
    return rows.map((row) => toRecord(row.secret, Number(row.usageCount)));
  }

  async findForOrganization(
    organizationId: string,
    secretId: string,
  ): Promise<WorkspaceSecretRecord | null> {
    const rows = await this.db
      .select({ secret: workspaceSecrets, usageCount: count(workspaceSecretBindings.secretId) })
      .from(workspaceSecrets)
      .leftJoin(
        workspaceSecretBindings,
        and(
          eq(workspaceSecretBindings.organizationId, workspaceSecrets.organizationId),
          eq(workspaceSecretBindings.secretId, workspaceSecrets.id),
        ),
      )
      .where(
        and(eq(workspaceSecrets.organizationId, organizationId), eq(workspaceSecrets.id, secretId)),
      )
      .groupBy(workspaceSecrets.id)
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row.secret, Number(row.usageCount)) : null;
  }

  async listAuditEvents(
    organizationId: string,
    secretId: string,
  ): Promise<WorkspaceSecretAuditRecord[]> {
    const secret = await this.findForOrganization(organizationId, secretId);
    if (!secret) throw new WorkspaceSecretNotFoundError();
    return this.db
      .select({
        id: workspaceSecretAuditEvents.id,
        secretId: workspaceSecretAuditEvents.secretId,
        actorId: workspaceSecretAuditEvents.actorId,
        action: workspaceSecretAuditEvents.action,
        versionNumber: workspaceSecretAuditEvents.versionNumber,
        occurredAt: workspaceSecretAuditEvents.occurredAt,
      })
      .from(workspaceSecretAuditEvents)
      .where(
        and(
          eq(workspaceSecretAuditEvents.organizationId, organizationId),
          eq(workspaceSecretAuditEvents.secretId, secretId),
        ),
      )
      .orderBy(desc(workspaceSecretAuditEvents.occurredAt), desc(workspaceSecretAuditEvents.id));
  }

  async resolveCurrentEnvelope(
    organizationId: string,
    secretId: string,
  ): Promise<{ versionNumber: number; encryptedValue: EncryptedWorkspaceSecretV1 }> {
    const [row] = await this.db
      .select({
        secret: workspaceSecrets,
        version: workspaceSecretVersions,
      })
      .from(workspaceSecrets)
      .innerJoin(
        workspaceSecretVersions,
        and(
          eq(workspaceSecretVersions.organizationId, workspaceSecrets.organizationId),
          eq(workspaceSecretVersions.secretId, workspaceSecrets.id),
          eq(workspaceSecretVersions.versionNumber, workspaceSecrets.currentVersionNumber),
        ),
      )
      .where(
        and(
          eq(workspaceSecrets.organizationId, organizationId),
          eq(workspaceSecrets.id, secretId),
          isNull(workspaceSecrets.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new WorkspaceSecretNotFoundError();
    return {
      versionNumber: row.version.versionNumber,
      encryptedValue: parseStoredWorkspaceSecret(row.version.encryptedValue),
    };
  }

  createExecutionValueResolver(
    organizationId: string,
    decrypt: (
      encryptedValue: EncryptedWorkspaceSecretV1,
      context: WorkspaceSecretVersionContext,
    ) => string,
  ): (secretId: string) => Promise<string> {
    const selectedVersions = new Map<string, Promise<string>>();
    return (secretId) => {
      const canonicalSecretId = secretId.toLowerCase();
      const existing = selectedVersions.get(canonicalSecretId);
      if (existing) return existing;
      const selected = this.resolveCurrentEnvelope(organizationId, canonicalSecretId).then(
        ({ encryptedValue, versionNumber }) =>
          decrypt(encryptedValue, { secretId: canonicalSecretId, versionNumber }),
      );
      selectedVersions.set(canonicalSecretId, selected);
      return selected;
    };
  }

  private async lock(tx: Transaction, organizationId: string, secretId: string) {
    const [secret] = await tx
      .select()
      .from(workspaceSecrets)
      .where(
        and(eq(workspaceSecrets.organizationId, organizationId), eq(workspaceSecrets.id, secretId)),
      )
      .limit(1)
      .for('update');
    if (!secret) throw new WorkspaceSecretNotFoundError();
    return secret;
  }

  private assertActive(secret: typeof workspaceSecrets.$inferSelect): void {
    if (secret.archivedAt) throw new WorkspaceSecretConflictError('ARCHIVED');
  }

  private async findByKey(tx: Transaction, organizationId: string, key: string) {
    const [secret] = await tx
      .select({ id: workspaceSecrets.id })
      .from(workspaceSecrets)
      .where(
        and(eq(workspaceSecrets.organizationId, organizationId), eq(workspaceSecrets.key, key)),
      )
      .limit(1);
    return secret ?? null;
  }

  private async usageCount(
    tx: Transaction,
    organizationId: string,
    secretId: string,
  ): Promise<number> {
    const [row] = await tx
      .select({ value: count() })
      .from(workspaceSecretBindings)
      .where(
        and(
          eq(workspaceSecretBindings.organizationId, organizationId),
          eq(workspaceSecretBindings.secretId, secretId),
        ),
      );
    return Number(row?.value ?? 0);
  }

  private async audit(
    tx: Transaction,
    organizationId: string,
    secretId: string,
    actorId: string,
    action: SecretAction,
    versionNumber: number | null,
  ): Promise<void> {
    await tx.insert(workspaceSecretAuditEvents).values({
      organizationId,
      secretId,
      actorId,
      action,
      versionNumber,
    });
  }
}

function parseSettings(
  keyValue: string,
  descriptionValue: string | null | undefined,
): { key: string; description: string | null } {
  const fields: Record<string, string[]> = {};
  const key = typeof keyValue === 'string' ? keyValue.trim().toUpperCase() : '';
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(key)) {
    fields.key = [
      'key must contain 1 to 64 uppercase letters, numbers or underscores and start with a letter.',
    ];
  }
  const description = parseDescription(descriptionValue, fields);
  if (Object.keys(fields).length > 0) throw new WorkspaceSecretInputError(fields);
  return { key, description };
}

function parseDescription(
  value: string | null | undefined,
  fields: Record<string, string[]> = {},
): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const description = value.trim();
  if (description.length > 240) {
    fields.description = ['description must not exceed 240 characters.'];
    if (Object.keys(fields).length === 1) throw new WorkspaceSecretInputError(fields);
  }
  return description;
}

function toRecord(
  secret: typeof workspaceSecrets.$inferSelect,
  usageCount: number,
): WorkspaceSecretRecord {
  return {
    id: secret.id,
    organizationId: secret.organizationId,
    key: secret.key,
    description: secret.description,
    versionNumber: secret.currentVersionNumber,
    usageCount,
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
    archivedAt: secret.archivedAt,
  };
}
