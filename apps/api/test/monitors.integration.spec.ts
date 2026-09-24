import 'reflect-metadata';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDatabaseConnection, migrateDatabase } from '@watchrail/db';
import type { WatchrailDatabase } from '@watchrail/db';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

describe('monitor API', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let database: WatchrailDatabase;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DEV_IDENTITY_ENABLED = 'true';

    const migrationConnection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(migrationConnection, resolve(process.cwd(), '../../packages/db/drizzle'));
    await migrationConnection.pool.end();

    const testingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    database = testingModule.get<WatchrailDatabase>(getDrizzleToken());
    app = testingModule.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  }, 60_000);

  beforeEach(async () => {
    const connection = createDatabaseConnection(container.getConnectionUri());
    await connection.pool.query(`
      truncate table
        check_execution_results,
        check_round_outbox,
        check_execution_assignments,
        check_rounds,
        monitor_configuration_versions,
        monitors
      cascade
    `);
    await connection.pool.end();
  });

  afterAll(async () => {
    await app?.close();
    await expect(database.$client.query('select 1')).rejects.toThrow(
      'Cannot use a pool after calling end on the pool',
    );
    await container?.stop();
  });

  it('creates and lists a monitor with server-owned defaults', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/monitors')
      .send({
        name: 'Public API',
        url: 'https://example.com/health',
        method: 'DELETE',
        lifecycleState: 'ARCHIVED',
      })
      .expect(201);

    expect(created.body.data).toMatchObject({
      name: 'Public API',
      url: 'https://example.com/health',
      method: 'GET',
      lifecycleState: 'ENABLED',
      timeoutMs: 10_000,
      locations: ['local'],
    });

    const listed = await request(app.getHttpServer()).get('/api/monitors').expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].id).toBe(created.body.data.id);
  });

  it('returns field-level errors and does not create a partial record', async () => {
    const invalid = await request(app.getHttpServer())
      .post('/api/monitors')
      .send({ name: ' ', url: 'ftp://example.com' })
      .expect(400);

    expect(invalid.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: {
        name: ['Enter a monitor name.'],
        url: ['Use an HTTP or HTTPS URL.'],
      },
    });

    const listed = await request(app.getHttpServer()).get('/api/monitors').expect(200);
    expect(listed.body.data).toEqual([]);
  });
});
