import {
  CheckExecutionRepository,
  MonitorRepository,
  StatusPageRepository,
  createDatabaseConnection,
} from '../packages/db/dist/index.js';
import {
  EMPTY_ASSERTION_CONFIGURATION,
  EMPTY_ASSERTION_EVALUATION,
  createMonitor,
} from '../packages/domain/dist/index.js';

const ORGANIZATION_ID = 'ac000000-0000-4000-8000-000000000009';
const PRIVATE_HEADER_VALUE = 'WATCHRAIL_PRIVATE_HEADER_SECRET';
const PRIVATE_URL_VALUE = 'WATCHRAIL_PRIVATE_URL_SECRET';
const PRIVATE_MONITOR_VALUE = 'WATCHRAIL_PRIVATE_MONITOR_NAME';

const FIXTURES = {
  operational: {
    monitorId: 'ac000000-0000-4000-8000-000000000101',
    checks: ['PASS'],
  },
  impaired: {
    monitorId: 'ac000000-0000-4000-8000-000000000102',
    checks: ['FAIL'],
  },
  partialDown: {
    monitorId: 'ac000000-0000-4000-8000-000000000103',
    checks: ['FAIL', 'FAIL', 'FAIL'],
  },
  partialUp: {
    monitorId: 'ac000000-0000-4000-8000-000000000104',
    checks: ['PASS'],
  },
  majorOne: {
    monitorId: 'ac000000-0000-4000-8000-000000000105',
    checks: ['FAIL', 'FAIL', 'FAIL'],
  },
  majorTwo: {
    monitorId: 'ac000000-0000-4000-8000-000000000106',
    checks: ['FAIL', 'FAIL', 'FAIL'],
  },
  recovered: {
    monitorId: 'ac000000-0000-4000-8000-000000000107',
    checks: ['FAIL', 'FAIL', 'FAIL', 'PASS'],
  },
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');

const connection = createDatabaseConnection(databaseUrl);
const monitors = new MonitorRepository(connection.db);
const executions = new CheckExecutionRepository(connection.db);
const pages = new StatusPageRepository(connection.db);

try {
  await clean();
  if (process.argv.includes('--clean')) {
    console.log(`Removed Slice 9 acceptance fixtures for ${ORGANIZATION_ID}.`);
    process.exitCode = 0;
  } else {
    await seed();
  }
} finally {
  await connection.pool.end();
}

async function clean() {
  const client = await connection.pool.connect();
  try {
    await client.query('begin');
    await client.query('delete from status_pages where organization_id = $1', [ORGANIZATION_ID]);
    await client.query('delete from notification_events where organization_id = $1', [
      ORGANIZATION_ID,
    ]);
    await client.query('delete from incidents where organization_id = $1', [ORGANIZATION_ID]);
    await client.query('delete from check_rounds where organization_id = $1', [ORGANIZATION_ID]);
    await client.query('delete from monitors where organization_id = $1', [ORGANIZATION_ID]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function seed() {
  const entries = Object.entries(FIXTURES);

  for (const [key, fixture] of entries) {
    const monitor = createMonitor({
      name: `${PRIVATE_MONITOR_VALUE}_${key}`,
      url: `https://example.com/${PRIVATE_URL_VALUE}/${key}`,
    });

    await monitors.create(
      ORGANIZATION_ID,
      fixture.monitorId,
      monitor,
      [
        {
          name: 'x-watchrail-acceptance-secret',
          sensitive: false,
          value: PRIVATE_HEADER_VALUE,
        },
      ],
      EMPTY_ASSERTION_CONFIGURATION,
    );
  }

  let checkedAt = new Date(Date.now() - 60_000);
  for (const fixture of Object.values(FIXTURES)) {
    for (const outcome of fixture.checks) {
      checkedAt = new Date(checkedAt.getTime() + 1_000);
      await completeScheduledCheck(fixture.monitorId, outcome, checkedAt);
    }
  }

  await pages.create(ORGANIZATION_ID, {
    name: 'Watchrail Operational',
    slug: 'acceptance-operational',
    published: true,
    components: [component(FIXTURES.operational.monitorId, 'API', 0)],
  });
  await pages.create(ORGANIZATION_ID, {
    name: 'Watchrail Monitoring Impaired',
    slug: 'acceptance-impaired',
    published: true,
    components: [component(FIXTURES.impaired.monitorId, 'API', 0)],
  });
  await pages.create(ORGANIZATION_ID, {
    name: 'Watchrail Partial Outage',
    slug: 'acceptance-partial',
    published: true,
    components: [
      component(FIXTURES.partialDown.monitorId, 'API', 0),
      component(FIXTURES.partialUp.monitorId, 'Dashboard', 1),
    ],
  });
  await pages.create(ORGANIZATION_ID, {
    name: 'Watchrail Major Outage',
    slug: 'acceptance-major',
    published: true,
    components: [
      component(FIXTURES.majorOne.monitorId, 'API', 0),
      component(FIXTURES.majorTwo.monitorId, 'Dashboard', 1),
    ],
  });
  await pages.create(ORGANIZATION_ID, {
    name: 'Watchrail Recovered',
    slug: 'acceptance-recovered',
    published: true,
    components: [component(FIXTURES.recovered.monitorId, 'API', 0)],
  });
  await pages.create(ORGANIZATION_ID, {
    name: 'Watchrail Empty',
    slug: 'acceptance-empty',
    published: true,
    components: [],
  });
  await pages.create(ORGANIZATION_ID, {
    name: 'Watchrail Unpublished',
    slug: 'acceptance-unpublished',
    published: false,
    components: [component(FIXTURES.operational.monitorId, 'API', 0)],
  });

  console.log('Seeded deterministic Slice 9 acceptance fixtures.');
  console.log(`Organization: ${ORGANIZATION_ID}`);
  console.log('Public slugs:');
  for (const slug of [
    'acceptance-operational',
    'acceptance-impaired',
    'acceptance-partial',
    'acceptance-major',
    'acceptance-recovered',
    'acceptance-empty',
  ]) {
    console.log(`  API  http://localhost:4000/api/public/status-pages/${slug}`);
    console.log(`  Web  http://localhost:3010/status/${slug}`);
  }
  console.log('Expected 404 slugs: acceptance-unpublished, missing-page');
  console.log(
    `Leak sentinels: ${PRIVATE_HEADER_VALUE}, ${PRIVATE_URL_VALUE}, ${PRIVATE_MONITOR_VALUE}`,
  );
}

function component(monitorId, displayName, position) {
  return { monitorId, displayName, position };
}

async function completeScheduledCheck(monitorId, outcome, checkedAt) {
  const roundResult = await connection.pool.query(
    `insert into check_rounds (
       organization_id,
       monitor_id,
       monitor_configuration_version_id,
       trigger,
       status
     )
     select $1, $2, configuration.id, 'SCHEDULED', 'PENDING'
       from monitor_configuration_versions configuration
      where configuration.organization_id = $1
        and configuration.monitor_id = $2
      order by configuration.version_number desc
      limit 1
     returning *`,
    [ORGANIZATION_ID, monitorId],
  );
  const round = roundResult.rows[0];
  if (!round) throw new Error(`Could not create a scheduled round for ${monitorId}.`);

  await connection.pool.query(
    `insert into check_execution_assignments (organization_id, round_id, location, status)
     values ($1, $2, 'local', 'PENDING')`,
    [ORGANIZATION_ID, round.id],
  );

  const claim = await executions.claim(round.id, 45_000);
  if (claim.state !== 'CLAIMED') {
    throw new Error(`Expected to claim round ${round.id}; received ${claim.state}.`);
  }

  const passed = outcome === 'PASS';
  const completed = await executions.complete(
    claim.execution.assignmentId,
    claim.execution.claimToken,
    {
      outcome,
      stage: 'HTTP',
      reason: passed ? 'COMPLETED' : 'UNEXPECTED_STATUS',
      statusCode: passed ? 200 : 503,
      responseTimeMs: 42,
      attemptDurationMs: 45,
      redirects: [],
      assertionEvaluation: EMPTY_ASSERTION_EVALUATION,
      checkedAt,
    },
  );

  if (!completed) throw new Error(`Could not complete scheduled round ${round.id}.`);
}
