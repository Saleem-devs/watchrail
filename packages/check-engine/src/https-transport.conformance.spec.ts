import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeHttpCheck } from './http-check.js';
import { NodeHttpExecutor } from './node-http-executor.js';
import type { DnsResolver, ValidatedAddress } from './safe-http-target.js';
import {
  startHttpTestServer,
  startHttpsTestServer,
  type HttpTestServer,
} from './test-support/http-test-server.js';
import { UndiciPinnedHttpTransport, type PinnedHttpTransport } from './undici-http-transport.js';

const TEST_CERTIFICATE = readFileSync(
  new URL('./test-support/fixtures/original-example.cert.pem', import.meta.url),
  'utf8',
);
const TEST_PRIVATE_KEY = readFileSync(
  new URL('./test-support/fixtures/original-example.key.pem', import.meta.url),
  'utf8',
);
const servers: HttpTestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('HTTPS transport conformance', () => {
  it('verifies a locally trusted certificate and preserves the original hostname', async () => {
    const server = await startTlsServer();

    const result = await checkHttpsTarget({
      server,
      hostname: 'original.example',
      transport: new UndiciPinnedHttpTransport({ ca: TEST_CERTIFICATE }),
    });

    expect(result).toMatchObject({
      outcome: 'PASS',
      stage: 'HTTP',
      reason: 'COMPLETED',
      statusCode: 200,
    });
    expect(server.requests[0]?.headers.host).toBe(`original.example:${server.port}`);
  });

  it('classifies an untrusted certificate without exposing the OpenSSL error', async () => {
    const server = await startTlsServer();

    const result = await checkHttpsTarget({
      server,
      hostname: 'original.example',
      transport: new UndiciPinnedHttpTransport(),
    });

    expect(result).toMatchObject({
      outcome: 'FAIL',
      stage: 'TLS',
      reason: 'CERTIFICATE_UNTRUSTED',
      statusCode: null,
    });
  });

  it('classifies a certificate hostname mismatch', async () => {
    const server = await startTlsServer();

    const result = await checkHttpsTarget({
      server,
      hostname: 'wrong.example',
      transport: new UndiciPinnedHttpTransport({ ca: TEST_CERTIFICATE }),
    });

    expect(result).toMatchObject({
      outcome: 'FAIL',
      stage: 'TLS',
      reason: 'CERTIFICATE_HOSTNAME_MISMATCH',
      statusCode: null,
    });
  });

  it('classifies a recognizable TLS protocol failure as a failed handshake', async () => {
    const server = await startHttpTestServer((_request, response) => {
      response.writeHead(200).end();
    });
    servers.push(server);

    const result = await checkHttpsTarget({
      server,
      hostname: 'original.example',
      transport: new UndiciPinnedHttpTransport({ ca: TEST_CERTIFICATE }),
    });

    expect(result).toMatchObject({
      outcome: 'FAIL',
      stage: 'TLS',
      reason: 'TLS_HANDSHAKE_FAILED',
      statusCode: null,
    });
  });
});

async function startTlsServer(): Promise<HttpTestServer> {
  const server = await startHttpsTestServer(
    { cert: TEST_CERTIFICATE, key: TEST_PRIVATE_KEY },
    (_request, response) => {
      response.writeHead(200).end();
    },
  );
  servers.push(server);
  return server;
}

async function checkHttpsTarget(input: {
  server: HttpTestServer;
  hostname: string;
  transport: PinnedHttpTransport;
}) {
  const resolver: DnsResolver = {
    lookup: vi.fn(() => Promise.resolve([{ address: '93.184.216.34', family: 4 }] as const)),
  };
  const localAddress: ValidatedAddress = { address: input.server.address, family: 4 };
  const transport: PinnedHttpTransport = {
    request: (request) =>
      input.transport.request({
        ...request,
        target: { ...request.target, addresses: [localAddress] },
      }),
  };
  const executor = new NodeHttpExecutor({ resolver, transport });

  return executeHttpCheck(
    {
      url: `https://${input.hostname}:${input.server.port}/health`,
      method: 'GET',
      timeoutMs: 3_000,
      followRedirects: true,
    },
    { executor },
  );
}
