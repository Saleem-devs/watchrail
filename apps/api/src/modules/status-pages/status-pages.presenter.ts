import type { StatusPageRecord } from '@watchrail/db';

export function presentStatusPage(page: StatusPageRecord) {
  return {
    id: page.id,
    name: page.name,
    slug: page.slug,
    published: page.published,
    components: page.components,
    createdAt: page.createdAt.toISOString(),
    updatedAt: page.updatedAt.toISOString(),
  };
}
