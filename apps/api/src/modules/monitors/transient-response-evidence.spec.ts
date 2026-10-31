import { describe, expect, it } from 'vitest';
import type { HttpCheckResult } from '@watchrail/check-engine';
import {
  RESPONSE_PREVIEW_LIMIT_BYTES,
  toSafeTransientCheckResult,
} from './transient-response-evidence.js';

describe('transient response evidence', () => {
  it('bounds previews and redacts sensitive headers, JSON fields, and configured secret values', () => {
    const result: HttpCheckResult = {
      outcome: 'PASS',
      stage: 'HTTP',
      reason: 'COMPLETED',
      statusCode: 202,
      responseTimeMs: 24,
      attemptDurationMs: 30,
      checkedAt: new Date('2026-10-31T20:00:00.000Z'),
      redirects: [],
      assertionEvaluation: { contractVersion: 1, outcome: 'PASS', diagnostics: [] },
      responseEvidence: {
        headers: [
          { name: 'content-type', values: ['application/json'] },
          { name: 'set-cookie', values: ['session=private-value'] },
          { name: 'x-debug', values: ['configured-secret'] },
        ],
        body: {
          state: 'CAPTURED',
          text: JSON.stringify({
            token: 'body-token',
            echo: 'configured-secret',
            data: 'x'.repeat(RESPONSE_PREVIEW_LIMIT_BYTES),
          }),
        },
      },
    };

    const safe = toSafeTransientCheckResult(result, { type: 'EXACT', statusCodes: [202] }, 'POST', [
      'configured-secret',
    ]);
    expect(safe).not.toHaveProperty('result.responseEvidence');
    expect(safe.response.headers).toEqual([
      { name: 'content-type', values: ['application/json'], redacted: false },
      { name: 'set-cookie', values: ['[REDACTED]'], redacted: true },
      { name: 'x-debug', values: ['[REDACTED]'], redacted: false },
    ]);
    expect(safe.response.body).toMatchObject({ state: 'PREVIEW', truncated: true });
    expect(JSON.stringify(safe.response.body)).not.toContain('configured-secret');
    expect(JSON.stringify(safe.response.body)).not.toContain('body-token');
  });

  it('reports unsupported and unavailable evidence without inventing a body', () => {
    const base: HttpCheckResult = {
      outcome: 'FAIL',
      stage: 'HTTP',
      reason: 'UNEXPECTED_STATUS',
      statusCode: 500,
      responseTimeMs: 8,
      attemptDurationMs: 9,
      checkedAt: new Date(),
      redirects: [],
      assertionEvaluation: { contractVersion: 1, outcome: 'NOT_EVALUATED', diagnostics: [] },
      responseEvidence: {
        headers: [{ name: 'content-type', values: ['application/octet-stream'] }],
        body: { state: 'CAPTURED', text: 'binary-ish' },
      },
    };
    expect(toSafeTransientCheckResult(base, { type: 'ANY_2XX' }, 'GET', []).response.body).toEqual({
      state: 'UNAVAILABLE',
      reason: 'UNSUPPORTED_CONTENT_TYPE',
    });
    expect(
      toSafeTransientCheckResult(
        {
          outcome: 'FAIL',
          stage: 'HTTP',
          reason: 'REQUEST_TIMEOUT',
          statusCode: null,
          responseTimeMs: null,
          attemptDurationMs: base.attemptDurationMs,
          checkedAt: base.checkedAt,
          redirects: base.redirects,
          assertionEvaluation: base.assertionEvaluation,
        },
        { type: 'ANY_2XX' },
        'GET',
        [],
      ).signals,
    ).toEqual({ transport: 'FAIL', statusPolicy: 'NOT_EVALUATED', assertions: 'NOT_EVALUATED' });
  });
});
