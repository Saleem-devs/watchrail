import { timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { PUBLIC_STATUS_PAGE_NO_STORE } from './public-status-page-http.js';
import { InternalStatusPageRateLimiter } from '../../common/rate-limiting/public-status-page-rate-limiter.js';
import { PublicStatusPagesService } from './public-status-pages.service.js';
import { Public } from '../../auth/auth.guard.js';

@Public()
@Controller('internal/status-pages')
export class InternalStatusPagesController {
  constructor(
    @Inject(PublicStatusPagesService)
    private readonly pages: PublicStatusPagesService,
    @Inject(InternalStatusPageRateLimiter)
    private readonly limiter: InternalStatusPageRateLimiter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get(':slug')
  async find(
    @Param('slug') slug: string,
    @Headers('x-watchrail-internal-token') token: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', PUBLIC_STATUS_PAGE_NO_STORE);
    if (!tokenMatches(token, this.config.publicStatusPageInternalToken)) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Unauthorized.' });
    }
    const limit = this.limiter.consume();
    if (!limit.allowed) {
      response.setHeader('Retry-After', String(limit.retryAfterSeconds));
      throw new HttpException(
        { code: 'PUBLIC_RATE_LIMIT_EXCEEDED', message: 'Too many requests.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return { data: await this.pages.find(slug) };
  }
}

function tokenMatches(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
