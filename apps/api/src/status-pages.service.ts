import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { StatusPageInputError } from '@watchrail/domain';
import {
  StatusPageMonitorSelectionError,
  StatusPageNotFoundError,
  StatusPageRepository,
  StatusPageSlugTakenError,
  type StatusPageComponentInput,
  type StatusPageRecord,
} from '@watchrail/db';
import type { RequestContext } from './request-context.js';

@Injectable()
export class StatusPagesService {
  constructor(
    @Inject(StatusPageRepository)
    private readonly pages: StatusPageRepository,
  ) {}

  async create(context: RequestContext, value: unknown): Promise<StatusPageRecord> {
    const input = parseCreateInput(value);
    try {
      return await this.pages.create(context.organizationId, input);
    } catch (error) {
      this.translate(error);
    }
  }

  list(context: RequestContext): Promise<StatusPageRecord[]> {
    return this.pages.listForOrganization(context.organizationId);
  }

  async find(context: RequestContext, statusPageId: string): Promise<StatusPageRecord> {
    const page = await this.pages.findForOrganization(context.organizationId, statusPageId);
    if (!page) this.notFound();
    return page;
  }

  async updateSettings(
    context: RequestContext,
    statusPageId: string,
    value: unknown,
  ): Promise<StatusPageRecord> {
    const input = parseSettingsInput(value);
    try {
      return await this.pages.updateSettings(context.organizationId, statusPageId, input);
    } catch (error) {
      this.translate(error);
    }
  }

  async replaceComponents(
    context: RequestContext,
    statusPageId: string,
    value: unknown,
  ): Promise<StatusPageRecord> {
    const components = parseComponentsInput(value);
    try {
      return await this.pages.replaceComponents(context.organizationId, statusPageId, components);
    } catch (error) {
      this.translate(error);
    }
  }

  async setPublished(
    context: RequestContext,
    statusPageId: string,
    value: unknown,
  ): Promise<StatusPageRecord> {
    const published = parsePublicationInput(value);
    try {
      return await this.pages.setPublished(context.organizationId, statusPageId, published);
    } catch (error) {
      this.translate(error);
    }
  }

  private translate(error: unknown): never {
    if (error instanceof StatusPageNotFoundError) this.notFound();
    if (error instanceof StatusPageSlugTakenError)
      throw new ConflictException({
        code: 'STATUS_PAGE_SLUG_TAKEN',
        message: error.message,
      });
    if (error instanceof StatusPageInputError)
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: error.message,
        fields: { statusPage: error.issues },
      });
    if (error instanceof StatusPageMonitorSelectionError)
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Status page component selection is invalid.',
        fields: { components: [error.message] },
      });
    throw error;
  }

  private notFound(): never {
    throw new NotFoundException({
      code: 'STATUS_PAGE_NOT_FOUND',
      message: 'Status page not found.',
    });
  }
}

function parseCreateInput(value: unknown): {
  name: string;
  slug: string;
  published?: boolean;
  components: StatusPageComponentInput[];
} {
  if (!isRecord(value) || !hasOnlyKeys(value, ['name', 'slug', 'published', 'components'])) {
    invalid(['Request body has an invalid shape.']);
  }
  if (!('name' in value) || !('slug' in value) || !('components' in value)) {
    invalid(['Request body must contain name, slug, and components.']);
  }
  if (
    typeof value.name !== 'string' ||
    typeof value.slug !== 'string' ||
    !Array.isArray(value.components) ||
    ('published' in value && typeof value.published !== 'boolean')
  ) {
    invalid(['Request body has invalid field types.']);
  }
  return {
    name: value.name,
    slug: value.slug,
    components: parseComponents(value.components),
    ...('published' in value ? { published: value.published as boolean } : {}),
  };
}

function parseSettingsInput(value: unknown): { name: string; slug: string } {
  if (
    !hasExactKeys(value, ['name', 'slug']) ||
    typeof value.name !== 'string' ||
    typeof value.slug !== 'string'
  ) {
    invalid(['Request body must contain exactly string name and slug.']);
  }
  return { name: value.name, slug: value.slug };
}

function parseComponentsInput(value: unknown): StatusPageComponentInput[] {
  if (!hasExactKeys(value, ['components']) || !Array.isArray(value.components)) {
    invalid(['Request body must contain exactly components.']);
  }
  return parseComponents(value.components);
}

function parseComponents(value: unknown[]): StatusPageComponentInput[] {
  return value.map((component, index) => {
    if (
      !hasExactKeys(component, ['displayName', 'monitorId', 'position']) ||
      typeof component.displayName !== 'string' ||
      typeof component.monitorId !== 'string' ||
      !isUuid(component.monitorId) ||
      typeof component.position !== 'number'
    ) {
      invalid([`components[${index}] has an invalid shape.`]);
    }
    return {
      displayName: component.displayName,
      monitorId: component.monitorId,
      position: component.position,
    };
  });
}

function parsePublicationInput(value: unknown): boolean {
  if (!hasExactKeys(value, ['published']) || typeof value.published !== 'boolean') {
    invalid(['Request body must contain exactly boolean published.']);
  }
  return value.published;
}

function invalid(issues: string[]): never {
  throw new BadRequestException({
    code: 'VALIDATION_FAILED',
    message: 'Status page settings are invalid.',
    fields: { statusPage: issues },
  });
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
