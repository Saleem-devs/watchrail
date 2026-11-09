import { spawn } from 'node:child_process';
import type { IcmpPinger, IcmpPingResult } from './icmp-types.js';

const MAX_DIAGNOSTIC_BYTES = 4_096;
const RTT_PATTERN = /\btime=([0-9]+(?:\.[0-9]+)?)\s*ms\b/iu;
const EXPLICIT_UNREACHABLE_PATTERN =
  /\b(?:destination(?:\s+(?:host|net|network|port|protocol))?\s+unreachable|no route to host)\b/iu;
const CAPABILITY_ERROR_PATTERN =
  /\b(?:operation not permitted|permission denied|socket type not supported)\b/iu;

export interface SystemIcmpPingerOptions {
  command?: string;
  commandArguments?: readonly string[];
}

export class SystemIcmpPinger implements IcmpPinger {
  private readonly command: string;
  private readonly commandArguments: readonly string[];

  constructor(options: SystemIcmpPingerOptions = {}) {
    this.command = options.command ?? 'ping';
    this.commandArguments = options.commandArguments ?? [];
  }

  async ping(input: Parameters<IcmpPinger['ping']>[0]): Promise<IcmpPingResult> {
    let observedUnreachable = false;
    for (const address of input.addresses) {
      const result = await pingAddress(
        address.address,
        input.signal,
        this.command,
        this.commandArguments,
      );
      if (
        result.type === 'REPLY' ||
        result.type === 'ICMP_UNAVAILABLE' ||
        result.type === 'EXECUTION_ERROR'
      ) {
        return result;
      }
      if (result.type === 'HOST_UNREACHABLE') observedUnreachable = true;
    }
    return observedUnreachable ? { type: 'HOST_UNREACHABLE' } : { type: 'NO_REPLY' };
  }
}

async function pingAddress(
  address: string,
  signal: AbortSignal,
  command: string,
  commandArguments: readonly string[],
): Promise<IcmpPingResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...commandArguments, '-n', '-c', '1', address], {
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    });
    let output = '';
    let settled = false;

    const capture = (chunk: string) => {
      if (output.length < MAX_DIAGNOSTIC_BYTES) {
        output += chunk.slice(0, MAX_DIAGNOSTIC_BYTES - output.length);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (error.name === 'AbortError') reject(error);
      else if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM') {
        resolve({ type: 'ICMP_UNAVAILABLE' });
      } else {
        resolve({ type: 'EXECUTION_ERROR' });
      }
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (CAPABILITY_ERROR_PATTERN.test(output)) {
        resolve({ type: 'ICMP_UNAVAILABLE' });
        return;
      }
      if (code === 0) {
        const responseTimeMs = parseResponseTime(output);
        resolve(
          responseTimeMs === null ? { type: 'EXECUTION_ERROR' } : { type: 'REPLY', responseTimeMs },
        );
        return;
      }
      if (EXPLICIT_UNREACHABLE_PATTERN.test(output)) {
        resolve({ type: 'HOST_UNREACHABLE' });
        return;
      }
      resolve(code === 1 ? { type: 'NO_REPLY' } : { type: 'EXECUTION_ERROR' });
    });
  });
}

function parseResponseTime(output: string): number | null {
  const match = RTT_PATTERN.exec(output);
  if (!match) return null;
  const responseTimeMs = Number(match[1]);
  return Number.isFinite(responseTimeMs) && responseTimeMs >= 0 ? responseTimeMs : null;
}
