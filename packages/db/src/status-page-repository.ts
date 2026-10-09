import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { parseStatusPage, type StatusPage } from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import { monitors, statusPageComponents, statusPages } from './schema.js';

type Transaction = Parameters<Parameters<WatchrailDatabase['transaction']>[0]>[0];

export interface StatusPageComponentInput {
  displayName: string;
  monitorId: string;
  position: number;
}

export interface StatusPageRecord extends StatusPage {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export class StatusPageNotFoundError extends Error {
  constructor() {
    super('Status page not found.');
    this.name = 'StatusPageNotFoundError';
  }
}

export class StatusPageSlugTakenError extends Error {
  constructor() {
    super('Status page slug is already reserved.');
    this.name = 'StatusPageSlugTakenError';
  }
}

export class StatusPageMonitorSelectionError extends Error {
  constructor(readonly reason: 'MONITOR_NOT_FOUND' | 'MONITOR_ARCHIVED') {
    super(
      reason === 'MONITOR_ARCHIVED'
        ? 'Archived monitors cannot be newly selected.'
        : 'A selected monitor was not found.',
    );
    this.name = 'StatusPageMonitorSelectionError';
  }
}

export class StatusPageRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async create(
    organizationId: string,
    input: {
      name: string;
      slug: string;
      published?: boolean;
      components: StatusPageComponentInput[];
    },
  ): Promise<StatusPageRecord> {
    const pageId = randomUUID();
    const candidate = this.parseCandidate(organizationId, pageId, {
      ...input,
      published: input.published ?? false,
    });
    try {
      return await this.db.transaction(async (tx) => {
        await this.assertSelectableMonitors(tx, organizationId, candidate.components);
        const [page] = await tx
          .insert(statusPages)
          .values({
            id: pageId,
            organizationId,
            name: candidate.name,
            slug: candidate.slug,
            published: candidate.published,
          })
          .returning();
        if (!page) throw new Error('Status page creation returned no record.');
        await this.insertComponents(tx, candidate);
        return toRecord(page, candidate.components);
      });
    } catch (error) {
      this.translateConstraint(error);
    }
  }

  async listForOrganization(organizationId: string): Promise<StatusPageRecord[]> {
    const pages = await this.db
      .select()
      .from(statusPages)
      .where(eq(statusPages.organizationId, organizationId))
      .orderBy(asc(statusPages.createdAt), asc(statusPages.id));
    return this.attachComponents(this.db, organizationId, pages);
  }

  async findForOrganization(
    organizationId: string,
    statusPageId: string,
  ): Promise<StatusPageRecord | null> {
    const [page] = await this.db
      .select()
      .from(statusPages)
      .where(and(eq(statusPages.organizationId, organizationId), eq(statusPages.id, statusPageId)))
      .limit(1);
    if (!page) return null;
    return (await this.attachComponents(this.db, organizationId, [page]))[0] ?? null;
  }

