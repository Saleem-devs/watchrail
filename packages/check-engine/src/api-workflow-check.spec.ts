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
});
