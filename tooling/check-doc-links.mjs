import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const files = execFileSync('rg', ['--files', '-g', '*.md'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean);
const failures = [];

for (const file of files) {
  const markdown = readFileSync(file, 'utf8');

  for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1]?.split('#')[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;

    const absoluteTarget = resolve(dirname(file), decodeURIComponent(target));
    if (!existsSync(absoluteTarget)) failures.push(`${file} -> ${target}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`All local Markdown links resolve (${files.length} files checked).`);
}