  async updateSettings(
    organizationId: string,
    statusPageId: string,
    input: { name: string; slug: string },
  ): Promise<StatusPageRecord> {
    try {
      return await this.db.transaction(async (tx) => {
        const current = await this.lockCurrent(tx, organizationId, statusPageId);
        const candidate = this.parseCandidate(organizationId, statusPageId, {
          name: input.name,
          slug: input.slug,
          published: current.page.published,
          components: current.components.map(({ displayName, monitorId, position }) => ({
            displayName,
            monitorId,
            position,
          })),
        });
        if (candidate.name === current.page.name && candidate.slug === current.page.slug) {
          return toRecord(current.page, current.components);
        }
        const [page] = await tx
          .update(statusPages)
          .set({
            name: candidate.name,
            slug: candidate.slug,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(eq(statusPages.organizationId, organizationId), eq(statusPages.id, statusPageId)),
          )
          .returning();
        if (!page) throw new StatusPageNotFoundError();
        return toRecord(page, current.components);
      });
    } catch (error) {
      this.translateConstraint(error);
    }
  }

  async replaceComponents(
    organizationId: string,
    statusPageId: string,
    input: StatusPageComponentInput[],
  ): Promise<StatusPageRecord> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockCurrent(tx, organizationId, statusPageId);
      const candidate = this.parseCandidate(organizationId, statusPageId, {
        name: current.page.name,
        slug: current.page.slug,
        published: current.page.published,
        components: input,
      });
      await this.assertSelectableMonitors(
        tx,
        organizationId,
        candidate.components,
        new Set(current.components.map(({ monitorId }) => monitorId)),
      );
      await tx
        .delete(statusPageComponents)
        .where(
          and(
            eq(statusPageComponents.organizationId, organizationId),
            eq(statusPageComponents.statusPageId, statusPageId),
          ),
        );
      await this.insertComponents(tx, candidate);
      const [page] = await tx
        .update(statusPages)
        .set({ updatedAt: sql`clock_timestamp()` })
        .where(
          and(eq(statusPages.organizationId, organizationId), eq(statusPages.id, statusPageId)),
        )
        .returning();
      if (!page) throw new StatusPageNotFoundError();
      return toRecord(page, candidate.components);
    });
  }

  async setPublished(
    organizationId: string,
    statusPageId: string,
    published: boolean,
  ): Promise<StatusPageRecord> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockCurrent(tx, organizationId, statusPageId);
      if (current.page.published === published) return toRecord(current.page, current.components);
      const [page] = await tx
        .update(statusPages)
        .set({ published, updatedAt: sql`clock_timestamp()` })
        .where(
          and(eq(statusPages.organizationId, organizationId), eq(statusPages.id, statusPageId)),
        )
        .returning();
      if (!page) throw new StatusPageNotFoundError();
      return toRecord(page, current.components);
    });
  }

  private parseCandidate(
    organizationId: string,
    statusPageId: string,
    input: {
      name: string;
      slug: string;
      published: boolean;
      components: StatusPageComponentInput[];
    },
  ): StatusPage & { id: string } {
    const parsed = parseStatusPage({
      organizationId,
      name: input.name,
      slug: input.slug,
      published: input.published,
      components: input.components.map((component) => ({
        id: randomUUID(),
        ...component,
      })),
    });
    return { id: statusPageId, ...parsed };
  }

  private async lockCurrent(tx: Transaction, organizationId: string, statusPageId: string) {
    const [page] = await tx
      .select()
      .from(statusPages)
      .where(and(eq(statusPages.organizationId, organizationId), eq(statusPages.id, statusPageId)))
      .limit(1)
      .for('update');
    if (!page) throw new StatusPageNotFoundError();
    const components = await this.loadComponents(tx, organizationId, [statusPageId]);
    return { page, components: components.get(statusPageId) ?? [] };
  }

  private async assertSelectableMonitors(
    tx: Transaction,
    organizationId: string,
    components: StatusPage['components'],
    previouslySelected = new Set<string>(),
  ): Promise<void> {
    if (components.length === 0) return;
    const selected = await tx
      .select({ id: monitors.id, lifecycleState: monitors.lifecycleState })
      .from(monitors)
      .where(
        and(
          eq(monitors.organizationId, organizationId),
          inArray(
            monitors.id,
            components.map(({ monitorId }) => monitorId),
          ),
        ),
      );
    if (selected.length !== components.length)
      throw new StatusPageMonitorSelectionError('MONITOR_NOT_FOUND');
    if (
      selected.some(
        ({ id, lifecycleState }) => lifecycleState === 'ARCHIVED' && !previouslySelected.has(id),
      )
    )
      throw new StatusPageMonitorSelectionError('MONITOR_ARCHIVED');
  }

  private async insertComponents(
    tx: Transaction,
    candidate: StatusPage & { id: string },
  ): Promise<void> {
    if (candidate.components.length === 0) return;
    await tx.insert(statusPageComponents).values(
      candidate.components.map((component) => ({
        ...component,
        organizationId: candidate.organizationId,
        statusPageId: candidate.id,
      })),
    );
  }

  private async attachComponents(
    db: WatchrailDatabase,
    organizationId: string,
    pages: (typeof statusPages.$inferSelect)[],
  ): Promise<StatusPageRecord[]> {
    if (pages.length === 0) return [];
    const components = await this.loadComponents(
      db,
      organizationId,
      pages.map(({ id }) => id),
    );
    return pages.map((page) => toRecord(page, components.get(page.id) ?? []));
  }

  private async loadComponents(
    db: WatchrailDatabase | Transaction,
    organizationId: string,
    pageIds: string[],
  ): Promise<Map<string, StatusPage['components']>> {
    const rows = await db
      .select()
      .from(statusPageComponents)
      .where(
        and(
          eq(statusPageComponents.organizationId, organizationId),
          inArray(statusPageComponents.statusPageId, pageIds),
        ),
      )
      .orderBy(asc(statusPageComponents.position), asc(statusPageComponents.id));
    const result = new Map<string, StatusPage['components']>();
    for (const row of rows) {
      const collection = result.get(row.statusPageId) ?? [];
      collection.push({
        id: row.id,
        displayName: row.displayName,
        monitorId: row.monitorId,
        position: row.position,
      });
      result.set(row.statusPageId, collection);
    }
    return result;
  }

  private translateConstraint(error: unknown): never {
    if (isPostgresError(error, '23505', 'status_pages_slug_unique')) {
      throw new StatusPageSlugTakenError();
    }
    throw error;
  }
}

function toRecord(
  page: typeof statusPages.$inferSelect,
  components: StatusPage['components'],
): StatusPageRecord {
  return {
    id: page.id,
    organizationId: page.organizationId,
    name: page.name,
    slug: page.slug,
    published: page.published,
    components,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}

function isPostgresError(error: unknown, code: string, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown; cause?: unknown };
  return (
    (candidate.code === code && candidate.constraint === constraint) ||
    (candidate.cause !== undefined && isPostgresError(candidate.cause, code, constraint))
  );
}
