import { describe, expect, it, vi } from 'vitest';
import type { ProbeLeaseReferenceV1 } from '@watchrail/contracts';
import { ProbeCoordinatorClient } from './coordinator-client.js';

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
});
