import { ASSERTION_LIMITS, AssertionInputError, type TextBodyAssertion } from '@watchrail/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { combineAssertionEvaluations } from './assertion-evaluation.js';
import { executeHttpCheck } from './http-check.js';
import { NodeHttpExecutor } from './node-http-executor.js';
import type { DnsResolver } from './safe-http-target.js';
import { startHttpTestServer, type HttpTestServer } from './test-support/http-test-server.js';
import {
  evaluateTextBodyAssertions,
  notEvaluateTextBodyAssertions,
} from './text-body-assertions.js';
import type { HttpExecutionResult, HttpExecutor } from './types.js';
import { UndiciPinnedHttpTransport } from './undici-http-transport.js';

const target = (value: string, sensitive = false) => ({ value, sensitive });
const servers: HttpTestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('evaluateTextBodyAssertions', () => {
  it.each([
    ['equals', 'ready', 'ready', 'PASS'],
    ['equals', 'ready', 'Ready', 'FAIL'],
    ['not_equals', 'ready', 'other', 'PASS'],
    ['not_equals', 'ready', 'ready', 'FAIL'],
    ['contains', 'watchrail', 'watchrail is ready', 'PASS'],
    ['contains', 'Watchrail', 'watchrail is ready', 'FAIL'],
    ['not_contains', 'error', 'watchrail is ready', 'PASS'],
    ['not_contains', 'ready', 'watchrail is ready', 'FAIL'],
    ['equals', '', '', 'PASS'],
    ['contains', '', '', 'PASS'],
  ] as const)('evaluates %s literally as %s', (operator, expected, body, outcome) => {
    const evaluation = evaluateTextBodyAssertions([{ operator, target: target(expected) }], {
      state: 'CAPTURED',
      text: body,
    });

    expect(evaluation).toMatchObject({
      contractVersion: 1,
      outcome,
      diagnostics: [
        {
          index: 0,
          source: 'TEXT_BODY',
          subject: null,
          operator,
          outcome,
          reason: outcome === 'PASS' ? 'MATCHED' : 'TEXT_BODY_MISMATCH',
        },
      ],
    });
  });

  it('evaluates every assertion and combines them with AND semantics', () => {
    const evaluation = evaluateTextBodyAssertions(
      [
        { operator: 'contains', target: target('watchrail') },
        { operator: 'equals', target: target('wrong', true) },
        { operator: 'not_contains', target: target('secret', true) },
      ],
      { state: 'CAPTURED', text: 'watchrail is ready' },
    );

    expect(evaluation.outcome).toBe('FAIL');
    expect(evaluation.diagnostics.map((diagnostic) => diagnostic.outcome)).toEqual([
      'PASS',
      'FAIL',
      'PASS',
    ]);
    expect(JSON.stringify(evaluation)).not.toContain('wrong');
    expect(JSON.stringify(evaluation)).not.toContain('secret');
    expect(JSON.stringify(evaluation)).not.toContain('watchrail is ready');
  });

  it.each([
    'BODY_TOO_LARGE',
    'UNSUPPORTED_CONTENT_ENCODING',
    'UNSUPPORTED_CHARSET',
    'BODY_READ_FAILED',
  ] as const)('maps unavailable body reason %s without retaining values', (reason) => {
    const evaluation = evaluateTextBodyAssertions(
      [{ operator: 'equals', target: target('WATCHRAIL_EXPECTED_SECRET', true) }],
      { state: 'UNAVAILABLE', reason },
    );

    expect(evaluation).toMatchObject({
      outcome: 'NOT_EVALUATED',
      diagnostics: [{ outcome: 'NOT_EVALUATED', reason }],
    });
    expect(JSON.stringify(evaluation)).not.toContain('WATCHRAIL_EXPECTED_SECRET');
  });

  it('defensively treats NOT_REQUESTED as unavailable', () => {
    expect(
      evaluateTextBodyAssertions([{ operator: 'contains', target: target('ready') }], {
        state: 'NOT_REQUESTED',
      }),
    ).toMatchObject({
      outcome: 'NOT_EVALUATED',
      diagnostics: [{ reason: 'RESPONSE_UNAVAILABLE' }],
    });
  });

  it('defensively rejects more than the domain assertion limit', () => {
    const assertions = Array.from(
      { length: ASSERTION_LIMITS.maxAssertions + 1 },
      (): TextBodyAssertion => ({ operator: 'contains', target: target('ready') }),
    );
    expect(() => evaluateTextBodyAssertions(assertions, { state: 'CAPTURED', text: '' })).toThrow(
      `Cannot evaluate more than ${ASSERTION_LIMITS.maxAssertions} assertions.`,
    );
    expect(() => notEvaluateTextBodyAssertions(assertions)).toThrow(
      `Cannot evaluate more than ${ASSERTION_LIMITS.maxAssertions} assertions.`,
    );
  });
});

