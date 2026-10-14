import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { enrollProbeAgent, ProbeCoordinatorClient } from './coordinator-client.js';
import { loadProbeAgentConfig } from './config.js';
import { ProbeAgentRuntime } from './runtime.js';

const config = loadProbeAgentConfig();
const credential = config.credential ?? (await credentialFromEnrollment(config));
const runtime = new ProbeAgentRuntime(
  new ProbeCoordinatorClient(config.coordinatorUrl, credential, fetch, config.requestTimeoutMs),
  config,
);

process.once('SIGINT', () => runtime.stop());
process.once('SIGTERM', () => runtime.stop());

await runtime.run();

async function credentialFromEnrollment(agentConfig: typeof config): Promise<string> {
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
    fetch,
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
