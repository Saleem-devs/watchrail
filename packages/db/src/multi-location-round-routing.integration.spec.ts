import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { asc, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createMonitor } from '@watchrail/domain';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import { ManualRoundRepository } from './manual-round-repository.js';
import { migrateDatabase } from './migration.js';
import { MonitorLocationUnavailableError, MonitorRepository } from './monitor-repository.js';
import {
  createPreparedRoutedAssignments,
  createRoundLocationSnapshot,
  MonitorLocationInvariantError,
} from './round-routing.js';
import {
  checkExecutionAssignments,
  checkRoundLocations,
  checkRoundOutbox,
  checkRounds,
  monitorConfigurationVersions,
  monitors,
  probeLocations,
} from './schema.js';

const organizationA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const organizationB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('multi-location round persistence and prepared routing', () => {
  let container: StartedPostgreSqlContainer;
  let connection: DatabaseConnection;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    connection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));
  }, 60_000);

  beforeEach(async () => {
    await connection.pool.query(`
      truncate table
        check_round_outbox,
        check_execution_assignments,
        check_round_locations,
        check_rounds,
        monitor_configuration_versions,
        monitors,
        probe_locations
      cascade
    `);
  });

  afterAll(async () => {
    await connection?.pool.end();
    await container?.stop();
  });

  it('persists a canonical immutable snapshot and can atomically prepare one assignment per location', async () => {
    const repository = new MonitorRepository(connection.db);
    const monitor = await repository.create(
      organizationA,
      createMonitor({ name: 'Distributed API', url: 'https://example.com/health' }),
    );
    const locations = await connection.db
      .insert(probeLocations)
      .values([
        { organizationId: organizationA, name: 'Lagos', slug: 'lagos' },
        { organizationId: organizationA, name: 'Frankfurt', slug: 'frankfurt' },
      ])
      .returning({ id: probeLocations.id });
    const expectedLocations = [...locations.map(({ id }) => id), 'local'].sort();
    await repository.updateLocations(organizationA, monitor.id, [
      locations[1]!.id,
      'local',
      locations[0]!.id,
    ]);
    const [configuration] = await connection.db
      .select()
      .from(monitorConfigurationVersions)
      .where(eq(monitorConfigurationVersions.monitorId, monitor.id))
      .orderBy(desc(monitorConfigurationVersions.versionNumber))
      .limit(1);
    expect(configuration!.locations).toEqual(expectedLocations);

    const round = await connection.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(checkRounds)
        .values({
          organizationId: organizationA,
          monitorId: monitor.id,
          monitorConfigurationVersionId: configuration!.id,
        })
        .returning();
      const snapshot = await createRoundLocationSnapshot(tx, {
        organizationId: organizationA,
        roundId: created!.id,
        locations: configuration!.locations,
      });
      await createPreparedRoutedAssignments(tx, {
        organizationId: organizationA,
        roundId: created!.id,
        locations: snapshot,
      });
      return created!;
    });

    expect(
      (
        await connection.db
          .select()
          .from(checkRoundLocations)
          .where(eq(checkRoundLocations.roundId, round.id))
          .orderBy(asc(checkRoundLocations.position))
      ).map(({ location }) => location),
    ).toEqual(expectedLocations);
    expect(
      (
        await connection.db
          .select()
          .from(checkExecutionAssignments)
          .where(eq(checkExecutionAssignments.roundId, round.id))
          .orderBy(asc(checkExecutionAssignments.location))
      ).map(({ location }) => location),
    ).toEqual(expectedLocations);
    expect(await connection.db.select().from(checkRoundOutbox)).toHaveLength(1);

    await repository.updateLocations(organizationA, monitor.id, [locations[0]!.id]);
    expect(
      (
        await connection.db
          .select()
          .from(checkRoundLocations)
          .where(eq(checkRoundLocations.roundId, round.id))
          .orderBy(asc(checkRoundLocations.position))
      ).map(({ location }) => location),
    ).toEqual(expectedLocations);
  });

  it('keeps multi-location execution inactive in normal round creation', async () => {
    const repository = new MonitorRepository(connection.db);
    const monitor = await repository.create(
      organizationA,
      createMonitor({ name: 'Inactive routing', url: 'https://example.com/health' }),
    );
    const [location] = await connection.db
      .insert(probeLocations)
      .values({ organizationId: organizationA, name: 'Lagos', slug: 'lagos' })
      .returning();
    await repository.updateLocations(organizationA, monitor.id, ['local', location!.id]);

    await expect(
      new ManualRoundRepository(connection.db).create(organizationA, monitor.id),
    ).rejects.toBeInstanceOf(MonitorLocationInvariantError);
    expect(await connection.db.select().from(checkRounds)).toEqual([]);
    expect(await connection.db.select().from(checkRoundLocations)).toEqual([]);
    expect(await connection.db.select().from(checkExecutionAssignments)).toEqual([]);
  });

  it('rejects a foreign organization location before appending a configuration version', async () => {
    const repository = new MonitorRepository(connection.db);
    const monitor = await repository.create(
      organizationA,
      createMonitor({ name: 'Tenant boundary', url: 'https://example.com/health' }),
    );
    const [foreign] = await connection.db
      .insert(probeLocations)
      .values({ organizationId: organizationB, name: 'Foreign', slug: 'foreign' })
      .returning();

    await expect(
      repository.updateLocations(organizationA, monitor.id, ['local', foreign!.id]),
    ).rejects.toBeInstanceOf(MonitorLocationUnavailableError);
    expect(
      await connection.db
        .select()
        .from(monitorConfigurationVersions)
        .where(eq(monitorConfigurationVersions.monitorId, monitor.id)),
    ).toHaveLength(1);
  });

  it('enforces unique canonical configuration locations and assignment membership in PostgreSQL', async () => {
    const repository = new MonitorRepository(connection.db);
    const monitor = await repository.create(
      organizationA,
      createMonitor({ name: 'Database invariants', url: 'https://example.com/health' }),
    );
    await expect(
      connection.db.update(monitors).set({ locations: ['local', 'local'] }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514' }) });

    const round = await new ManualRoundRepository(connection.db).create(organizationA, monitor.id);
    const [location] = await connection.db
      .insert(probeLocations)
      .values({ organizationId: organizationA, name: 'Outside snapshot', slug: 'outside' })
      .returning();
    await expect(
      connection.db.insert(checkExecutionAssignments).values({
        organizationId: organizationA,
        roundId: round.id,
        location: location!.id,
        probeLocationId: location!.id,
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23503' }) });
  });
});
