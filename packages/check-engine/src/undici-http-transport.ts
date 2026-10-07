import { isIP, type LookupFunction } from 'node:net';
import type { SecureContextOptions } from 'node:tls';
import { Client } from 'undici';
import type { ResolvedHttpTarget, ValidatedAddress } from './safe-http-target.js';
import type { HttpResponseHeader } from './types.js';
import type { HttpRequestHeader } from './types.js';

export interface HttpTransportResponse {
  statusCode: number;
  location: string | null;
  headers: readonly HttpResponseHeader[];
  captureEncodedBody(limitBytes: number): Promise<Uint8Array>;
  discardBody(): Promise<void>;
}

export class EncodedBodyTooLargeError extends Error {
  constructor() {
    super('The encoded HTTP response body exceeded the capture limit.');
    this.name = 'EncodedBodyTooLargeError';
  }
}

export class ResponseBodyReadError extends Error {
  constructor(options?: ErrorOptions) {
    super('The HTTP response body could not be read.', options);
    this.name = 'ResponseBodyReadError';
  }
}

export interface PinnedHttpTransport {
  request(
    this: void,
    input: {
      target: ResolvedHttpTarget;
      method: 'GET' | 'HEAD' | 'POST';
      signal: AbortSignal;
      headers?: readonly HttpRequestHeader[];
      body?: Uint8Array;
    },
  ): Promise<HttpTransportResponse>;
}

export interface UndiciPinnedHttpTransportOptions {
  /** Additional trust roots, intended for deterministic test infrastructure. */
  ca?: SecureContextOptions['ca'];
}

export class UndiciPinnedHttpTransport implements PinnedHttpTransport {
  private readonly ca: SecureContextOptions['ca'] | undefined;

  constructor(options: UndiciPinnedHttpTransportOptions = {}) {
    this.ca = options.ca;
  }

  async request(input: {
    target: ResolvedHttpTarget;
    method: 'GET' | 'HEAD' | 'POST';
    signal: AbortSignal;
    headers?: readonly HttpRequestHeader[];
    body?: Uint8Array;
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
        ...(this.ca === undefined ? {} : { ca: this.ca }),
      },
    });

    try {
      const response = await client.request({
        method: input.method,
        path: `${target.url.pathname}${target.url.search}`,
        headers: {
          ...Object.fromEntries((input.headers ?? []).map((header) => [header.name, header.value])),
          host: target.url.host,
        },
        ...(input.body === undefined ? {} : { body: input.body }),
        signal: input.signal,
      });

      let consumed = false;
      const consume = async <T>(operation: () => Promise<T>): Promise<T> => {
        if (consumed) throw new Error('The HTTP response body has already been consumed.');
        consumed = true;
        try {
          return await operation();
        } finally {
          await client.destroy();
        }
      };

      return {
        statusCode: response.statusCode,
        location: headerValue(response.headers.location),
        headers: normalizeResponseHeaders(response.headers),
        captureEncodedBody(limitBytes) {
          return consume(async () => {
            const chunks: Uint8Array[] = [];
            let length = 0;
            const iterator = response.body[Symbol.asyncIterator]();
            while (true) {
              let next: IteratorResult<unknown>;
              try {
                next = await iterator.next();
              } catch (error) {
                if (input.signal.aborted) throw error;
                throw new ResponseBodyReadError({ cause: error });
              }
              if (next.done === true) break;
              const chunk = next.value;
              const bytes = bodyChunk(chunk);
              length += bytes.byteLength;
              if (length > limitBytes) {
                response.body.destroy();
                throw new EncodedBodyTooLargeError();
              }
              chunks.push(bytes);
            }
            return Buffer.concat(chunks, length);
          });
        },
        async discardBody() {
          await consume(() => {
            response.body.on('error', () => undefined);
            response.body.destroy();
            return Promise.resolve();
          });
        },
      };
    } catch (error) {
      await client.destroy();
      throw error;
    }
  }
}

function bodyChunk(value: unknown): Uint8Array {
  if (typeof value === 'string') return Buffer.from(value);
  if (value instanceof Uint8Array) return value;
  throw new TypeError('HTTP response body emitted an unsupported chunk.');
}

export function normalizeResponseHeaders(
  headers: Record<string, string | string[] | undefined>,
): HttpResponseHeader[] {
  return Object.entries(headers).flatMap(([name, value]) => {
    if (value === undefined) return [];
    return [{ name: name.toLowerCase(), values: Array.isArray(value) ? [...value] : [value] }];
  });
}

function headerValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
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
