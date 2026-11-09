import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { IcmpPinger, IcmpPingResult } from './icmp-types.js';

const MAX_DIAGNOSTIC_BYTES = 4_096;

export class SystemIcmpPinger implements IcmpPinger {
  async ping(input: Parameters<IcmpPinger['ping']>[0]): Promise<IcmpPingResult> {
    for (const address of input.addresses) {
      const result = await pingAddress(address.address, input.signal);
      if (result.type === 'REPLY' || result.type === 'ICMP_UNAVAILABLE') return result;
    }
    return { type: 'HOST_UNREACHABLE' };
  }
}

async function pingAddress(address: string, signal: AbortSignal): Promise<IcmpPingResult> {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn('ping', ['-n', '-c', '1', address], {
      signal,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let diagnostic = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (diagnostic.length < MAX_DIAGNOSTIC_BYTES) {
        diagnostic += chunk.slice(0, MAX_DIAGNOSTIC_BYTES - diagnostic.length);
      }
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.name === 'AbortError') reject(error);
      else if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM') {
        resolve({ type: 'ICMP_UNAVAILABLE' });
      } else reject(error);
    });
    child.once('close', (code) => {
      if (code === 0) {
        resolve({
          type: 'REPLY',
          responseTimeMs: Math.max(0, Math.round(performance.now() - startedAt)),
        });
        return;
      }
      if (/operation not permitted|permission denied|not found/iu.test(diagnostic)) {
        resolve({ type: 'ICMP_UNAVAILABLE' });
        return;
      }
      resolve({ type: 'HOST_UNREACHABLE' });
    });
  });
}
