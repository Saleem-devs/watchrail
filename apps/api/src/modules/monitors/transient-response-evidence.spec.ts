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
    ).toEqual({
      transport: 'FAIL',
      statusPolicy: 'NOT_EVALUATED',
      assertions: 'NOT_EVALUATED',
      tlsCertificate: 'DISABLED',
    });
  });

  it('redacts short configured secrets and common camel-case sensitive JSON fields', () => {
    const result: HttpCheckResult = {
      outcome: 'PASS',
      stage: 'HTTP',
      reason: 'COMPLETED',
      statusCode: 200,
      responseTimeMs: 4,
      attemptDurationMs: 5,
      checkedAt: new Date(),
      redirects: [],
      assertionEvaluation: { contractVersion: 1, outcome: 'PASS', diagnostics: [] },
      responseEvidence: {
        headers: [
          { name: 'content-type', values: ['application/json'] },
          { name: 'x-reflected-secret', values: ['ok'] },
        ],
        body: {
          state: 'CAPTURED',
          text: JSON.stringify({
            accessToken: 'access-value',
            clientSecret: 'client-value',
            sessionId: 'session-value',
            credentials: 'credential-value',
            reflected: 'ok',
          }),
        },
      },
    };

    const safe = toSafeTransientCheckResult(result, { type: 'ANY_2XX' }, 'GET', ['ok']);
    expect(JSON.stringify(safe.response)).not.toMatch(
      /access-value|client-value|session-value|credential-value|ok/u,
    );
    expect(JSON.stringify(safe.response)).toContain('[REDACTED]');
  });

  it('reports certificate-expiry failures without misclassifying the HTTPS transport', () => {
    const result: HttpCheckResult = {
      outcome: 'FAIL',
      stage: 'TLS',
      reason: 'CERTIFICATE_EXPIRING',
      statusCode: 200,
      responseTimeMs: 9,
      attemptDurationMs: 10,
      checkedAt: new Date('2026-10-31T20:00:00.000Z'),
      redirects: [],
      assertionEvaluation: { contractVersion: 1, outcome: 'PASS', diagnostics: [] },
      tlsCertificates: [
        {
          contractVersion: 1,
          origin: 'https://example.com',
          hostname: 'example.com',
          validFrom: '2026-09-01T00:00:00.000Z',
          validTo: '2026-11-05T00:00:00.000Z',
          fingerprint256:
            'DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD:DD',
          subject: 'CN=example.com',
          issuer: 'CN=Example CA',
          protocol: 'TLSv1.3',
          cipher: 'TLS_AES_256_GCM_SHA384',
        },
      ],
    };

    expect(
      toSafeTransientCheckResult(result, { type: 'ANY_2XX' }, 'GET', [], {
        type: 'MINIMUM_VALIDITY',
        days: 14,
      }).signals,
    ).toEqual({
      transport: 'PASS',
      statusPolicy: 'PASS',
      assertions: 'PASS',
      tlsCertificate: 'FAIL',
    });
  });

  it('reports unavailable enabled certificate evidence as indeterminate', () => {
    const result: HttpCheckResult = {
      outcome: 'UNKNOWN',
      stage: 'TLS',
      reason: 'CERTIFICATE_EVIDENCE_UNAVAILABLE',
      statusCode: 200,
      responseTimeMs: 9,
      attemptDurationMs: 10,
      checkedAt: new Date('2026-10-31T20:00:00.000Z'),
      redirects: [],
      assertionEvaluation: { contractVersion: 1, outcome: 'PASS', diagnostics: [] },
    };

    expect(
      toSafeTransientCheckResult(result, { type: 'ANY_2XX' }, 'GET', [], {
        type: 'MINIMUM_VALIDITY',
        days: 14,
      }).signals,
    ).toEqual({
      transport: 'PASS',
      statusPolicy: 'PASS',
      assertions: 'PASS',
      tlsCertificate: 'NOT_EVALUATED',
    });
  });

  it.each([
    ['REDIRECT_LOOP', 302],
    ['REQUEST_TIMEOUT', 200],
  ] as const)(
    'classifies %s with retained response headers as a transport failure',
    (reason, statusCode) => {
      const result = {
        outcome: 'FAIL',
        stage: 'HTTP',
        reason,
        statusCode,
        responseTimeMs: 7,
        attemptDurationMs: 20,
        checkedAt: new Date(),
        redirects: [],
        assertionEvaluation: { contractVersion: 1, outcome: 'NOT_EVALUATED', diagnostics: [] },
        responseEvidence: { headers: [{ name: 'content-type', values: ['text/plain'] }] },
      } satisfies HttpCheckResult;

      expect(toSafeTransientCheckResult(result, { type: 'ANY_2XX' }, 'GET', []).signals).toEqual({
        transport: 'FAIL',
        statusPolicy: 'NOT_EVALUATED',
        assertions: 'NOT_EVALUATED',
        tlsCertificate: 'DISABLED',
      });
    },
  );
});
