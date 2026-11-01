import { describe, expect, it, vi } from 'vitest';
import { executeApiWorkflow } from './api-workflow-check.js';
import type { ApiWorkflowStep } from './api-workflow-types.js';
import type { HttpExecutionResult, HttpExecutor } from './types.js';

const checkedAt = new Date('2026-11-01T15:00:00.000Z');

function createClock() {
  let elapsedMs = 0;
  return {
    now: () => checkedAt,
    monotonicNow: () => elapsedMs,
    advance: (ms: number) => {
      elapsedMs += ms;
    },
  };
}

function step(
  overrides: Partial<ApiWorkflowStep> & Pick<ApiWorkflowStep, 'id' | 'name'>,
): ApiWorkflowStep {
  return {
    url: 'https://api.example.com/health',
    method: 'GET',
    timeoutMs: 10_000,
    followRedirects: true,
    requestBody: { type: 'NONE' },
    extractions: [],
    ...overrides,
  };
}

function response(body = '{}', statusCode = 200): HttpExecutionResult {
  return {
    type: 'RESPONSE',
    statusCode,
    responseTimeMs: 12,
    headers: [{ name: 'content-type', values: ['application/json'] }],
    body: { state: 'CAPTURED', text: body },
    redirects: [],
  };
}

describe('executeApiWorkflow', () => {
  it('chains a scalar extraction into later request surfaces without retaining raw evidence', async () => {
    const clock = createClock();
    const execute = vi
      .fn<HttpExecutor['execute']>()
      .mockImplementationOnce(() => {
        clock.advance(20);
        return Promise.resolve(response('{"token":"secret-token"}'));
      })
      .mockImplementationOnce((input) => {
        clock.advance(15);
        expect(input.url).toBe('https://api.example.com/users/secret-token');
        expect(input.requestHeaders).toEqual([
          { name: 'authorization', value: 'Bearer secret-token' },
        ]);
        return Promise.resolve(response('{"ready":true}'));
      });

    const result = await executeApiWorkflow(
      {
        steps: [
          step({
            id: 'authenticate',
            name: 'Authenticate',
            url: 'https://api.example.com/session',
            extractions: [{ variable: 'token', selector: '$.token', sensitive: true }],
          }),
          step({
            id: 'fetch-user',
            name: 'Fetch user',
            url: 'https://api.example.com/users/{{token}}',
            requestHeaders: [{ name: 'authorization', value: 'Bearer {{token}}' }],
          }),
        ],
      },
      { executor: { execute }, clock },
    );

    expect(result).toMatchObject({
      outcome: 'PASS',
      stage: 'WORKFLOW',
      reason: 'WORKFLOW_COMPLETED',
      failedStepId: null,
      attemptDurationMs: 35,
    });
    const authentication = result.steps[0];
    expect(authentication?.status).toBe('EXECUTED');
    if (authentication?.status !== 'EXECUTED') throw new Error('Expected executed step.');
    expect(authentication.extractions).toEqual([
      {
        variable: 'token',
        selector: '$.token',
        sensitive: true,
        outcome: 'CAPTURED',
        reason: 'CAPTURED',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(
      result.steps.every(
        (item) => item.status === 'SKIPPED' || !('responseEvidence' in item.result),
      ),
    ).toBe(true);
  });

  it('stops after the first failed HTTP step', async () => {
    const execute = vi.fn<HttpExecutor['execute']>().mockResolvedValue(response('{}', 503));
    const result = await executeApiWorkflow(
      {
        steps: [step({ id: 'first', name: 'First' }), step({ id: 'second', name: 'Second' })],
      },
      { executor: { execute }, clock: createClock() },
    );

    expect(result).toMatchObject({
      outcome: 'FAIL',
      reason: 'STEP_FAILED',
      failedStepId: 'first',
    });
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1]).toMatchObject({
      id: 'second',
      status: 'SKIPPED',
      reason: 'PREVIOUS_STEP_FAILED',
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('fails safely when extraction evidence is missing or non-scalar', async () => {
    const execute = vi.fn<HttpExecutor['execute']>().mockResolvedValue(response('{"user":{}}'));
    const result = await executeApiWorkflow(
      {
        steps: [
          step({
            id: 'extract',
            name: 'Extract',
            extractions: [{ variable: 'user', selector: '$.user', sensitive: false }],
          }),
          step({ id: 'next', name: 'Next' }),
        ],
      },
      { executor: { execute }, clock: createClock() },
    );

    expect(result).toMatchObject({
      outcome: 'FAIL',
      reason: 'EXTRACTION_FAILED',
      failedStepId: 'extract',
    });
    const extraction = result.steps[0];
    expect(extraction?.status).toBe('EXECUTED');
    if (extraction?.status !== 'EXECUTED') throw new Error('Expected executed step.');
    expect(extraction.extractions[0]).toMatchObject({
      outcome: 'FAILED',
      reason: 'NON_SCALAR_VALUE',
    });
    expect(result.steps[1]).toMatchObject({
      status: 'SKIPPED',
      reason: 'PREVIOUS_STEP_FAILED',
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('is indeterminate when response evidence cannot be captured for extraction', async () => {
    const execute = vi.fn<HttpExecutor['execute']>().mockResolvedValue({
      type: 'RESPONSE',
      statusCode: 200,
      responseTimeMs: 12,
      headers: [],
      body: { state: 'UNAVAILABLE', reason: 'BODY_TOO_LARGE' },
      redirects: [],
    });
    const result = await executeApiWorkflow(
      {
        steps: [
          step({
            id: 'extract',
            name: 'Extract',
            extractions: [{ variable: 'token', selector: '$.token', sensitive: true }],
          }),
          step({ id: 'next', name: 'Next' }),
        ],
      },
      { executor: { execute }, clock: createClock() },
    );

    expect(result).toMatchObject({
      outcome: 'UNKNOWN',
      reason: 'EXTRACTION_INDETERMINATE',
      failedStepId: 'extract',
    });
    const extraction = result.steps[0];
    expect(extraction?.status).toBe('EXECUTED');
    if (extraction?.status !== 'EXECUTED') throw new Error('Expected executed step.');
    expect(extraction.extractions[0]).toMatchObject({
      outcome: 'NOT_EVALUATED',
      reason: 'BODY_UNAVAILABLE',
    });
    expect(result.steps[1]).toMatchObject({
      status: 'SKIPPED',
      reason: 'PREVIOUS_STEP_INDETERMINATE',
    });
  });

  it('escapes extracted strings when interpolating JSON request bodies', async () => {
    const execute = vi
      .fn<HttpExecutor['execute']>()
      .mockResolvedValueOnce(response(JSON.stringify({ value: 'quote: " and slash: \\' })))
      .mockImplementationOnce((input) => {
        const body = new TextDecoder().decode(input.requestBody?.bytes);
        expect(body).toContain('"id":9007199254740993');
        expect(JSON.parse(body)).toEqual({
          id: 9007199254740992,
          message: 'quote: " and slash: \\',
        });
        return Promise.resolve(response());
      });
    const result = await executeApiWorkflow(
      {
        steps: [
          step({
            id: 'extract',
            name: 'Extract',
            extractions: [{ variable: 'value', selector: '$.value', sensitive: true }],
          }),
          step({
            id: 'send',
            name: 'Send',
            method: 'POST',
            requestBody: {
              type: 'JSON',
              value: '{"id":9007199254740993,"message":"{{value}}"}',
            },
          }),
        ],
      },
      { executor: { execute }, clock: createClock() },
    );

    expect(result.outcome).toBe('PASS');
    expect(JSON.stringify(result)).not.toContain('quote:');
  });

  it.each([
    'https://{{tenant}}.example.com/health',
    'https:{{tenant}}.example.com/health',
    'https:/{{tenant}}.example.com/health',
  ])('rejects origin interpolation in URL form %s', async (url) => {
    await expect(
      executeApiWorkflow(
        {
          initialVariables: { tenant: 'secret-subdomain' },
          steps: [
            step({ id: 'first', name: 'First', url }),
            step({ id: 'second', name: 'Second' }),
          ],
        },
        { executor: { execute: vi.fn<HttpExecutor['execute']>() } },
      ),
    ).rejects.toThrow('cannot be interpolated into URL origins');
  });

  it('does not retain redirect origins that reflect an extracted secret', async () => {
    const execute = vi
      .fn<HttpExecutor['execute']>()
      .mockResolvedValueOnce(response('{"token":"secret-token"}'))
      .mockResolvedValueOnce({
        ...response(),
        redirects: [
          {
            sequence: 1,
            statusCode: 302,
            source: { targetId: 1, origin: 'https://api.example.com:443' },
            destination: {
              targetId: 2,
              origin: 'https://secret-token.example.com:443',
            },
            responseTimeMs: 4,
            headers: 'STRIPPED',
          },
        ],
        tlsCertificates: [
          {
            contractVersion: 1,
            origin: 'https://secret-token.example.com:443',
            hostname: 'secret-token.example.com',
            validFrom: '2026-01-01T00:00:00.000Z',
            validTo: '2027-01-01T00:00:00.000Z',
            fingerprint256:
              'AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA',
            subject: 'CN=secret-token.example.com',
            issuer: 'CN=Example CA',
            protocol: 'TLSv1.3',
            cipher: 'TLS_AES_256_GCM_SHA384',
          },
        ],
      });

    const result = await executeApiWorkflow(
      {
        steps: [
          step({
            id: 'extract',
            name: 'Extract',
            extractions: [{ variable: 'token', selector: '$.token', sensitive: true }],
          }),
          step({ id: 'redirect', name: 'Redirect' }),
        ],
      },
      { executor: { execute }, clock: createClock() },
    );

    expect(result.outcome).toBe('PASS');
    const redirected = result.steps[1];
    expect(redirected?.status).toBe('EXECUTED');
    if (redirected?.status !== 'EXECUTED') throw new Error('Expected executed step.');
    expect(redirected.result).toMatchObject({ redirectCount: 1, tlsCertificateCount: 1 });
    expect(redirected.result).not.toHaveProperty('redirects');
    expect(redirected.result).not.toHaveProperty('tlsCertificates');
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('includes the current and downstream steps when request preparation fails', async () => {
    const result = await executeApiWorkflow(
      {
        initialVariables: { value: 'safe' },
        steps: [
          step({
            id: 'invalid-json',
            name: 'Invalid JSON',
            method: 'POST',
            requestBody: { type: 'JSON', value: '{"value":"{{value}}"' },
          }),
          step({ id: 'later', name: 'Later' }),
        ],
      },
      { executor: { execute: vi.fn<HttpExecutor['execute']>() }, clock: createClock() },
    );

    expect(result).toMatchObject({ outcome: 'UNKNOWN', reason: 'INTERNAL_ERROR' });
    expect(result.steps).toEqual([
      expect.objectContaining({
        id: 'invalid-json',
        status: 'SKIPPED',
        reason: 'EXECUTION_ERROR',
      }),
      expect.objectContaining({
        id: 'later',
        status: 'SKIPPED',
        reason: 'PREVIOUS_STEP_INDETERMINATE',
      }),
    ]);
  });

  it('rejects a request that references a variable unavailable from an earlier step', async () => {
    const execute = vi.fn<HttpExecutor['execute']>();
    await expect(
      executeApiWorkflow(
        {
          steps: [
            step({ id: 'first', name: 'First', url: 'https://api.example.com/{{missing}}' }),
            step({ id: 'second', name: 'Second' }),
          ],
        },
        { executor: { execute }, clock: createClock() },
      ),
    ).rejects.toThrow('not available from an earlier step');
    expect(execute).not.toHaveBeenCalled();
  });

  it('permits explicitly supplied execution-scoped variables without returning their values', async () => {
    const execute = vi.fn<HttpExecutor['execute']>().mockResolvedValue(response());
    const result = await executeApiWorkflow(
      {
        initialVariables: { tenant: 'tenant-secret' },
        steps: [
          step({ id: 'first', name: 'First', url: 'https://api.example.com/{{tenant}}' }),
          step({ id: 'second', name: 'Second' }),
        ],
      },
      { executor: { execute }, clock: createClock() },
    );

    expect(result.outcome).toBe('PASS');
    expect(execute.mock.calls[0]?.[0].url).toBe('https://api.example.com/tenant-secret');
    expect(JSON.stringify(result)).not.toContain('tenant-secret');
  });

  it('rejects unsafe workflow sizes, duplicate steps, variables, and selectors', async () => {
    const dependencies = { executor: { execute: vi.fn<HttpExecutor['execute']>() } };
    await expect(
      executeApiWorkflow({ steps: [step({ id: 'only', name: 'Only' })] }, dependencies),
    ).rejects.toThrow('require 2 to 10 steps');
    await expect(
      executeApiWorkflow(
        {
          steps: [step({ id: 'same', name: 'One' }), step({ id: 'same', name: 'Two' })],
        },
        dependencies,
      ),
    ).rejects.toThrow('unique IDs');
    await expect(
      executeApiWorkflow(
        {
          steps: [
            step({
              id: 'one',
              name: 'One',
              extractions: [{ variable: 'token', selector: '$.token', sensitive: true }],
            }),
            step({
              id: 'two',
              name: 'Two',
              extractions: [{ variable: 'token', selector: '$.other', sensitive: true }],
            }),
          ],
        },
        dependencies,
      ),
    ).rejects.toThrow('redefines a variable');
  });

  it('bounds initial variable counts and extracted value sizes', async () => {
    const dependencies = {
      executor: { execute: vi.fn<HttpExecutor['execute']>().mockResolvedValue(response()) },
    };
    await expect(
      executeApiWorkflow(
        {
          initialVariables: Object.fromEntries(
            Array.from({ length: 33 }, (_, index) => [`variable_${index}`, 'value']),
          ),
          steps: [step({ id: 'one', name: 'One' }), step({ id: 'two', name: 'Two' })],
        },
        dependencies,
      ),
    ).rejects.toThrow('too many initial variables');

    const oversized = 'x'.repeat(16 * 1024 + 1);
    const execute = vi
      .fn<HttpExecutor['execute']>()
      .mockResolvedValue(response(JSON.stringify({ value: oversized })));
    const result = await executeApiWorkflow(
      {
        steps: [
          step({
            id: 'extract',
            name: 'Extract',
            extractions: [{ variable: 'value', selector: '$.value', sensitive: true }],
          }),
          step({ id: 'later', name: 'Later' }),
        ],
      },
      { executor: { execute } },
    );
    expect(result).toMatchObject({ outcome: 'FAIL', reason: 'EXTRACTION_FAILED' });
    const extraction = result.steps[0];
    expect(extraction?.status).toBe('EXECUTED');
    if (extraction?.status !== 'EXECUTED') throw new Error('Expected executed step.');
    expect(extraction.extractions[0]).toMatchObject({ reason: 'VALUE_TOO_LARGE' });
    expect(JSON.stringify(result)).not.toContain(oversized);
  });
});
