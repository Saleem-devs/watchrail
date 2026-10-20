import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { URL } from 'node:url';

const apiDirectory = new URL('../apps/api/', import.meta.url);
const testFiles = readdirSync(new URL('test/', apiDirectory))
  .filter((file) => file.endsWith('.integration.spec.ts'))
  .sort();

for (const testFile of testFiles) {
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', `test/${testFile}`], {
    cwd: apiDirectory,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
