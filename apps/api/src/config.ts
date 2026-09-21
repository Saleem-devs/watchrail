export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  developmentIdentityEnabled: boolean;
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

  return { nodeEnv, port, databaseUrl, developmentIdentityEnabled };
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
