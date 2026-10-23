/**
 * BetterAuthMiddleware mounts the Better Auth request handler inside NestJS.
 *
 * All requests to /api/auth/* are intercepted here before NestJS routing.
 * The middleware calls `toNodeHandler(auth.handler)` which converts Better
 * Auth's Web API handler to a Node.js IncomingMessage/ServerResponse handler,
 * compatible with Express (which NestJS uses under the hood).
 *
 * Important: `bodyParser: false` must be set in main.ts so that Express does
 * not consume the request body before Better Auth can read it.
 */

import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { toNodeHandler } from 'better-auth/node';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NextFunction } from 'express';
import { WATCHRAIL_AUTH } from './auth.tokens.js';
import type { WatchrailAuth } from './auth.js';

@Injectable()
export class BetterAuthMiddleware implements NestMiddleware {
  private readonly handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;

  constructor(@Inject(WATCHRAIL_AUTH) auth: WatchrailAuth) {
    this.handler = toNodeHandler(auth.handler);
  }

  async use(req: IncomingMessage, res: ServerResponse, next: NextFunction): Promise<void> {
    // Let Better Auth handle the request.
    // If Better Auth doesn't recognize the path, it returns undefined and we
    // call next() to pass control to NestJS routes.
    const result = await this.handler(req, res).catch((err: unknown) => err);

    // toNodeHandler writes to the response directly if it matches.
    // Check if the response has been sent.
    if (res.writableEnded) return;

    if (result instanceof Error) {
      next(result);
      return;
    }

    next();
  }
}