describe('assertion evaluation composition', () => {
  it.each([
    ['PASS', 'PASS', 'PASS'],
    ['PASS', 'FAIL', 'FAIL'],
    ['FAIL', 'PASS', 'FAIL'],
    ['PASS', 'NOT_EVALUATED', 'NOT_EVALUATED'],
    ['FAIL', 'NOT_EVALUATED', 'FAIL'],
  ] as const)('combines %s and %s as %s', (first, second, expected) => {
    const evaluation = combineAssertionEvaluations(
      evaluationWithOutcome(first, 0),
      evaluationWithOutcome(second, 1),
    );
    expect(evaluation.outcome).toBe(expected);
  });
});

describe('executeHttpCheck text-body assertions', () => {
  it.each([
    [false, []],
    [true, [{ operator: 'contains', target: target('ready') }]],
  ] as const)(
    'derives captureResponseBody=%s from configured assertions',
    async (capture, assertions) => {
      const execute = vi.fn<HttpExecutor['execute']>((input) =>
        Promise.resolve(response(input.captureResponseBody === true ? 'ready' : null)),
      );

      await executeHttpCheck(baseInput({ textBodyAssertions: assertions }), {
        executor: { execute },
      });

      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ captureResponseBody: capture }),
      );
    },
  );

  it('rejects HEAD body assertions before invoking the executor', async () => {
    const execute = vi.fn<HttpExecutor['execute']>();
    await expect(
      executeHttpCheck(
        baseInput({
          method: 'HEAD',
          textBodyAssertions: [{ operator: 'contains', target: target('ready') }],
        }),
        { executor: { execute } },
      ),
    ).rejects.toBeInstanceOf(AssertionInputError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('enforces the 32-assertion limit globally before transport', async () => {
    const execute = vi.fn<HttpExecutor['execute']>();
    const headers = Array.from({ length: 20 }, () => ({
      name: 'x-state',
      operator: 'exists' as const,
    }));
    const textBody = Array.from({ length: 20 }, () => ({
      operator: 'contains' as const,
      target: target('ready'),
    }));

    await expect(
      executeHttpCheck(baseInput({ headerAssertions: headers, textBodyAssertions: textBody }), {
        executor: { execute },
      }),
    ).rejects.toBeInstanceOf(AssertionInputError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps HTTP status and assertion outcomes independent', async () => {
    const failingStatus = await executeHttpCheck(
      baseInput({
        textBodyAssertions: [{ operator: 'equals', target: target('error body') }],
      }),
      { executor: { execute: () => Promise.resolve(response('error body', 500)) } },
    );
    const failingAssertion = await executeHttpCheck(
      baseInput({
        textBodyAssertions: [{ operator: 'equals', target: target('expected') }],
      }),
      { executor: { execute: () => Promise.resolve(response('actual', 200)) } },
    );

    expect(failingStatus).toMatchObject({
      outcome: 'FAIL',
      reason: 'UNEXPECTED_STATUS',
      assertionEvaluation: { outcome: 'PASS' },
    });
    expect(failingAssertion).toMatchObject({
      outcome: 'PASS',
      reason: 'COMPLETED',
      assertionEvaluation: { outcome: 'FAIL' },
    });
  });

  it('combines header and text diagnostics without changing their source-local indexes', async () => {
    const result = await executeHttpCheck(
      baseInput({
        headerAssertions: [{ name: 'x-state', operator: 'exists' }],
        textBodyAssertions: [{ operator: 'equals', target: target('expected') }],
      }),
      {
        executor: {
          execute: () =>
            Promise.resolve({
              ...response('actual'),
              headers: [{ name: 'x-state', values: ['ready'] }],
            }),
        },
      },
    );

    expect(result.assertionEvaluation).toMatchObject({
      outcome: 'FAIL',
      diagnostics: [
        { index: 0, source: 'HEADER', outcome: 'PASS' },
        { index: 0, source: 'TEXT_BODY', outcome: 'FAIL' },
      ],
    });
  });

  it('marks text assertions unavailable for a target failure', async () => {
    const result = await executeHttpCheck(
      baseInput({ textBodyAssertions: [{ operator: 'contains', target: target('ready') }] }),
      {
        executor: {
          execute: () =>
            Promise.resolve({
              type: 'TARGET_FAILURE',
              stage: 'DNS',
              reason: 'NAME_NOT_FOUND',
              redirects: [],
            }),
        },
      },
    );
    expect(result.assertionEvaluation).toMatchObject({
      outcome: 'NOT_EVALUATED',
      diagnostics: [{ source: 'TEXT_BODY', reason: 'RESPONSE_UNAVAILABLE' }],
    });
  });

  it('marks text assertions unavailable for a redirect failure', async () => {
    const result = await executeHttpCheck(
      baseInput({ textBodyAssertions: [{ operator: 'contains', target: target('ready') }] }),
      {
        executor: {
          execute: () =>
            Promise.resolve({
              type: 'REDIRECT_FAILURE',
              reason: 'MISSING_REDIRECT_LOCATION',
              statusCode: 302,
              responseTimeMs: 10,
              redirects: [],
            }),
        },
      },
    );
    expect(result.assertionEvaluation).toMatchObject({
      outcome: 'NOT_EVALUATED',
      diagnostics: [{ source: 'TEXT_BODY', reason: 'RESPONSE_UNAVAILABLE' }],
    });
  });

  it('evaluates a real bounded response without retaining expected or received secrets', async () => {
    const receivedSecret = 'WATCHRAIL_RECEIVED_SECRET';
    const expectedSecret = 'WATCHRAIL_EXPECTED_SECRET';
    const server = await startHttpTestServer((_request, reply) => {
      reply
        .writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        .end(`watchrail is ready ${receivedSecret}`);
    });
    servers.push(server);
    const transport = new UndiciPinnedHttpTransport();
    const resolver: DnsResolver = {
      lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }] as const),
    };
    const executor = new NodeHttpExecutor({
      resolver,
      transport: {
        request: (input) =>
          transport.request({
            ...input,
            target: { ...input.target, addresses: [{ address: server.address, family: 4 }] },
          }),
      },
    });

    const result = await executeHttpCheck(
      {
        ...baseInput(),
        url: `http://public.example:${server.port}/health`,
        textBodyAssertions: [
          { operator: 'contains', target: target('watchrail') },
          { operator: 'equals', target: target(expectedSecret, true) },
        ],
      },
      { executor },
    );

    expect(result.assertionEvaluation).toMatchObject({
      outcome: 'FAIL',
      diagnostics: [
        { outcome: 'PASS', reason: 'MATCHED' },
        { outcome: 'FAIL', reason: 'TEXT_BODY_MISMATCH' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(expectedSecret);
    expect(JSON.stringify(result)).not.toContain(receivedSecret);
  });
});

function response(body: string | null, statusCode = 200): HttpExecutionResult {
  return {
    type: 'RESPONSE',
    statusCode,
    responseTimeMs: 10,
    headers: [],
    body: body === null ? { state: 'NOT_REQUESTED' } : { state: 'CAPTURED', text: body },
    redirects: [],
  };
}

function baseInput(overrides: Partial<Parameters<typeof executeHttpCheck>[0]> = {}) {
  return {
    url: 'https://example.com',
    method: 'GET' as const,
    timeoutMs: 10_000,
    followRedirects: true,
    ...overrides,
  };
}

function evaluationWithOutcome(outcome: 'PASS' | 'FAIL' | 'NOT_EVALUATED', index: number) {
  return {
    contractVersion: 1 as const,
    outcome,
    diagnostics: [
      {
        index,
        source: 'TEXT_BODY' as const,
        subject: null,
        operator: 'contains' as const,
        outcome,
        reason:
          outcome === 'PASS'
            ? ('MATCHED' as const)
            : outcome === 'FAIL'
              ? ('TEXT_BODY_MISMATCH' as const)
              : ('RESPONSE_UNAVAILABLE' as const),
      },
    ],
  };
}
