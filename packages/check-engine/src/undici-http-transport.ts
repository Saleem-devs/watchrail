import { isIP, type LookupFunction } from 'node:net';
import { Client } from 'undici';
import type { ResolvedHttpTarget, ValidatedAddress } from './safe-http-target.js';
import type { HttpMethod } from './types.js';

export interface HttpTransportResponse {
  statusCode: number;
  discardBody(): Promise<void>;
}

export interface PinnedHttpTransport {
  request(
    this: void,
    input: {
      target: ResolvedHttpTarget;
      method: HttpMethod;
      signal: AbortSignal;
    },
  ): Promise<HttpTransportResponse>;
}

export class UndiciPinnedHttpTransport implements PinnedHttpTransport {
  async request(input: {
    target: ResolvedHttpTarget;
    method: HttpMethod;
    signal: AbortSignal;
  }): Promise<HttpTransportResponse> {
    const { target } = input;
    if (target.addresses.length === 0) {
      throw new Error('A pinned HTTP request requires at least one validated address.');
    }

    const client = new Client(target.url.origin, {
      pipelining: 0,
      autoSelectFamily: true,
      connect: {
        lookup: createPinnedLookup(target.addresses),
        ...(isIP(target.hostname) === 0 ? { servername: target.hostname } : {}),
      },
    });

    try {
      const response = await client.request({
        method: input.method,
        path: `${target.url.pathname}${target.url.search}`,
        headers: { host: target.url.host },
        signal: input.signal,
      });

      return {
        statusCode: response.statusCode,
        async discardBody() {
          response.body.on('error', () => undefined);
          response.body.destroy();
          // This client is intentionally scoped to one pinned request. A graceful
          // close can wait indefinitely after a GET response with no body (for
          // example, HTTP 204), so tear down the transport once the headers have
          // supplied all evidence required by a status-only check.
          await client.destroy();
        },
      };
    } catch (error) {
      await client.destroy();
      throw error;
    }
  }
}

export function createPinnedLookup(addresses: readonly ValidatedAddress[]): LookupFunction {
  return (_hostname: string, options, callback): void => {
    const firstAddress = addresses[0];
    if (!firstAddress) {
      callback(
        Object.assign(new Error('No validated address is available.'), { code: 'ENOTFOUND' }),
        '',
        0,
      );
      return;
    }

    if (options.all) {
      callback(null, [...addresses]);
      return;
    }

    callback(null, firstAddress.address, firstAddress.family);
  };
}
