import { timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { StatusPageDomainRepository, normalizeStatusHostname } from '@watchrail/db';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { Public } from '../../auth/auth.guard.js';

@Public()
@Controller('internal/status-domains')
export class StatusDomainRoutingController {
  constructor(
    @Inject(StatusPageDomainRepository) private readonly domains: StatusPageDomainRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  @Get('eligible')
  async eligible(
    @Headers('x-watchrail-internal-token') token: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    this.authenticate(token, this.config.publicStatusPageInternalToken);
    return { data: await this.domains.eligibleHostnames() };
  }
  @Get('resolve')
  async resolve(
    @Query('hostname') hostname: string,
    @Headers('x-watchrail-internal-token') token: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    this.authenticate(token, this.config.publicStatusPageInternalToken);
    const host = typeof hostname === 'string' ? normalizeStatusHostname(hostname) : null;
    const binding = host ? await this.domains.resolve(host) : null;
    if (!binding) throw new NotFoundException();
    return { data: binding };
  }
  // Caddy's ask protocol cannot add custom headers. A dedicated random query secret is kept
  // on the internal network; neither the public web proxy nor the Caddy public vhost exposes it.
  @Get('ask')
  async ask(
    @Query('domain') hostname: string,
    @Query('key') key: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const secret = process.env.STATUS_DOMAIN_CADDY_ASK_SECRET ?? '';
    if (secret.length < 32) throw new UnauthorizedException();
    this.authenticate(key, secret);
    const host = typeof hostname === 'string' ? normalizeStatusHostname(hostname) : null;
    if (!host || !(await this.domains.resolve(host))) throw new NotFoundException();
    return { allowed: true };
  }
  private authenticate(candidate: string | undefined, expected: string) {
    const a = Buffer.from(typeof candidate === 'string' ? candidate : '');
    const b = Buffer.from(expected);
    if (b.length === 0 || a.length !== b.length || !timingSafeEqual(a, b))
      throw new UnauthorizedException();
  }
}
