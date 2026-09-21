import { describe, expect, it } from 'vitest';
import { loadAppConfig } from './config.js';

describe('loadAppConfig', () => {
  it('rejects the development identity adapter in production', () => {
    expect(() =>
      loadAppConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://example.invalid/watchrail',
        DEV_IDENTITY_ENABLED: 'true',
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
      }),
    ).toMatchObject({
      nodeEnv: 'development',
      developmentIdentityEnabled: true,
      port: 4000,
    });
  });
});
