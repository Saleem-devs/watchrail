import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { StatusPageSubscriptionRepository } from '@watchrail/db';
import { Public } from '../../auth/auth.guard.js';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';

@Public()
@Controller('public/status-subscriptions')
export class StatusSubscriptionsController {
  constructor(
    @Inject(StatusPageSubscriptionRepository)
    private readonly subscriptions: StatusPageSubscriptionRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async limit(request: Request, response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    if (!(await this.subscriptions.consumeLimit(`ip:${request.ip ?? 'unknown'}`, 30))) {
      response.setHeader('Retry-After', '3600');
      throw new HttpException(
        { code: 'SUBSCRIPTION_RATE_LIMIT', message: 'Too many requests. Please try again later.' },
        429,
      );
    }
  }

  @Post()
  @HttpCode(202)
  async request(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.limit(request, response);
    const data = this.object(body);
    if (
      typeof data.slug !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(data.slug) ||
      data.slug.length > 63 ||
      typeof data.email !== 'string' ||
      data.email.length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(data.email.trim())
    ) {
      throw new BadRequestException({
        code: 'INVALID_SUBSCRIPTION',
        message: 'Enter a valid email address.',
      });
    }
    if (await this.subscriptions.consumeLimit(`page:${data.slug}`, 100)) {
      await this.subscriptions.request(data.slug, data.email, this.config.authEmailKeyring);
    }
    return { message: 'If eligible, a confirmation email will arrive shortly. Check your inbox.' };
  }

  @Post('verify')
  @HttpCode(200)
  async verify(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.limit(request, response);
    const data = this.object(body);
    if (typeof data.token !== 'string' || !(await this.subscriptions.confirm(data.token))) {
      throw new BadRequestException({
        code: 'INVALID_SUBSCRIPTION_TOKEN',
        message:
          'This confirmation link is invalid or expired. Subscribe again from the status page.',
      });
    }
    return {
      message: 'Subscription confirmed. You will receive future incident and maintenance updates.',
      statusPageSlug: await this.subscriptions.publicPageSlug(data.token as string, 'verify'),
    };
  }

  @Post('unsubscribe')
  @HttpCode(200)
  async unsubscribe(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    // Unsubscribe remains available even if a mailbox/IP has exhausted subscription limits.
    const data = this.object(body);
    if (typeof data.token !== 'string' || !/^[\w-]{43}$/u.test(data.token))
      throw new BadRequestException('Invalid unsubscribe link.');
    await this.subscriptions.unsubscribe(data.token);
    return {
      message: 'You are unsubscribed. No further updates will be sent for this subscription.',
      statusPageSlug: await this.subscriptions.publicPageSlug(data.token, 'unsubscribe'),
    };
  }

  private object(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('Invalid request.');
    return body as Record<string, unknown>;
  }
}
