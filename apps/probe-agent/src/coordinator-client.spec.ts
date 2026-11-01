import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { ProbeLeaseReferenceV1 } from '@watchrail/contracts';
import {
  enrollProbeAgent,
  ProbeCoordinatorClient,
  ProbeCoordinatorError,
} from './coordinator-client.js';

const lease: ProbeLeaseReferenceV1 = {
  contractVersion: 1,
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  locationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  assignmentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  attemptId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  attemptNumber: 1,
  claimToken: 'c'.repeat(43),
  configurationVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  configurationVersionNumber: 1,
  executionPolicyVersion: 'probe-execution-v1',
  requiredEngineVersion: 'watchrail-http-v1',
  leaseExpiresAt: '2026-10-14T08:00:00.000Z',
};

describe('ProbeCoordinatorClient', () => {
  it('reuses the exact serialized result body across submission retries', async () => {
    const bodies: string[] = [];
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a serialized request body.');
      bodies.push(init.body);
      return Promise.resolve(
        new Response(JSON.stringify({ data: { state: 'ACCEPTED', duplicate: false } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    const client = new ProbeCoordinatorClient(
      'https://coordinator.example',
      'm'.repeat(43),
      fetcher,
    );
    const serialized = client.serializeSubmission(lease, 'watchrail-http-v1', {
      outcome: 'PASS',
      stage: 'HTTP',
      reason: 'COMPLETED',
      statusCode: 200,
      responseTimeMs: 10,
      attemptDurationMs: 12,
      redirects: [],
      checkedAt: new Date('2026-10-14T08:00:00.000Z'),
      assertionEvaluation: { contractVersion: 1, outcome: 'PASS', diagnostics: [] },
    });
    await client.submitSerialized(lease, serialized);
    await client.submitSerialized(lease, serialized);
    expect(bodies).toEqual([serialized, serialized]);
    expect(serialized).not.toContain(lease.claimToken);
  });

  it('rejects redirects without forwarding claim or enrollment secrets', async () => {
    let targetRequests = 0;
    const target = createServer((_request, response) => {
      targetRequests += 1;
      response.writeHead(200).end('{}');
    });
    await listen(target);
    const targetUrl = serverUrl(target);
    const redirector = createServer((_request, response) => {
      response.writeHead(307, { location: targetUrl }).end();
    });
    await listen(redirector);
    try {
      const client = new ProbeCoordinatorClient(serverUrl(redirector), 'm'.repeat(43));
      await expect(client.configuration(lease)).rejects.toMatchObject({
        kind: 'TRANSIENT',
      });
      await expect(
        enrollProbeAgent(serverUrl(redirector), {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          token: 'e'.repeat(43),
        }),
      ).rejects.toMatchObject({ kind: 'TRANSIENT' });
      expect(targetRequests).toBe(0);
    } finally {
      await Promise.all([close(redirector), close(target)]);
    }
  });

  it('bounds a coordinator request that never resolves', async () => {
    const fetcher = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Timed out.', 'TimeoutError')),
            { once: true },
          );
        }),
    );
    const client = new ProbeCoordinatorClient(
      'https://coordinator.example',
      'm'.repeat(43),
      fetcher,
      10,
    );
    await expect(client.claim('watchrail-http-v1')).rejects.toBeInstanceOf(ProbeCoordinatorError);
  });

  it('honors coordinator backpressure without abandoning an idempotent request', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '1' } }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      const client = new ProbeCoordinatorClient(
        'https://coordinator.example',
        'm'.repeat(43),
        fetcher,
      );

      const claim = client.claim('watchrail-dns-v1');
      await vi.runAllTimersAsync();

      await expect(claim).resolves.toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function serverUrl(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
