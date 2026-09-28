import {
  ASSERTION_LIMITS,
  AssertionInputError,
  type JsonBodyAssertion,
  type JsonScalarTarget,
} from '@watchrail/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeHttpCheck } from './http-check.js';
import { NodeHttpExecutor } from './node-http-executor.js';
import type { DnsResolver } from './safe-http-target.js';
import { startHttpTestServer, type HttpTestServer } from './test-support/http-test-server.js';
import type { HttpExecutionResult, HttpExecutor } from './types.js';
import { UndiciPinnedHttpTransport } from './undici-http-transport.js';
import {
  evaluateJsonBodyAssertions,
  notEvaluateJsonBodyAssertions,
} from './json-body-assertions.js';

const target = (value: JsonScalarTarget, sensitive = false) => ({ value, sensitive });
const servers: HttpTestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('evaluateJsonBodyAssertions', () => {
  it('resolves root, dot properties, bracket properties, arrays, and escaped keys', () => {
    const body = {
      state: 'CAPTURED' as const,
      text: `{"status":"ready","key-with-dashes":"yes","quote'key":"quoted","a/b":"slash","😀":"emoji","items":[{"id":7}]}`,
    };
    const assertions: JsonBodyAssertion[] = [
      { selector: '$', operator: 'exists' },
      {
        selector: '$.status',
        operator: 'equals',
        target: target({ type: 'string', value: 'ready' }),
      },
      {
        selector: "$['key-with-dashes']",
        operator: 'equals',
        target: target({ type: 'string', value: 'yes' }),
      },
      {
        selector: String.raw`$['quote\'key']`,
        operator: 'equals',
        target: target({ type: 'string', value: 'quoted' }),
      },
      {
        selector: String.raw`$['a\/b']`,
        operator: 'equals',
        target: target({ type: 'string', value: 'slash' }),
      },
      {
        selector: String.raw`$['\uD83D\uDE00']`,
        operator: 'equals',
        target: target({ type: 'string', value: 'emoji' }),
      },
      {
        selector: '$.items[0].id',
        operator: 'equals',
        target: target({ type: 'number', value: '7' }),
      },
    ];

    const evaluation = evaluateJsonBodyAssertions(assertions, body);
    expect(evaluation.outcome).toBe('PASS');
    expect(evaluation.diagnostics).toHaveLength(assertions.length);
    expect(evaluation.diagnostics.every((diagnostic) => diagnostic.reason === 'MATCHED')).toBe(
      true,
    );
  });

  it.each([
    ['exists', '$.present', true],
    ['exists', '$.missing', false],
    ['does_not_exist', '$.missing', true],
    ['does_not_exist', '$.present', false],
  ] as const)('evaluates %s on %s', (operator, selector, passed) => {
    expect(
      evaluateJsonBodyAssertions([{ selector, operator }], {
        state: 'CAPTURED',
        text: '{"present":null}',
      }),
    ).toMatchObject({
      outcome: passed ? 'PASS' : 'FAIL',
      diagnostics: [{ reason: passed ? 'MATCHED' : 'JSON_BODY_MISMATCH' }],
    });
  });

  it.each([
    ['equals', '$.status', { type: 'string', value: 'ready' }, true],
    ['equals', '$.status', { type: 'string', value: 'other' }, false],
    ['not_equals', '$.status', { type: 'string', value: 'other' }, true],
    ['not_equals', '$.status', { type: 'string', value: 'ready' }, false],
    ['equals', '$.missing', { type: 'string', value: 'ready' }, false],
    ['not_equals', '$.missing', { type: 'string', value: 'ready' }, false],
  ] as const)(
    'evaluates %s at %s with fail-closed missing semantics',
    (operator, selector, value, passed) => {
      expect(
        evaluateJsonBodyAssertions([{ selector, operator, target: target(value) }], {
          state: 'CAPTURED',
          text: '{"status":"ready"}',
        }),
      ).toMatchObject({
        outcome: passed ? 'PASS' : 'FAIL',
        diagnostics: [{ reason: passed ? 'MATCHED' : 'JSON_BODY_MISMATCH' }],
      });
    },
  );

  it.each([
    ['$.number', { type: 'number', value: '1' }, 'PASS'],
    ['$.number', { type: 'string', value: '1' }, 'FAIL'],
    ['$.string', { type: 'string', value: '1' }, 'PASS'],
    ['$.boolean', { type: 'boolean', value: true }, 'PASS'],
    ['$.boolean', { type: 'string', value: 'true' }, 'FAIL'],
    ['$.nothing', { type: 'null' }, 'PASS'],
    ['$.nothing', { type: 'string', value: 'null' }, 'FAIL'],
    ['$.unsafe', { type: 'number', value: '9007199254740993' }, 'PASS'],
  ] as const)('compares %s with exact scalar type identity', (selector, value, outcome) => {
    const body =
      '{"number":1.0,"string":"1","boolean":true,"nothing":null,"unsafe":9007199254740993}';
    expect(
      evaluateJsonBodyAssertions([{ selector, operator: 'equals', target: target(value) }], {
        state: 'CAPTURED',
        text: body,
      }).outcome,
    ).toBe(outcome);
  });

  it.each(['equals', 'not_equals'] as const)(
    'classifies %s against an object or array as unsupported',
    (operator) => {
      const assertions: JsonBodyAssertion[] = [
        { selector: '$.object', operator, target: target({ type: 'null' }) },
        { selector: '$.array', operator, target: target({ type: 'null' }) },
      ];
      const evaluation = evaluateJsonBodyAssertions(assertions, {
        state: 'CAPTURED',
        text: '{"object":{},"array":[]}',
      });
      expect(evaluation.outcome).toBe('FAIL');
      expect(evaluation.diagnostics).toEqual([
        expect.objectContaining({ outcome: 'FAIL', reason: 'JSON_TYPE_UNSUPPORTED' }),
        expect.objectContaining({ outcome: 'FAIL', reason: 'JSON_TYPE_UNSUPPORTED' }),
      ]);
    },
  );

  it.each([
    ['{"broken":', 'INVALID_JSON'],
    ['{"value":1,"value":2}', 'DUPLICATE_JSON_KEY'],
  ] as const)('maps parser failure %s to every assertion', (text, reason) => {
    const evaluation = evaluateJsonBodyAssertions(
      [
        { selector: '$.value', operator: 'exists' },
        { selector: '$.other', operator: 'does_not_exist' },
      ],
      { state: 'CAPTURED', text },
    );
    expect(evaluation).toMatchObject({
      outcome: 'FAIL',
      diagnostics: [
        { outcome: 'FAIL', reason },
        { outcome: 'FAIL', reason },
      ],
    });
  });

  it.each([
    'BODY_TOO_LARGE',
    'UNSUPPORTED_CONTENT_ENCODING',
    'UNSUPPORTED_CHARSET',
    'BODY_READ_FAILED',
  ] as const)('maps unavailable body reason %s', (reason) => {
    expect(
      evaluateJsonBodyAssertions([{ selector: '$', operator: 'exists' }], {
        state: 'UNAVAILABLE',
        reason,
      }),
    ).toMatchObject({
      outcome: 'NOT_EVALUATED',
      diagnostics: [{ outcome: 'NOT_EVALUATED', reason }],
    });
  });

  it('defensively treats NOT_REQUESTED as unavailable', () => {
    expect(
      evaluateJsonBodyAssertions([{ selector: '$', operator: 'exists' }], {
        state: 'NOT_REQUESTED',
      }),
    ).toMatchObject({
      outcome: 'NOT_EVALUATED',
      diagnostics: [{ reason: 'RESPONSE_UNAVAILABLE' }],
    });
  });

  it('resolves an enormous array index as missing without numeric coercion', () => {
    const selector = `$[${'9'.repeat(500)}]`;
    expect(
      evaluateJsonBodyAssertions([{ selector, operator: 'does_not_exist' }], {
        state: 'CAPTURED',
        text: '["only"]',
      }).outcome,
    ).toBe('PASS');
  });

  it('never copies target or received JSON values into diagnostics', () => {
    const expected = 'WATCHRAIL_JSON_EXPECTED_SECRET';
    const received = 'WATCHRAIL_JSON_RECEIVED_SECRET';
    const evaluation = evaluateJsonBodyAssertions(
      [
        {
          selector: '$.value',
          operator: 'equals',
          target: target({ type: 'string', value: expected }, true),
        },
      ],
      { state: 'CAPTURED', text: `{"value":"${received}"}` },
    );
    expect(JSON.stringify(evaluation)).not.toContain(expected);
    expect(JSON.stringify(evaluation)).not.toContain(received);
  });

  it('defensively rejects more than the domain assertion limit', () => {
    const assertions = Array.from(
      { length: ASSERTION_LIMITS.maxAssertions + 1 },
      (): JsonBodyAssertion => ({ selector: '$', operator: 'exists' }),
    );
    expect(() =>
      evaluateJsonBodyAssertions(assertions, { state: 'CAPTURED', text: 'null' }),
    ).toThrow(`Cannot evaluate more than ${ASSERTION_LIMITS.maxAssertions} assertions.`);
    expect(() => notEvaluateJsonBodyAssertions(assertions)).toThrow(
      `Cannot evaluate more than ${ASSERTION_LIMITS.maxAssertions} assertions.`,
    );
  });
});

