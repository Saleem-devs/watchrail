import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../auth/auth.guard.js';
import { PublicStatusPageRateLimiter } from '../../common/rate-limiting/public-status-page-rate-limiter.js';
import { HeartbeatsService } from './heartbeats.service.js';

@Public()
@Controller('heartbeats')
export class HeartbeatsController {
  constructor(
    @Inject(HeartbeatsService) private readonly heartbeats: HeartbeatsService,
    @Inject(PublicStatusPageRateLimiter)
    private readonly limiter: PublicStatusPageRateLimiter,
  ) {}

  @Post(':token')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store, max-age=0')
  async receive(
    @Param('token') token: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const limit = this.limiter.consume(`${request.ip ?? 'unknown'}:${token.slice(0, 12)}`);
    if (!limit.allowed) {
      response.setHeader('Retry-After', String(limit.retryAfterSeconds));
      throw new HttpException(
        { code: 'HEARTBEAT_RATE_LIMIT_EXCEEDED', message: 'Too many heartbeat signals.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const receipt = await this.heartbeats.receive(token, body);
    return {
      data: {
        monitorId: receipt.monitorId,
        state: receipt.state,
        receivedAt: receipt.receivedAt.toISOString(),
        nextExpectedAt: receipt.nextExpectedAt?.toISOString() ?? null,
      },
    };
  }
}
