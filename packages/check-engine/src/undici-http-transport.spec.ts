import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinnedLookup, UndiciPinnedHttpTransport } from './undici-http-transport.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe('createPinnedLookup', () => {
  it('returns only the validated address and ignores the requested hostname', () => {
    const callback = vi.fn();
    const lookup = createPinnedLookup([{ address: '93.184.216.34', family: 4 }]);

    lookup('attacker-controlled.example', { all: true }, callback);

    expect(callback).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
  });

  it('preserves a validated IPv6 address family', () => {
    const callback = vi.fn();
    const lookup = createPinnedLookup([
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);

    lookup('example.com', { all: false }, callback);

    expect(callback).toHaveBeenCalledWith(null, '2606:2800:220:1:248:1893:25c8:1946', 6);
  });

  it('connects to the pinned address while preserving the original HTTP authority', async () => {
    let receivedHost: string | undefined;
    let receivedPath: string | undefined;
    const server = createServer((request, reply) => {
      receivedHost = request.headers.host;
      receivedPath = request.url;
      reply.writeHead(204).end();
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP address.');

    const url = new URL(`http://original.example:${address.port}/health?ready=true`);
    const response = await new UndiciPinnedHttpTransport().request({
      target: {
        url,
        hostname: 'original.example',
        port: address.port,
        addresses: [{ address: '127.0.0.1', family: 4 }],
      },
      method: 'HEAD',
      signal: new AbortController().signal,
    });

    expect(response.statusCode).toBe(204);
    expect(receivedHost).toBe(`original.example:${address.port}`);
    expect(receivedPath).toBe('/health?ready=true');
    await response.discardBody();
  });

  it('finishes cleanup for a GET response with no body', async () => {
    const server = createServer((_request, reply) => {
      reply.writeHead(204).end();
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP address.');

    const response = await new UndiciPinnedHttpTransport().request({
      target: {
        url: new URL(`http://original.example:${address.port}/empty`),
        hostname: 'original.example',
        port: address.port,
        addresses: [{ address: '127.0.0.1', family: 4 }],
      },
      method: 'GET',
      signal: new AbortController().signal,
    });

    expect(response.statusCode).toBe(204);
    await expect(response.discardBody()).resolves.toBeUndefined();
  });

  it('exposes a redirect Location header without following it', async () => {
    const server = createServer((_request, reply) => {
      reply.writeHead(302, { location: '/next' }).end();
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP address.');

    const response = await new UndiciPinnedHttpTransport().request({
      target: {
        url: new URL(`http://original.example:${address.port}/start`),
        hostname: 'original.example',
        port: address.port,
        addresses: [{ address: '127.0.0.1', family: 4 }],
      },
      method: 'GET',
      signal: new AbortController().signal,
    });

    expect(response.statusCode).toBe(302);
    expect(response.location).toBe('/next');
    await response.discardBody();
  });
});
