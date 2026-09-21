import { Inject, Injectable, UnauthorizedException, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from './config.js';

export interface RequestContext {
  actorId: string;
  organizationId: string;
}

export interface RequestWithContext extends Request {
  watchrailContext: RequestContext;
}

export const DEVELOPMENT_REQUEST_CONTEXT: RequestContext = {
  actorId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
};

@Injectable()
export class DevelopmentIdentityMiddleware implements NestMiddleware {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  use(request: RequestWithContext, _response: Response, next: NextFunction): void {
    if (!this.config.developmentIdentityEnabled) {
      throw new UnauthorizedException('Authentication is required.');
    }

    request.watchrailContext = DEVELOPMENT_REQUEST_CONTEXT;
    next();
  }
}
