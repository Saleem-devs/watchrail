import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemIcmpPinger } from './system-icmp-pinger.js';

describe('SystemIcmpPinger', () => {
  let fixtureDirectory: string;
  let fixturePath: string;

  beforeAll(async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'watchrail-fake-ping-'));
    fixturePath = join(fixtureDirectory, 'fake-ping.mjs');
    await writeFile(
      fixturePath,
      `#!/usr/bin/env node
const target = process.argv.at(-1);
if (process.env.LC_ALL !== 'C' || process.env.LANG !== 'C') process.exit(2);
if (target === '203.0.113.1') {
  process.stdout.write('64 bytes from 203.0.113.1: icmp_seq=1 ttl=57 time=0.125 ms\\n');
  setTimeout(() => process.exit(0), 200);
} else if (target === '203.0.113.2') {
  process.stdout.write('1 packets transmitted, 0 received, 100% packet loss\\n');
  process.exit(1);
} else if (target === '203.0.113.3') {
  process.stderr.write('ping: Address family not supported by protocol\\n');
  process.exit(2);
} else if (target === '203.0.113.4') {
  process.stdout.write('From 203.0.113.254 icmp_seq=1 Destination Host Unreachable\\n');
  process.exit(1);
} else if (target === '203.0.113.5') {
  process.stdout.write('64 bytes from 203.0.113.5: icmp_seq=1 ttl=57 time=invalid ms\\n');
  process.exit(0);
} else if (target === '203.0.113.6') {
  process.stdout.write('1 packets transmitted, 1 received, 0% packet loss\\n');
  process.exit(0);
} else if (target === '203.0.113.8') {
  process.stdout.write('From 2001:db8::1 icmp_seq=1 Destination unreachable: Address unreachable\\n');
  process.exit(1);
} else {
  process.stderr.write('ping: socket: Operation not permitted\\n');
  process.exit(2);
}
`,
      'utf8',
    );
    await chmod(fixturePath, 0o755);
  });

  afterAll(async () => {
    await rm(fixtureDirectory, { recursive: true, force: true });
  });

  it('uses fractional echo RTT evidence rather than subprocess elapsed time', async () => {
    const startedAt = performance.now();
    const result = await ping('203.0.113.1');

    expect(result).toEqual({ type: 'REPLY', responseTimeMs: 0.125 });
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(150);
  });

  it.each([
    ['203.0.113.2', { type: 'NO_REPLY' }],
    ['203.0.113.3', { type: 'EXECUTION_ERROR' }],
    ['203.0.113.4', { type: 'HOST_UNREACHABLE' }],
    ['203.0.113.5', { type: 'EXECUTION_ERROR' }],
    ['203.0.113.6', { type: 'EXECUTION_ERROR' }],
    ['203.0.113.7', { type: 'ICMP_UNAVAILABLE' }],
    ['203.0.113.8', { type: 'HOST_UNREACHABLE' }],
  ] as const)(
    'classifies adapter evidence for %s without inventing RTT',
    async (address, expected) => {
      await expect(ping(address)).resolves.toEqual(expected);
    },
  );

  async function ping(address: string) {
    const pinger = new SystemIcmpPinger({
      command: process.execPath,
      commandArguments: [fixturePath],
    });
    return pinger.ping({
      host: address,
      addresses: [{ address, family: 4 }],
      signal: new AbortController().signal,
    });
  }
});
