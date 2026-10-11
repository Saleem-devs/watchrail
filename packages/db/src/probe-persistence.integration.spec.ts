import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMonitor } from '@watchrail/domain';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import { ManualRoundRepository } from './manual-round-repository.js';
import { migrateDatabase } from './migration.js';
import { MonitorRepository } from './monitor-repository.js';

const organizationA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const organizationB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const verifierA = 'A'.repeat(43);
const verifierB = 'B'.repeat(43);

describe('probe persistence invariants', () => {
  let container: StartedPostgreSqlContainer;
  let connection: DatabaseConnection;
  let monitors: MonitorRepository;
  let rounds: ManualRoundRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    connection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));
    monitors = new MonitorRepository(connection.db);
    rounds = new ManualRoundRepository(connection.db);
  }, 60_000);

  beforeEach(async () => {
    await connection.pool.query('truncate probe_locations, monitors cascade');
  });

  afterAll(async () => {
    await connection?.pool.end();
    await container?.stop();
  });

  it('binds agents, credentials, enrollments, and assignments to one organization and location', async () => {
    const locationId = await createLocation(organizationA, 'frankfurt');
    const agentId = await createAgent(organizationA, locationId);
    const monitor = await monitors.create(
      organizationA,
      createMonitor({ name: 'API', url: 'https://example.com/health' }),
    );
    const round = await rounds.create(organizationA, monitor.id);

    await expect(
      connection.pool.query(
        `update check_execution_assignments
            set location = $1::text, probe_location_id = $1::uuid
          where organization_id = $2 and round_id = $3`,
        [locationId, organizationA, round.id],
      ),
    ).resolves.toBeDefined();

    await expect(
      connection.pool.query(
        `insert into probe_agent_credentials
           (organization_id, agent_id, version_number, verifier)
         values ($1, $2, 1, $3)`,
        [organizationB, agentId, verifierA],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    await expect(
      connection.pool.query(
        `insert into probe_agent_enrollments
           (organization_id, location_id, agent_name, token_verifier, expires_at)
         values ($1, $2, 'Wrong tenant', $3, clock_timestamp() + interval '10 minutes')`,
        [organizationB, locationId, verifierA],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    await expect(
      connection.pool.query(
        `update check_execution_assignments
            set location = $1::text, probe_location_id = $1::uuid
          where organization_id = $2 and round_id = $3`,
        [await createLocation(organizationB, 'lagos'), organizationA, round.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('stores credential and claim verifiers while enforcing rotation and attempt identity', async () => {
    const locationId = await createLocation(organizationA, 'frankfurt');
    const agentId = await createAgent(organizationA, locationId);
    await connection.pool.query(
      `insert into probe_agent_credentials
         (organization_id, agent_id, version_number, verifier)
       values ($1, $2, 1, $3)`,
      [organizationA, agentId, verifierA],
    );
    await expect(
      connection.pool.query(
        `insert into probe_agent_credentials
           (organization_id, agent_id, version_number, verifier)
         values ($1, $2, 2, $3)`,
        [organizationA, agentId, verifierB],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    const monitor = await monitors.create(
      organizationA,
      createMonitor({ name: 'API', url: 'https://example.com/health' }),
    );
    const round = await rounds.create(organizationA, monitor.id);
    const assignment = await connection.pool.query<{ id: string }>(
      'select id from check_execution_assignments where round_id = $1',
      [round.id],
    );
    const assignmentId = assignment.rows[0]!.id;

    await connection.pool.query(
      `insert into probe_execution_attempts
         (organization_id, assignment_id, agent_id, attempt_number, claim_token_verifier,
          lease_expires_at)
       values ($1, $2, $3, 1, $4, clock_timestamp() + interval '30 seconds')`,
      [organizationA, assignmentId, agentId, verifierB],
    );
    await expect(
      connection.pool.query(
        `insert into probe_execution_attempts
           (organization_id, assignment_id, agent_id, attempt_number, claim_token_verifier,
            lease_expires_at)
         values ($1, $2, $3, 1, $4, clock_timestamp() + interval '30 seconds')`,
        [organizationA, assignmentId, agentId, 'C'.repeat(43)],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('keeps local assignments valid while rejecting ambiguous remote identity', async () => {
    const monitor = await monitors.create(
      organizationA,
      createMonitor({ name: 'API', url: 'https://example.com/health' }),
    );
    const round = await rounds.create(organizationA, monitor.id);
    const locationId = await createLocation(organizationA, 'frankfurt');
    const local = await connection.pool.query(
      'select location, probe_location_id from check_execution_assignments where round_id = $1',
      [round.id],
    );
    expect(local.rows).toEqual([{ location: 'local', probe_location_id: null }]);
    await expect(
      connection.pool.query(
        `update check_execution_assignments
            set location = 'local', probe_location_id = $1
          where round_id = $2`,
        [locationId, round.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  async function createLocation(organizationId: string, slug: string): Promise<string> {
    const result = await connection.pool.query<{ id: string }>(
      `insert into probe_locations (organization_id, name, slug)
       values ($1, $2, $3)
       returning id`,
      [organizationId, slug, slug],
    );
    return result.rows[0]!.id;
  }

  async function createAgent(organizationId: string, locationId: string): Promise<string> {
    const result = await connection.pool.query<{ id: string }>(
      `insert into probe_agents (organization_id, location_id, name)
       values ($1, $2, 'agent-1')
       returning id`,
      [organizationId, locationId],
    );
    return result.rows[0]!.id;
  }
});
