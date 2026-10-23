import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PublicStatusPageRepository } from '@watchrail/db';
import type { PublicStatusPageProjectionV1 } from '@watchrail/domain';

@Injectable()
export class PublicStatusPagesService {
  constructor(
    @Inject(PublicStatusPageRepository)
    private readonly pages: PublicStatusPageRepository,
  ) {}

  async find(slug: string): Promise<PublicStatusPageProjectionV1> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) || slug.length < 3 || slug.length > 63) {
      this.notFound();
    }
    const page = await this.pages.findPublishedBySlug(slug);
    if (!page) this.notFound();
    return page;
  }

  private notFound(): never {
    throw new NotFoundException({
      code: 'STATUS_PAGE_NOT_FOUND',
      message: 'Status page not found.',
    });
  }
}
