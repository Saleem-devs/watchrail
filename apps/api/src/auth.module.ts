/**
 * AuthModule — provides the Better Auth instance as an injectable token.
 *
 * The Better Auth instance requires the Drizzle database and app config,
 * so it is created via `useFactory` with those dependencies injected.
 *
 * The WATCHRAIL_AUTH token is injected into WatchrailAuthGuard, the
 * BetterAuthMiddleware, and any controller or service that needs to call
 * Better Auth's internal API (e.g., creating organizations).
 */

import { Global, Module, type FactoryProvider } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { WatchrailDatabase } from '@watchrail/db';
import { DatabaseModule } from './database.module.js';
import { APP_CONFIG, type AppConfig } from './config.js';
import { createAuth, type WatchrailAuth } from './auth.js';
import { WatchrailAuthGuard } from './auth.guard.js';
import { WATCHRAIL_AUTH } from './auth.tokens.js';

export { WATCHRAIL_AUTH } from './auth.tokens.js';

const authProvider: FactoryProvider<WatchrailAuth> = {
  provide: WATCHRAIL_AUTH,
  inject: [getDrizzleToken(), APP_CONFIG],
  useFactory: (db: WatchrailDatabase, config: AppConfig): WatchrailAuth => {
    return createAuth(db, {
      baseUrl: config.betterAuth.baseUrl,
      secret: config.betterAuth.secret,
      trustedOrigins: config.betterAuth.trustedOrigins,
      otpExpiresInSeconds: config.betterAuth.otpExpiresInSeconds,
      mail: config.mail,
      authEmailKeyring: config.authEmailKeyring,
      ...(config.betterAuth.github ? { github: config.betterAuth.github } : {}),
      ...(config.betterAuth.gitlab ? { gitlab: config.betterAuth.gitlab } : {}),
      ...(config.betterAuth.google ? { google: config.betterAuth.google } : {}),
    });
  },
};

@Global()
@Module({
  imports: [DatabaseModule],
  providers: [authProvider, WatchrailAuthGuard, Reflector],
  exports: [WATCHRAIL_AUTH, WatchrailAuthGuard],
})
export class AuthModule {}
