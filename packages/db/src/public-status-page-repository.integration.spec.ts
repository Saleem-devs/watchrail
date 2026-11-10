import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMonitor, EMPTY_ASSERTION_EVALUATION } from '@watchrail/domain';
import {
  CheckExecutionRepository,
  type AuthoritativeCheckResult,
} from './check-execution-repository.js';
import { createDatabaseConnection, type DatabaseConnection } from './client.js';
import { migrateDatabase } from './migration.js';
import { MaintenanceWindowRepository } from './maintenance-window-repository.js';
import { MonitorRepository } from './monitor-repository.js';
import { PublicStatusPageRepository } from './public-status-page-repository.js';
import { incidents, monitors } from './schema.js';
import { ScheduledRoundRepository } from './scheduled-round-repository.js';
import { StatusPageRepository } from './status-page-repository.js';
import { StatusPageIncidentRepository } from './status-page-incident-repository.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('PublicStatusPageRepository', () => {
  let container: StartedPostgreSqlContainer;
  let connection: DatabaseConnection;
  let monitorRepository: MonitorRepository;
  let apiMonitorId: string;
  let webMonitorId: string;
  let slug: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    connection = createDatabaseConnection(container.getConnectionUri());
    await migrateDatabase(connection, resolve(process.cwd(), 'drizzle'));
    monitorRepository = new MonitorRepository(connection.db);
  }, 60_000);

  beforeEach(async () => {
    await connection.pool.query('truncate status_pages, monitors cascade');
    const api = await monitorRepository.create(
      organizationId,
      createMonitor({ name: 'Private API monitor', url: 'https://secret.example.com/api' }),
    );
    const web = await monitorRepository.create(
      organizationId,
      createMonitor({ name: 'Private Web monitor', url: 'https://secret.example.com/web' }),
    );
    apiMonitorId = api.id;
    webMonitorId = web.id;
    slug = 'acme-status';
  });

  afterAll(async () => {
    await connection?.pool.end();
    await container?.stop();
  });

  it('makes missing and unpublished slugs indistinguishable', async () => {
    await createPage(false);
    const reads = new PublicStatusPageRepository(connection.db);
    await expect(reads.findPublishedBySlug(slug)).resolves.toBeNull();
    await expect(reads.findPublishedBySlug('missing-page')).resolves.toBeNull();
  });

  it('projects confirmed incident truth, impairment precedence, recovery, and safe fields', async () => {
    const configured = await createPage(true);
    const reads = new PublicStatusPageRepository(connection.db);
    await completeScheduled(apiMonitorId, healthy());
    await completeScheduled(webMonitorId, healthy());
    const operational = await reads.findPublishedBySlug(slug);
    expect(operational).toMatchObject({
      contractVersion: 1,
      name: 'Acme Status',
      slug,
      status: 'OPERATIONAL',
      components: [
        {
          id: configured.components[0]!.id,
          displayName: 'API',
          position: 0,
          status: 'OPERATIONAL',
        },
        {
          id: configured.components[1]!.id,
          displayName: 'Web',
          position: 1,
          status: 'OPERATIONAL',
        },
      ],
      activeIncidents: [],
      resolvedIncidents: [],
      generatedAt: expect.any(String),
    });

    await completeScheduled(apiMonitorId, unhealthy());
    expect((await reads.findPublishedBySlug(slug))!.status).toBe('MONITORING_IMPAIRED');
    await completeScheduled(apiMonitorId, unhealthy());
    await completeScheduled(apiMonitorId, unhealthy());
    const partial = await reads.findPublishedBySlug(slug);
    expect(partial).toMatchObject({
      status: 'PARTIAL_OUTAGE',
      components: [
        { id: configured.components[0]!.id, status: 'MAJOR_OUTAGE' },
        { id: configured.components[1]!.id, status: 'OPERATIONAL' },
      ],
      activeIncidents: [
        {
          componentId: configured.components[0]!.id,
          status: 'OPEN',
          resolvedAt: null,
        },
      ],
    });

    await completeScheduled(webMonitorId, unhealthy());
    const impaired = await reads.findPublishedBySlug(slug);
    expect(impaired!.status).toBe('MONITORING_IMPAIRED');
    expect(impaired!.activeIncidents).toHaveLength(1);

    await completeScheduled(apiMonitorId, healthy());
    await completeScheduled(webMonitorId, healthy());
    const recovered = await reads.findPublishedBySlug(slug);
    expect(recovered).toMatchObject({
      status: 'OPERATIONAL',
      activeIncidents: [],
      resolvedIncidents: [{ componentId: configured.components[0]!.id, status: 'RESOLVED' }],
    });

    const serialized = JSON.stringify(recovered);
    for (const forbidden of [
      organizationId,
      apiMonitorId,
      webMonitorId,
      'secret.example.com',
      'monitorId',
      'organizationId',
      'url',
      'headers',
      'assertions',
      'webhook',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('applies lifecycle impairment and the inclusive 90-day resolved window', async () => {
    await createPage(true);
    await completeScheduled(apiMonitorId, unhealthy());
    await completeScheduled(apiMonitorId, unhealthy());
    await completeScheduled(apiMonitorId, unhealthy());
    await completeScheduled(apiMonitorId, healthy());
    await connection.db
      .update(incidents)
      .set({ resolvedAt: sql`clock_timestamp() - interval '91 days'` })
      .where(eq(incidents.monitorId, apiMonitorId));
    await monitorRepository.updateLifecycle(organizationId, webMonitorId, 'PAUSED');
    const projection = await new PublicStatusPageRepository(connection.db).findPublishedBySlug(
      slug,
    );
    expect(projection).toMatchObject({
      status: 'MONITORING_IMPAIRED',
      components: [{ status: 'OPERATIONAL' }, { status: 'MONITORING_IMPAIRED' }],
      resolvedIncidents: [],
    });
  });

  it('projects degraded incident severity as a partial rather than major component outage', async () => {
    await createPage(true);
    await completeScheduled(webMonitorId, healthy());
    await completeScheduled(apiMonitorId, unhealthy());
    await completeScheduled(apiMonitorId, unhealthy());
    await completeScheduled(apiMonitorId, unhealthy());
    await connection.db
      .update(incidents)
      .set({ severity: 'DEGRADED' })
      .where(eq(incidents.monitorId, apiMonitorId));

    const projection = await new PublicStatusPageRepository(connection.db).findPublishedBySlug(
      slug,
    );
    expect(projection).toMatchObject({
      status: 'PARTIAL_OUTAGE',
      components: [{ status: 'PARTIAL_OUTAGE' }, { status: 'OPERATIONAL' }],
    });
  });

  it('projects manual incident updates and their component impact without exposing actor identity', async () => {
    const configured = await createPage(true);
    await completeScheduled(apiMonitorId, healthy());
    await completeScheduled(webMonitorId, healthy());
    const incidentRepository = new StatusPageIncidentRepository(connection.db);
    const incident = await incidentRepository.create(
      organizationId,
      configured.id,
      '11111111-1111-4111-8111-111111111111',
      {
        title: 'Elevated API errors',
        impact: 'DEGRADED',
        message: 'We are investigating elevated error rates.',
        componentIds: [configured.components[0]!.id],
      },
    );
    const active = await new PublicStatusPageRepository(connection.db).findPublishedBySlug(slug);
    expect(active).toMatchObject({
      status: 'PARTIAL_OUTAGE',
      components: [{ status: 'PARTIAL_OUTAGE' }, { status: 'OPERATIONAL' }],
      activeIncidents: [
        {
          id: incident.id,
          source: 'MANUAL',
          title: 'Elevated API errors',
          lifecycleState: 'INVESTIGATING',
          affectedComponents: [{ displayName: 'API' }],
          updates: [{ sequence: 1, state: 'INVESTIGATING' }],
        },
      ],
    });
    expect(JSON.stringify(active)).not.toContain('11111111-1111-4111-8111-111111111111');

    await incidentRepository.appendUpdate(
      organizationId,
      configured.id,
      incident.id,
      '11111111-1111-4111-8111-111111111111',
      { state: 'RESOLVED', message: 'Error rates have returned to normal.' },
    );
    const resolved = await new PublicStatusPageRepository(connection.db).findPublishedBySlug(slug);
    expect(resolved).toMatchObject({
      status: 'OPERATIONAL',
      activeIncidents: [],
      resolvedIncidents: [
        {
          id: incident.id,
          lifecycleState: 'RESOLVED',
          updates: [
            { sequence: 1, state: 'INVESTIGATING' },
            { sequence: 2, state: 'RESOLVED' },
          ],
        },
      ],
    });
  });

  it('publishes bounded planned-maintenance evidence only for affected components', async () => {
    const configured = await createPage(true);
    await completeScheduled(apiMonitorId, healthy());
    await completeScheduled(webMonitorId, healthy());
    const [api] = await connection.db
      .select({ projectId: monitors.projectId })
      .from(monitors)
      .where(eq(monitors.id, apiMonitorId));
    const now = new Date();
    await new MaintenanceWindowRepository(connection.db).create(
      organizationId,
      api!.projectId,
      '11111111-1111-4111-8111-111111111111',
      {
        name: 'Database maintenance',
        schedule: {
          type: 'ONE_TIME',
          startsAt: new Date(now.getTime() - 60_000).toISOString(),
          endsAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
        },
        target: { type: 'MONITORS', monitorIds: [apiMonitorId] },
        effects: {
          suppressNotifications: true,
          suppressIncidentCreation: true,
          excludeFromUptime: true,
          publishToStatusPage: true,
        },
      },
    );

    const projection = await new PublicStatusPageRepository(connection.db).findPublishedBySlug(
      slug,
    );
    expect(projection).toMatchObject({
      status: 'MAINTENANCE',
      components: [
        {
          id: configured.components[0]!.id,
          status: 'MAINTENANCE',
          maintenance: [
            {
              name: 'Database maintenance',
              startsAt: expect.any(String),
              endsAt: expect.any(String),
            },
          ],
        },
        { id: configured.components[1]!.id, status: 'OPERATIONAL' },
      ],
    });
    expect(JSON.stringify(projection)).not.toContain(apiMonitorId);
  });

  async function createPage(published: boolean) {
    return new StatusPageRepository(connection.db).create(organizationId, {
      name: 'Acme Status',
      slug,
      published,
      components: [
        { displayName: 'API', monitorId: apiMonitorId, position: 0 },
        { displayName: 'Web', monitorId: webMonitorId, position: 1 },
      ],
    });
  }

  async function completeScheduled(
    monitorId: string,
    result: AuthoritativeCheckResult,
  ): Promise<void> {
    await connection.db
      .update(monitors)
      .set({ nextCheckAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(monitors.id, monitorId));
    const [round] = await new ScheduledRoundRepository(connection.db).dispatchDue(1);
    if (!round) throw new Error('Expected a scheduled round.');
    const executions = new CheckExecutionRepository(connection.db);
    const claim = await executions.claim(round.id, 45_000);
    if (claim.state !== 'CLAIMED') throw new Error('Expected a claimed execution.');
    expect(
      await executions.complete(claim.execution.assignmentId, claim.execution.claimToken, result),
    ).toBe(true);
  }
});

function result(
  values: Partial<AuthoritativeCheckResult> &
    Pick<AuthoritativeCheckResult, 'outcome' | 'stage' | 'reason'>,
): AuthoritativeCheckResult {
  return {
    statusCode: null,
    responseTimeMs: null,
    attemptDurationMs: 10,
    redirects: [],
    assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
    checkedAt: new Date(),
    ...values,
  };
}

function healthy(): AuthoritativeCheckResult {
  return result({
    outcome: 'PASS',
    stage: 'HTTP',
    reason: 'COMPLETED',
    statusCode: 200,
    responseTimeMs: 5,
  });
}

function unhealthy(): AuthoritativeCheckResult {
  return result({
    outcome: 'FAIL',
    stage: 'HTTP',
    reason: 'UNEXPECTED_STATUS',
    statusCode: 503,
    responseTimeMs: 5,
  });
}
