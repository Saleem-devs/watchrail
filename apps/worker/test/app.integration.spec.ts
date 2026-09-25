import 'reflect-metadata';
import { resolve } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { DrizzleModule, getDrizzleToken } from '@nestjs/drizzle';
import { NestFactory } from '@nestjs/core';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import {
  checkExecutionResults,
  createDatabaseConnection,
  ManualRoundRepository,
  migrateDatabase,
  MonitorRepository,
} from '@watchrail/db';
import type { WatchrailDatabase } from '@watchrail/db';
import { createMonitor } from '@watchrail/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

describe('worker application lifecycle', () => {
  let app: INestApplicationContext | undefined;
  let database: WatchrailDatabase | undefined;
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;

  const originalEnvironment = {
    databaseUrl: process.env.DATABASE_URL,
    dependencyErrorDelayMs: process.env.OUTBOX_DEPENDENCY_ERROR_DELAY_MS,
    idlePollIntervalMs: process.env.OUTBOX_IDLE_POLL_INTERVAL_MS,
    redisUrl: process.env.REDIS_URL,
    headerActiveKeyId: process.env.HTTP_HEADER_ACTIVE_KEY_ID,
    headerEncryptionKeys: process.env.HTTP_HEADER_ENCRYPTION_KEYS,
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
    process.env.HTTP_HEADER_ACTIVE_KEY_ID = 'test';
    process.env.HTTP_HEADER_ENCRYPTION_KEYS = JSON.stringify({
      test: Buffer.alloc(32).toString('base64'),
    });

    const migrationConnection = createDatabaseConnection(postgres.getConnectionUri());
    await migrateDatabase(migrationConnection, resolve(process.cwd(), '../../packages/db/drizzle'));
    await migrationConnection.pool.end();

    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    database = app.get<WatchrailDatabase>(getDrizzleToken());
  }, 60_000);

  afterAll(async () => {
    if (app && database) {
      await app.close();
      await expect(database.$client.query('select 1')).rejects.toThrow();
    }
    await Promise.all([postgres?.stop(), redis?.stop()]);

    restoreEnvironment('DATABASE_URL', originalEnvironment.databaseUrl);
    restoreEnvironment('REDIS_URL', originalEnvironment.redisUrl);
    restoreEnvironment('OUTBOX_IDLE_POLL_INTERVAL_MS', originalEnvironment.idlePollIntervalMs);
    restoreEnvironment('HTTP_HEADER_ACTIVE_KEY_ID', originalEnvironment.headerActiveKeyId);
    restoreEnvironment('HTTP_HEADER_ENCRYPTION_KEYS', originalEnvironment.headerEncryptionKeys);
    restoreEnvironment(
      'OUTBOX_DEPENDENCY_ERROR_DELAY_MS',
      originalEnvironment.dependencyErrorDelayMs,
    );
  });

  it('provides the official Drizzle database and closes its pool with the app', async () => {
    if (!app || !database) throw new Error('Expected the worker application to start.');

    await expect(database.$client.query('select 1')).resolves.toMatchObject({ rowCount: 1 });
    expect(app.get(DrizzleModule)).toBeInstanceOf(DrizzleModule);
  });

  it('persists a prohibited local destination as execution uncertainty', async () => {
    if (!database) throw new Error('Expected the worker database to be available.');

    const monitor = await new MonitorRepository(database).create(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createMonitor({ name: 'Local target', url: 'http://127.0.0.1:65535/health' }),
    );
    const round = await new ManualRoundRepository(database).create(
      monitor.organizationId,
      monitor.id,
    );

    const result = await waitForResult(database, round.id);

    expect(result).toMatchObject({
      roundId: round.id,
      outcome: 'UNKNOWN',
      stage: 'DNS',
      reason: 'PROHIBITED_DESTINATION',
      statusCode: null,
      responseTimeMs: null,
    });
    expect(result.attemptDurationMs).toBeGreaterThanOrEqual(0);
  });
});

async function waitForResult(database: WatchrailDatabase, roundId: string) {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const [result] = await database
      .select()
      .from(checkExecutionResults)
      .where(eq(checkExecutionResults.roundId, roundId));

    if (result) return result;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }

  throw new Error(`Timed out waiting for a result for round ${roundId}.`);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
