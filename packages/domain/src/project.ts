export const PROJECT_NAME_MAX_LENGTH = 120;
export const PROJECT_SLUG_MAX_LENGTH = 63;

export interface NewProject {
  name: string;
  slug: string;
}

export interface ProjectFieldErrors {
  name?: string[];
  slug?: string[];
}

export class ProjectInputError extends Error {
  constructor(readonly fields: ProjectFieldErrors) {
    super('Project details are invalid.');
  }
}

export function parseNewProject(value: unknown): NewProject {
  const fields: ProjectFieldErrors = {};
  const input = isRecord(value) ? value : {};
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const suppliedSlug = typeof input.slug === 'string' ? input.slug.trim() : '';
  const slug = suppliedSlug || slugifyProjectName(name);

  if (!name) fields.name = ['Enter a project name.'];
  else if (name.length > PROJECT_NAME_MAX_LENGTH)
    fields.name = [`Use ${PROJECT_NAME_MAX_LENGTH} characters or fewer.`];

  if (!slug) fields.slug = ['Enter a project slug.'];
  else if (slug.length > PROJECT_SLUG_MAX_LENGTH)
    fields.slug = [`Use ${PROJECT_SLUG_MAX_LENGTH} characters or fewer.`];
  else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    fields.slug = ['Use lowercase letters, numbers, and single hyphens.'];

  if (Object.keys(fields).length > 0) throw new ProjectInputError(fields);
  return { name, slug };
}

export function slugifyProjectName(name: string): string {
  return name
    .trim()
    .toLocaleLowerCase('en-US')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PROJECT_SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
