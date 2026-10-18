import {
  loadHeaderEncryptionKeyring,
  type HeaderEncryptionKeyring,
} from '@watchrail/http-header-security';
import {
  loadAssertionEncryptionKeyring,
  type AssertionEncryptionKeyring,
} from '@watchrail/assertion-security';
import {
  loadWebhookSigningSecretKeyring,
  type WebhookSigningSecretKeyring,
} from '@watchrail/webhook-security';
import { loadMailConfig, type MailConfig } from './mail.js';
import { loadAuthEmailKeyring, type AuthEmailKeyring } from '@watchrail/db';

export const APP_CONFIG = Symbol('APP_CONFIG');

export interface BetterAuthProviderConfig {
  clientId: string;
  clientSecret: string;
}

export interface BetterAuthConfig {
  secret: string;
  baseUrl: string;
  trustedOrigins: string[];
  otpExpiresInSeconds: number;
  github?: BetterAuthProviderConfig;
  gitlab?: BetterAuthProviderConfig;
  google?: BetterAuthProviderConfig;
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  developmentIdentityEnabled: boolean;
  headerEncryptionKeyring: HeaderEncryptionKeyring;
  assertionEncryptionKeyring: AssertionEncryptionKeyring;
  webhookSigningSecretKeyring: WebhookSigningSecretKeyring;
  publicStatusPageInternalToken: string;
  probePendingAssignmentTimeoutMs: number;
  multiLocationExecutionEnabled: boolean;
  betterAuth: BetterAuthConfig;
  mail: MailConfig;
  authEmailKeyring: AuthEmailKeyring;
  frontendOrigins: string[];
}

export function loadAppConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = parseNodeEnvironment(environment.NODE_ENV);
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');

  const developmentIdentityEnabled = parseBoolean(
    environment.DEV_IDENTITY_ENABLED,
    'DEV_IDENTITY_ENABLED',
  );

  if (nodeEnv === 'production' && developmentIdentityEnabled) {
    throw new Error('DEV_IDENTITY_ENABLED cannot be true in production.');
  }

  const port = Number(environment.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer from 1 through 65535.');
  }

  const publicStatusPageInternalToken =
    environment.PUBLIC_STATUS_PAGE_INTERNAL_TOKEN ??
    (nodeEnv === 'production' ? undefined : 'watchrail-development-status-page-token');
  if (!publicStatusPageInternalToken || publicStatusPageInternalToken.length < 32) {
    throw new Error('PUBLIC_STATUS_PAGE_INTERNAL_TOKEN must contain at least 32 characters.');
  }

  const betterAuthSecret =
    environment.BETTER_AUTH_SECRET ??
    (nodeEnv === 'production' ? undefined : 'dev-secret-not-for-production-use-at-least-32-chars');
  if (!betterAuthSecret || betterAuthSecret.length < 32) {
    throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters.');
  }

  const betterAuthBaseUrl =
    environment.BETTER_AUTH_URL ??
    (nodeEnv === 'production' ? undefined : `http://localhost:${port}`);
  if (!betterAuthBaseUrl) {
    throw new Error('BETTER_AUTH_URL is required in production.');
  }

  const github = loadOAuthProvider(environment, 'GITHUB');
  const gitlab = loadOAuthProvider(environment, 'GITLAB');
  const google = loadOAuthProvider(environment, 'GOOGLE');
  const frontendOrigins = loadFrontendOrigins(environment, nodeEnv);

  return {
    nodeEnv,
    port,
    databaseUrl,
    developmentIdentityEnabled,
    headerEncryptionKeyring: loadHeaderEncryptionKeyring(environment),
    assertionEncryptionKeyring: loadAssertionEncryptionKeyring(environment),
    webhookSigningSecretKeyring: loadWebhookSigningSecretKeyring(environment),
    publicStatusPageInternalToken,
    probePendingAssignmentTimeoutMs: parseIntegerRange(
      environment.PROBE_PENDING_ASSIGNMENT_TIMEOUT_MS,
      'PROBE_PENDING_ASSIGNMENT_TIMEOUT_MS',
      120_000,
      10_000,
      900_000,
    ),
    multiLocationExecutionEnabled: parseBoolean(
      environment.MULTI_LOCATION_EXECUTION_ENABLED,
      'MULTI_LOCATION_EXECUTION_ENABLED',
    ),
    betterAuth: {
      secret: betterAuthSecret,
      baseUrl: betterAuthBaseUrl,
      trustedOrigins: frontendOrigins,
      otpExpiresInSeconds: parseIntegerRange(
        environment.AUTH_OTP_EXPIRES_IN_SECONDS,
        'AUTH_OTP_EXPIRES_IN_SECONDS',
        600,
        60,
        3600,
      ),
      ...(github ? { github } : {}),
      ...(gitlab ? { gitlab } : {}),
      ...(google ? { google } : {}),
    },
    mail: loadMailConfig(environment),
    authEmailKeyring: loadAuthEmailKeyring(
      nodeEnv === 'production'
        ? environment
        : {
            ...environment,
            AUTH_EMAIL_ACTIVE_KEY_ID: environment.AUTH_EMAIL_ACTIVE_KEY_ID ?? 'development',
            AUTH_EMAIL_ENCRYPTION_KEYS:
              environment.AUTH_EMAIL_ENCRYPTION_KEYS ??
              JSON.stringify({ development: Buffer.alloc(32, 7).toString('base64') }),
          },
    ),
    frontendOrigins,
  };
}

function loadFrontendOrigins(
  environment: NodeJS.ProcessEnv,
  nodeEnv: AppConfig['nodeEnv'],
): string[] {
  const configured = [
    environment.FRONTEND_URL,
    ...(environment.BETTER_AUTH_TRUSTED_ORIGINS?.split(',') ?? []),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  if (configured.length === 0 && nodeEnv !== 'production') {
    configured.push('http://localhost:3000', 'http://localhost:3010');
  }
  if (configured.length === 0) {
    throw new Error('FRONTEND_URL is required in production.');
  }

  return [...new Set(configured.map(parseOrigin))];
}

function parseOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Frontend origins must be absolute HTTP or HTTPS URLs.');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Frontend origins must be bare HTTP or HTTPS origins.');
  }
  return parsed.origin;
}

function loadOAuthProvider(
  environment: NodeJS.ProcessEnv,
  prefix: 'GITHUB' | 'GITLAB' | 'GOOGLE',
): BetterAuthProviderConfig | undefined {
  const clientId = environment[`${prefix}_CLIENT_ID`];
  const clientSecret = environment[`${prefix}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

function parseIntegerRange(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function parseNodeEnvironment(value: string | undefined): AppConfig['nodeEnv'] {
  if (!value || value === 'development') return 'development';
  if (value === 'test' || value === 'production') return value;
  throw new Error('NODE_ENV must be development, test, or production.');
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === 'true') return true;
  if (value === 'false' || value === undefined) return false;
  throw new Error(`${name} must be true or false.`);
}
