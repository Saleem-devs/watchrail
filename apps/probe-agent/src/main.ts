import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { HttpExecutor } from '@watchrail/check-engine';
import { enrollProbeAgent, ProbeCoordinatorClient } from './coordinator-client.js';
import { loadProbeAgentConfig } from './config.js';
import { ProbeAgentRuntime } from './runtime.js';

export async function runProbeAgent(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: { fetcher?: typeof fetch; executor?: HttpExecutor } = {},
): Promise<void> {
  const config = loadProbeAgentConfig(environment);
  const fetcher = dependencies.fetcher ?? fetch;
  const credential = config.credential ?? (await credentialFromEnrollment(config, fetcher));
  const runtime = new ProbeAgentRuntime(
    new ProbeCoordinatorClient(config.coordinatorUrl, credential, fetcher, config.requestTimeoutMs),
    config,
    dependencies.executor,
  );
  const stop = () => runtime.stop();

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runtime.run();
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runProbeAgent();
}

async function credentialFromEnrollment(
  agentConfig: ReturnType<typeof loadProbeAgentConfig>,
  fetcher: typeof fetch,
): Promise<string> {
  if (!agentConfig.enrollment || !agentConfig.credentialFile) {
    throw new Error('Probe credential source is unavailable.');
  }
  try {
    const existing = (await readFile(agentConfig.credentialFile, 'utf8')).trim();
    if (/^[A-Za-z0-9_-]{43}$/u.test(existing)) return existing;
    throw new Error('Persisted probe machine credential is invalid.');
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const enrolled = await enrollProbeAgent(
    agentConfig.coordinatorUrl,
    agentConfig.enrollment,
    fetcher,
    agentConfig.requestTimeoutMs,
  );
  await writeFile(agentConfig.credentialFile, `${enrolled}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return enrolled;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
