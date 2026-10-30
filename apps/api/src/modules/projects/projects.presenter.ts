import type { ProjectListItem, ProjectRecord } from '@watchrail/db';

export interface ProjectResponse {
  id: string;
  name: string;
  slug: string;
  monitorCount: number;
  createdAt: string;
  updatedAt: string;
}

export function presentProject(
  project: ProjectRecord | ProjectListItem,
  monitorCount = 'monitorCount' in project ? project.monitorCount : 0,
): ProjectResponse {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    monitorCount,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}
