import { connect } from 'node:net';
import type { TcpConnectInput, TcpConnector, TcpConnectResult } from './tcp-types.js';

export class NodeTcpConnector implements TcpConnector {
  constructor(
    private readonly dependencies: {
      monotonicNow?: () => number;
      connectAddress?: typeof connectAddress;
    } = {},
  ) {}

  async connect(input: TcpConnectInput): Promise<TcpConnectResult> {
    const now = this.dependencies.monotonicNow ?? (() => performance.now());
    const attempt = this.dependencies.connectAddress ?? connectAddress;
    const startedAt = now();
    let unreachable = false;
    for (const address of input.addresses) {
      const result = await attempt(input, address.address, address.family);
      if (result.type === 'CONNECTED') {
        return {
          type: 'CONNECTED',
          connectionTimeMs: Math.max(0, Math.round(now() - startedAt)),
        };
      }
      if (result.type === 'HOST_UNREACHABLE') unreachable = true;
    }
    return { type: unreachable ? 'HOST_UNREACHABLE' : 'CONNECTION_REFUSED' };
  }
}

function connectAddress(
  input: TcpConnectInput,
  address: string,
  family: 4 | 6,
): Promise<TcpConnectResult> {
  if (input.signal.aborted) return Promise.reject(abortReason(input.signal));
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const socket = connect({ host: address, port: input.port, family });
    const cleanup = () => {
      input.signal.removeEventListener('abort', onAbort);
      socket.removeAllListeners();
      socket.destroy();
    };
    const onAbort = () => {
      cleanup();
      reject(abortReason(input.signal));
    };
    input.signal.addEventListener('abort', onAbort, { once: true });
    socket.once('connect', () => {
      const connectionTimeMs = Math.max(0, Math.round(performance.now() - startedAt));
      cleanup();
      resolve({ type: 'CONNECTED', connectionTimeMs });
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      if (error.code === 'ECONNREFUSED') {
        resolve({ type: 'CONNECTION_REFUSED' });
      } else if (error.code === 'EHOSTUNREACH' || error.code === 'ENETUNREACH') {
        resolve({ type: 'HOST_UNREACHABLE' });
      } else reject(error);
    });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}
