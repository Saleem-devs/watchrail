import { and, asc, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { IncidentEscalationPolicy, NewProject } from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import { monitors, projects, webhookEndpoints, type ProjectRecord } from './schema.js';

export class IncidentEscalationChannelError extends Error {
  constructor() {
    super('One or more escalation channels are unavailable.');
    this.name = 'IncidentEscalationChannelError';
  }
}

export interface ProjectListItem extends ProjectRecord {
  monitorCount: number;
}

export class ProjectRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async create(organizationId: string, project: NewProject): Promise<ProjectRecord> {
    const [created] = await this.db
      .insert(projects)
      .values({ organizationId, name: project.name, slug: project.slug })
      .returning();
    if (!created) throw new Error('The project insert returned no record.');
    return created;
  }

  async listForOrganization(organizationId: string): Promise<ProjectListItem[]> {
    const rows = await this.db
      .select({
        project: projects,
        monitorCount: count(monitors.id),
      })
      .from(projects)
      .leftJoin(
        monitors,
        and(
          eq(monitors.organizationId, projects.organizationId),
          eq(monitors.projectId, projects.id),
          ne(monitors.lifecycleState, 'ARCHIVED'),
        ),
      )
      .where(eq(projects.organizationId, organizationId))
      .groupBy(projects.id)
      .orderBy(asc(projects.name), asc(projects.id));
    return rows.map(({ project, monitorCount }) => ({ ...project, monitorCount }));
  }

  async findForOrganization(
    organizationId: string,
    projectId: string,
  ): Promise<ProjectRecord | null> {
    const [project] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.organizationId, organizationId), eq(projects.id, projectId)))
      .limit(1);
    return project ?? null;
  }

  async findBySlug(organizationId: string, slug: string): Promise<ProjectRecord | null> {
    const [project] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.organizationId, organizationId), eq(projects.slug, slug)))
      .limit(1);
    return project ?? null;
  }

  async getIncidentEscalationPolicy(
    organizationId: string,
    projectId: string,
  ): Promise<IncidentEscalationPolicy | null> {
    const [project] = await this.db
      .select({ steps: projects.incidentEscalationSteps })
      .from(projects)
      .where(and(eq(projects.organizationId, organizationId), eq(projects.id, projectId)))
      .limit(1);
    return project ?? null;
  }

  async updateIncidentEscalationPolicy(
    organizationId: string,
    projectId: string,
    policy: IncidentEscalationPolicy,
  ): Promise<IncidentEscalationPolicy | null> {
    return this.db.transaction(async (tx) => {
      const [project] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.organizationId, organizationId), eq(projects.id, projectId)))
        .limit(1)
        .for('update');
      if (!project) return null;
      const channelIds = [...new Set(policy.steps.flatMap((step) => step.channelIds ?? []))];
      if (channelIds.length > 0) {
        const channels = await tx
          .select({ id: webhookEndpoints.id })
          .from(webhookEndpoints)
          .where(
            and(
              eq(webhookEndpoints.organizationId, organizationId),
              eq(webhookEndpoints.projectId, projectId),
              eq(webhookEndpoints.notifyOnIncident, true),
              isNull(webhookEndpoints.archivedAt),
              inArray(webhookEndpoints.id, channelIds),
            ),
          );
        if (channels.length !== channelIds.length) throw new IncidentEscalationChannelError();
      }
      const [updated] = await tx
        .update(projects)
        .set({ incidentEscalationSteps: policy.steps, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(projects.organizationId, organizationId), eq(projects.id, projectId)))
        .returning({ steps: projects.incidentEscalationSteps });
      return updated ?? null;
    });
  }
}

export async function ensureDefaultProject(
  db: WatchrailDatabase,
  organizationId: string,
): Promise<ProjectRecord> {
  await db
    .insert(projects)
    .values({ organizationId, name: 'Default project', slug: 'default' })
    .onConflictDoNothing({ target: [projects.organizationId, projects.slug] });
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.organizationId, organizationId), eq(projects.slug, 'default')))
    .limit(1);
  if (!project) throw new Error('The default project could not be resolved.');
  return project;
}
