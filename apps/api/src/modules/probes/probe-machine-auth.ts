import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
  type NestMiddleware,
} from '@nestjs/common';
import type { ProbeMachineIdentity } from '@watchrail/db';
import type { NextFunction, Request, Response } from 'express';
import { ProbeIdentityService } from './probe-identity.service.js';
import { PublicStatusPageRateLimiter } from '../../common/rate-limiting/public-status-page-rate-limiter.js';

export interface ProbeMachineRequest extends Request {
  probeMachineIdentity: ProbeMachineIdentity;
}

export class ProbeMachineRateLimiter extends PublicStatusPageRateLimiter {
  constructor() {
    super({
      clientCapacity: 20,
      clientRefillPerSecond: 0.5,
      globalCapacity: 300,
      globalRefillPerSecond: 5,
      clientTtlMs: 5 * 60_000,
      sweepIntervalMs: 30_000,
      maximumTrackedClients: 10_000,
      maximumRetryAfterSeconds: 60,
    });
  }
}

@Injectable()
export class ProbeMachineAuthGuard implements CanActivate {
  constructor(@Inject(ProbeIdentityService) private readonly identities: ProbeIdentityService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.header('authorization');
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization ?? '');
    if (!match) this.unauthorized();
    (request as ProbeMachineRequest).probeMachineIdentity = await this.identities.authenticate(
      match[1]!,
    );
    return true;
  }

  private unauthorized(): never {
    throw new UnauthorizedException({
      code: 'PROBE_AUTHENTICATION_FAILED',
      message: 'Probe authentication failed.',
    });
  }
}

@Injectable()
export class ProbeMachineNoStoreMiddleware implements NestMiddleware {
  constructor(@Inject(ProbeMachineRateLimiter) private readonly limiter: ProbeMachineRateLimiter) {}

  use(request: Request, response: Response, next: NextFunction): void {
    response.setHeader('Cache-Control', 'no-store');
    const result = this.limiter.consume(request.ip ?? request.socket.remoteAddress ?? 'unknown');
    if (!result.allowed) {
      response.setHeader('Retry-After', String(result.retryAfterSeconds));
      throw new HttpException(
        { code: 'RATE_LIMITED', message: 'Too many requests.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    next();
  }
}
