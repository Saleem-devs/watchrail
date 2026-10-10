import { Controller, Get, Param } from '@nestjs/common';
import { PublicStatusPagesService } from './public-status-pages.service.js';

@Controller('public/status-pages')
export class PublicStatusPagesController {
  constructor(private readonly pages: PublicStatusPagesService) {}

  @Get(':slug')
  async find(@Param('slug') slug: string) {
    return { data: await this.pages.find(slug) };
  }
}
