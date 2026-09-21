import { expect, test } from '@playwright/test';
import { createDatabaseConnection } from '../../packages/db/dist/index.js';

const suffix = Date.now();
const monitorName = `Production API ${suffix}`;
const monitorUrl = `https://example.com/health?run=${suffix}`;
const organizationId = '00000000-0000-4000-8000-000000000002';

test.afterAll(async () => {
  const connection = createDatabaseConnection(
    process.env.DATABASE_URL ?? 'postgresql://watchrail:watchrail@localhost:5433/watchrail',
  );

  try {
    await connection.pool.query(
      'delete from monitors where organization_id = $1 and name = $2 and url = $3',
      [organizationId, monitorName, monitorUrl],
    );
  } finally {
    await connection.pool.end();
  }
});

test('creates a monitor and preserves it after reload', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Monitor name').fill(monitorName);
  await page.getByLabel('HTTP(S) URL').fill(monitorUrl);
  await page.getByRole('button', { name: 'Create monitor' }).click();

  await expect(page.getByRole('heading', { name: monitorName })).toBeVisible();
  await expect(page.getByText('Awaiting first check').last()).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: monitorName })).toBeVisible();
});
