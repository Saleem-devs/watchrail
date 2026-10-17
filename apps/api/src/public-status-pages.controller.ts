import {
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  PUBLIC_STATUS_PAGE_CACHE_CONTROL,
  PUBLIC_STATUS_PAGE_NO_STORE,
  createPublicStatusPageEtag,
  ifNoneMatchMatches,
} from './public-status-page-http.js';
import { PublicStatusPageRateLimiter } from './public-status-page-rate-limiter.js';
import { PublicStatusPagesService } from './public-status-pages.service.js';
import { Public } from './auth.guard.js';

@Public()
@Controller('public/status-pages')
export class PublicStatusPagesController {
  constructor(
    @Inject(PublicStatusPagesService)
    private readonly pages: PublicStatusPagesService,
    @Inject(PublicStatusPageRateLimiter)
    private readonly limiter: PublicStatusPageRateLimiter,
  ) {}

  @Get(':slug')
  async find(
    @Param('slug') slug: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    response.setHeader('Cache-Control', PUBLIC_STATUS_PAGE_NO_STORE);
    const limit = this.limiter.consume(request.ip ?? 'unknown');
    if (!limit.allowed) {
      response.setHeader('Retry-After', String(limit.retryAfterSeconds));
      throw new HttpException(
        { code: 'PUBLIC_RATE_LIMIT_EXCEEDED', message: 'Too many requests.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const page = await this.pages.find(slug);
    const etag = createPublicStatusPageEtag(page);
    response.setHeader('Cache-Control', PUBLIC_STATUS_PAGE_CACHE_CONTROL);
    response.setHeader('ETag', etag);
    if (ifNoneMatchMatches(ifNoneMatch, etag)) {
      response.status(304);
      return;
    }
    return { data: page };
  }
}
