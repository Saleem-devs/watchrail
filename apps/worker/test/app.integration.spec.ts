import 'reflect-metadata';
import { resolve } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { DrizzleModule, getDrizzleToken } from '@nestjs/drizzle';
import { NestFactory } from '@nestjs/core';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { createDatabaseConnection, migrateDatabase } from '@watchrail/db';
import type { WatchrailDatabase } from '@watchrail/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

describe('worker application lifecycle', () => {
  let app: INestApplicationContext;
  let database: WatchrailDatabase;
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;

  const originalEnvironment = {
    databaseUrl: process.env.DATABASE_URL,
    dependencyErrorDelayMs: process.env.OUTBOX_DEPENDENCY_ERROR_DELAY_MS,
    idlePollIntervalMs: process.env.OUTBOX_IDLE_POLL_INTERVAL_MS,
    redisUrl: process.env.REDIS_URL,
  };

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer('postgres:18.0-alpine').start(),
      new RedisContainer('redis:8.2-alpine').start(),
    ]);

    process.env.DATABASE_URL = postgres.getConnectionUri();
    process.env.REDIS_URL = redis.getConnectionUrl();
    process.env.OUTBOX_IDLE_POLL_INTERVAL_MS = '10';
    process.env.OUTBOX_DEPENDENCY_ERROR_DELAY_MS = '10';

    const migrationConnection = createDatabaseConnection(postgres.getConnectionUri());
    await migrateDatabase(migrationConnection, resolve(process.cwd(), '../../packages/db/drizzle'));
    await migrationConnection.pool.end();

    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    database = app.get<WatchrailDatabase>(getDrizzleToken());
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await expect(database.$client.query('select 1')).rejects.toThrow();
    await Promise.all([postgres?.stop(), redis?.stop()]);

    restoreEnvironment('DATABASE_URL', originalEnvironment.databaseUrl);
    restoreEnvironment('REDIS_URL', originalEnvironment.redisUrl);
    restoreEnvironment('OUTBOX_IDLE_POLL_INTERVAL_MS', originalEnvironment.idlePollIntervalMs);
    restoreEnvironment(
      'OUTBOX_DEPENDENCY_ERROR_DELAY_MS',
      originalEnvironment.dependencyErrorDelayMs,
    );
  });

  it('provides the official Drizzle database and closes its pool with the app', async () => {
    await expect(database.$client.query('select 1')).resolves.toMatchObject({ rowCount: 1 });
    expect(app.get(DrizzleModule)).toBeInstanceOf(DrizzleModule);
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
