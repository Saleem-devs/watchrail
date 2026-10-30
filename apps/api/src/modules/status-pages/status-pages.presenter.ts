import type { StatusPageRecord } from '@watchrail/db';

export function presentStatusPage(page: StatusPageRecord) {
  return {
    id: page.id,
    ...(page.projectId ? { projectId: page.projectId } : {}),
    name: page.name,
    logoUrl: page.logoUrl ?? null,
    slug: page.slug,
    published: page.published,
    components: page.components,
    createdAt: page.createdAt.toISOString(),
    updatedAt: page.updatedAt.toISOString(),
  };
}
