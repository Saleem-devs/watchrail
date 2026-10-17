import { describe, expect, it } from 'vitest';
import { loadAppConfig } from './config.js';

const encryptionEnvironment = {
  HTTP_HEADER_ACTIVE_KEY_ID: 'test',
  HTTP_HEADER_ENCRYPTION_KEYS: JSON.stringify({ test: Buffer.alloc(32).toString('base64') }),
  ASSERTION_ACTIVE_KEY_ID: 'test',
  ASSERTION_ENCRYPTION_KEYS: JSON.stringify({ test: Buffer.alloc(32).toString('base64') }),
  WEBHOOK_SIGNING_SECRET_ACTIVE_KEY_ID: 'test',
  WEBHOOK_SIGNING_SECRET_ENCRYPTION_KEYS: JSON.stringify({
    test: Buffer.alloc(32).toString('base64'),
  }),
};

describe('loadAppConfig', () => {
  it('rejects the development identity adapter in production', () => {
    expect(() =>
      loadAppConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://example.invalid/watchrail',
        DEV_IDENTITY_ENABLED: 'true',
        ...encryptionEnvironment,
      }),
    ).toThrow('DEV_IDENTITY_ENABLED cannot be true in production.');
  });

  it('accepts explicit development configuration', () => {
    expect(
      loadAppConfig({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://example.invalid/watchrail',
        DEV_IDENTITY_ENABLED: 'true',
        PORT: '4000',
        ...encryptionEnvironment,
      }),
    ).toMatchObject({
      nodeEnv: 'development',
      developmentIdentityEnabled: true,
      port: 4000,
      probePendingAssignmentTimeoutMs: 120_000,
      multiLocationExecutionEnabled: false,
      frontendOrigins: ['http://localhost:3000', 'http://localhost:3010'],
    });
  });

  it('validates the pending probe assignment timeout used by machine claims', () => {
    expect(() =>
      loadAppConfig({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://example.invalid/watchrail',
        DEV_IDENTITY_ENABLED: 'true',
        PROBE_PENDING_ASSIGNMENT_TIMEOUT_MS: '9999',
        ...encryptionEnvironment,
      }),
    ).toThrow('PROBE_PENDING_ASSIGNMENT_TIMEOUT_MS must be an integer from 10000 to 900000.');
  });

  it('requires an explicit boolean multi-location readiness gate', () => {
    expect(
      loadAppConfig({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://example.invalid/watchrail',
        DEV_IDENTITY_ENABLED: 'true',
        MULTI_LOCATION_EXECUTION_ENABLED: 'true',
        ...encryptionEnvironment,
      }).multiLocationExecutionEnabled,
    ).toBe(true);
    expect(() =>
      loadAppConfig({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://example.invalid/watchrail',
        DEV_IDENTITY_ENABLED: 'true',
        MULTI_LOCATION_EXECUTION_ENABLED: 'yes',
        ...encryptionEnvironment,
      }),
    ).toThrow('MULTI_LOCATION_EXECUTION_ENABLED must be true or false.');
  });

  it('requires an explicit internal status-page token in production', () => {
    expect(() =>
      loadAppConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://example.invalid/watchrail',
        DEV_IDENTITY_ENABLED: 'false',
        ...encryptionEnvironment,
      }),
    ).toThrow('PUBLIC_STATUS_PAGE_INTERNAL_TOKEN must contain at least 32 characters.');
  });

  it('normalizes configured frontend origins for CORS and Better Auth', () => {
    const config = loadAppConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://example.invalid/watchrail',
      DEV_IDENTITY_ENABLED: 'false',
      FRONTEND_URL: 'http://localhost:3010',
      BETTER_AUTH_TRUSTED_ORIGINS: 'https://preview.watchrail.example,http://localhost:3010',
      ...encryptionEnvironment,
    });

    expect(config.frontendOrigins).toEqual([
      'http://localhost:3010',
      'https://preview.watchrail.example',
    ]);
    expect(config.betterAuth.trustedOrigins).toEqual(config.frontendOrigins);
  });

  it('rejects trusted origins containing paths or credentials', () => {
    expect(() =>
      loadAppConfig({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://example.invalid/watchrail',
        DEV_IDENTITY_ENABLED: 'false',
        FRONTEND_URL: 'https://watchrail.example/sign-in',
        ...encryptionEnvironment,
      }),
    ).toThrow('Frontend origins must be bare HTTP or HTTPS origins.');
  });
});
