import { and, asc, count, eq, ne } from 'drizzle-orm';
import type { NewProject } from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import { monitors, projects, type ProjectRecord } from './schema.js';

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
