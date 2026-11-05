import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { ROLE_PERMISSIONS, type Permission } from './permissions.js';

export interface RequestContext {
  actorId: string;
  organizationId: string;
  /** Effective permissions after applying both role and API-key scope limits. */
  permissions: readonly Permission[];
  authenticationType?: 'SESSION' | 'API_KEY' | 'DEVELOPMENT';
}

export interface RequestWithContext extends Request {
  watchrailContext: RequestContext;
}

export const DEVELOPMENT_REQUEST_CONTEXT: RequestContext = {
  actorId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
  permissions: ROLE_PERMISSIONS.owner ?? [],
  authenticationType: 'DEVELOPMENT',
};

export function requestCan(context: RequestContext, permission: Permission): boolean {
  return context.permissions.includes(permission);
}

@Injectable()
export class DevelopmentIdentityMiddleware implements NestMiddleware {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  use(request: RequestWithContext, _response: Response, next: NextFunction): void {
    // Real credentials always take precedence. This lets developers exercise
    // production authentication locally while retaining the credential-free
    // development identity used by integration tests.
    if (
      !this.config.developmentIdentityEnabled ||
      request.headers.cookie !== undefined ||
      request.headers.authorization !== undefined
    ) {
      next();
      return;
    }

    request.watchrailContext = DEVELOPMENT_REQUEST_CONTEXT;
    next();
  }
}
