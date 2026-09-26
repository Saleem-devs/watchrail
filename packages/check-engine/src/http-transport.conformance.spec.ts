import { afterEach, describe, expect, it } from 'vitest';
import { executeHttpCheck } from './http-check.js';
import { NodeHttpExecutor } from './node-http-executor.js';
import type { DnsResolver } from './safe-http-target.js';
import { startHttpTestServer, type HttpTestServer } from './test-support/http-test-server.js';
import { UndiciPinnedHttpTransport, type PinnedHttpTransport } from './undici-http-transport.js';

const servers: HttpTestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('HTTP transport conformance', () => {
  it.each([
    ['GET', 200],
    ['HEAD', 204],
  ] as const)('sends %s and returns final response headers', async (method, statusCode) => {
    const server = await startHttpTestServer((_request, response) => {
      response.writeHead(statusCode).end();
    });
    servers.push(server);

    const response = await requestLocal(server, method, '/health?ready=true', [
      { name: 'x-watchrail-test', value: 'delivered' },
    ]);

    expect(response.statusCode).toBe(statusCode);
    expect(server.requests).toEqual([
      expect.objectContaining({
        method,
        url: '/health?ready=true',
        headers: expect.objectContaining({
          host: `original.example:${server.port}`,
          'x-watchrail-test': 'delivered',
        }),
      }),
    ]);
    await response.discardBody();
  });

  it.each([
    ['/relative', '/relative'],
    ['https://other.example/final', 'https://other.example/final'],
  ])('exposes redirect Location %s without following it', async (location, expected) => {
    const server = await startHttpTestServer((_request, response) => {
      response.writeHead(302, { location }).end();
    });
    servers.push(server);

    const response = await requestLocal(server, 'GET', '/start');

    expect(response.statusCode).toBe(302);
    expect(response.location).toBe(expected);
    expect(server.requests).toHaveLength(1);
    await response.discardBody();
  });

  it('honors cancellation while waiting for response headers', async () => {
    const server = await startHttpTestServer(() => undefined);
    servers.push(server);
    const controller = new AbortController();
    const response = requestLocal(server, 'GET', '/slow', [], controller.signal);

    controller.abort();

    await expect(response).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects a prohibited redirect before the malicious destination receives a request', async () => {
    const maliciousServer = await startHttpTestServer((_request, response) => {
      response.writeHead(200).end('secret');
    });
    servers.push(maliciousServer);
    const firstHopServer = await startHttpTestServer((_request, response) => {
      response
        .writeHead(302, {
          location: `http://${maliciousServer.address}:${maliciousServer.port}/secret`,
        })
        .end();
    });
    servers.push(firstHopServer);

    const resolver: DnsResolver = {
      lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }] as const),
    };
    const localTransport = new UndiciPinnedHttpTransport();
    const transport: PinnedHttpTransport = {
      request: (request) =>
        localTransport.request({
          ...request,
          target: {
            ...request.target,
            addresses: [{ address: firstHopServer.address, family: 4 }],
          },
        }),
    };

    const result = await executeHttpCheck(
      {
        url: `http://public.example:${firstHopServer.port}/start`,
        method: 'GET',
        timeoutMs: 3_000,
        followRedirects: true,
      },
      { executor: new NodeHttpExecutor({ resolver, transport }) },
    );

    expect(result).toMatchObject({
      outcome: 'UNKNOWN',
      stage: 'DNS',
      reason: 'PROHIBITED_DESTINATION',
    });
    expect(firstHopServer.requests).toHaveLength(1);
    expect(maliciousServer.requests).toHaveLength(0);
  });
});

function requestLocal(
  server: HttpTestServer,
  method: 'GET' | 'HEAD',
  path: string,
  headers: readonly { name: string; value: string }[] = [],
  signal: AbortSignal = new AbortController().signal,
) {
  return new UndiciPinnedHttpTransport().request({
    target: {
      url: new URL(`http://original.example:${server.port}${path}`),
      hostname: 'original.example',
      port: server.port,
      addresses: [{ address: server.address, family: 4 }],
    },
    method,
    signal,
    headers,
  });
}