describe('executeHttpCheck JSON-body assertions', () => {
  it.each([
    [false, []],
    [true, [{ selector: '$.ready', operator: 'exists' }]],
  ] as const)(
    'derives captureResponseBody=%s from JSON assertions',
    async (capture, assertions) => {
      const execute = vi.fn<HttpExecutor['execute']>((input) =>
        Promise.resolve(response(input.captureResponseBody === true ? '{"ready":true}' : null)),
      );

      await executeHttpCheck(baseInput({ jsonBodyAssertions: assertions }), {
        executor: { execute },
      });

      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ captureResponseBody: capture }),
      );
    },
  );

  it('rejects HEAD JSON assertions before invoking the executor', async () => {
    const execute = vi.fn<HttpExecutor['execute']>();
    await expect(
      executeHttpCheck(
        baseInput({
          method: 'HEAD',
          jsonBodyAssertions: [{ selector: '$.ready', operator: 'exists' }],
        }),
        { executor: { execute } },
      ),
    ).rejects.toBeInstanceOf(AssertionInputError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('enforces the global limit across header, text, and JSON assertions', async () => {
    const execute = vi.fn<HttpExecutor['execute']>();
    await expect(
      executeHttpCheck(
        baseInput({
          headerAssertions: Array.from({ length: 11 }, () => ({
            name: 'x-state',
            operator: 'exists' as const,
          })),
          textBodyAssertions: Array.from({ length: 11 }, () => ({
            operator: 'contains' as const,
            target: { value: 'ready', sensitive: false },
          })),
          jsonBodyAssertions: Array.from({ length: 11 }, () => ({
            selector: '$.ready',
            operator: 'exists' as const,
          })),
        }),
        { executor: { execute } },
      ),
    ).rejects.toBeInstanceOf(AssertionInputError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('combines header, text, and JSON diagnostics with source-local indexes', async () => {
    const result = await executeHttpCheck(
      baseInput({
        headerAssertions: [{ name: 'x-state', operator: 'exists' }],
        textBodyAssertions: [
          { operator: 'contains', target: { value: 'missing-text', sensitive: false } },
        ],
        jsonBodyAssertions: [
          {
            selector: '$.status',
            operator: 'equals',
            target: target({ type: 'string', value: 'ready' }),
          },
        ],
      }),
      {
        executor: {
          execute: () =>
            Promise.resolve({
              ...response('{"status":"ready"}'),
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
        { index: 0, source: 'JSON_BODY', outcome: 'PASS' },
      ],
    });
  });

  it('evaluates a real JSON response without retaining expected or received secrets', async () => {
    const expectedSecret = 'WATCHRAIL_JSON_EXPECTED_SECRET';
    const receivedSecret = 'WATCHRAIL_JSON_RECEIVED_SECRET';
    const server = await startHttpTestServer((_request, reply) => {
      reply
        .writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        .end(`{"status":"ready","secret":"${receivedSecret}"}`);
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
      baseInput({
        url: `http://public.example:${server.port}/health`,
        jsonBodyAssertions: [
          {
            selector: '$.status',
            operator: 'equals',
            target: target({ type: 'string', value: 'ready' }),
          },
          {
            selector: '$.secret',
            operator: 'equals',
            target: target({ type: 'string', value: expectedSecret }, true),
          },
        ],
      }),
      { executor },
    );

    expect(result.assertionEvaluation).toMatchObject({
      outcome: 'FAIL',
      diagnostics: [
        { source: 'JSON_BODY', outcome: 'PASS', reason: 'MATCHED' },
        { source: 'JSON_BODY', outcome: 'FAIL', reason: 'JSON_BODY_MISMATCH' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(expectedSecret);
    expect(JSON.stringify(result)).not.toContain(receivedSecret);
  });
});

function response(body: string | null): HttpExecutionResult {
  return {
    type: 'RESPONSE',
    statusCode: 200,
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
