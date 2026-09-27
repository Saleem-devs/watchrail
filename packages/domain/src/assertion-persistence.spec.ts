import { describe, expect, it } from 'vitest';
import {
  parseStoredAssertionConfiguration,
  parseStoredAssertionEvaluation,
  StoredAssertionContractError,
} from './assertion-persistence.js';

const encryptedValue = {
  version: 1,
  algorithm: 'AES-256-GCM',
  keyId: 'v1',
  iv: 'AAAAAAAAAAAAAAAA',
  ciphertext: 'c2VjcmV0',
  authTag: 'AAAAAAAAAAAAAAAAAAAAAA',
} as const;

describe('parseStoredAssertionConfiguration', () => {
  it('accepts the V1 envelope and normalizes non-sensitive JSON numbers', () => {
    expect(
      parseStoredAssertionConfiguration({
        contractVersion: 1,
        assertions: {
          headers: [
            { name: 'content-type', operator: 'exists' },
            {
              name: 'x-environment',
              operator: 'equals',
              target: { sensitive: false, value: 'production' },
            },
          ],
          textBody: [{ operator: 'not_contains', target: { sensitive: true, encryptedValue } }],
          jsonBody: [
            {
              selector: '$.version',
              operator: 'equals',
              target: { sensitive: false, value: { type: 'number', value: '1.00e0' } },
            },
            {
              selector: '$.token',
              operator: 'not_equals',
              target: { sensitive: true, encryptedValue },
            },
          ],
        },
      }),
    ).toMatchObject({
      contractVersion: 1,
      assertions: {
        jsonBody: [
          { target: { sensitive: false, value: { type: 'number', value: '1' } } },
          { target: { sensitive: true, encryptedValue } },
        ],
      },
    });
  });

  it('rejects plaintext sensitive values so input shapes cannot become storage shapes', () => {
    expect(() =>
      parseStoredAssertionConfiguration({
        contractVersion: 1,
        assertions: {
          headers: [],
          textBody: [
            {
              operator: 'equals',
              target: { sensitive: true, value: 'WATCHRAIL_SENTINEL_SECRET' },
            },
          ],
          jsonBody: [],
        },
      }),
    ).toThrow(StoredAssertionContractError);
  });

  it('rejects an encrypted target beyond the bounded envelope size', () => {
    expect(() =>
      parseStoredAssertionConfiguration({
        contractVersion: 1,
        assertions: {
          headers: [],
          textBody: [
            {
              operator: 'equals',
              target: {
                sensitive: true,
                encryptedValue: {
                  ...encryptedValue,
                  ciphertext: 'A'.repeat(6_000),
                },
              },
            },
          ],
          jsonBody: [],
        },
      }),
    ).toThrow(StoredAssertionContractError);
  });

  it.each([
    { contractVersion: 2, assertions: { headers: [], textBody: [], jsonBody: [] } },
    { assertions: { headers: [], textBody: [], jsonBody: [] } },
    {
      contractVersion: 1,
      assertions: { headers: [], textBody: [], jsonBody: [], extra: true },
    },
  ])('rejects unsupported or inexact persistence envelope %#', (value) => {
    expect(() => parseStoredAssertionConfiguration(value)).toThrow(StoredAssertionContractError);
  });
});

describe('parseStoredAssertionEvaluation', () => {
  it('accepts bounded, data-minimal V1 diagnostics', () => {
    const evaluation = parseStoredAssertionEvaluation({
      contractVersion: 1,
      outcome: 'FAIL',
      diagnostics: [
        {
          index: 0,
          source: 'HEADER',
          subject: 'content-type',
          operator: 'equals',
          outcome: 'FAIL',
          reason: 'HEADER_MISMATCH',
        },
        {
          index: 0,
          source: 'TEXT_BODY',
          subject: null,
          operator: 'contains',
          outcome: 'PASS',
          reason: 'MATCHED',
        },
        {
          index: 0,
          source: 'JSON_BODY',
          subject: '$.ready',
          operator: 'exists',
          outcome: 'NOT_EVALUATED',
          reason: 'RESPONSE_UNAVAILABLE',
        },
      ],
    });

    expect(evaluation).toMatchObject({ contractVersion: 1, outcome: 'FAIL' });
    expect(evaluation.diagnostics).toHaveLength(3);
    expect(evaluation.diagnostics[0]).toMatchObject({ index: 0, source: 'HEADER' });
  });

  it('rejects duplicate identities and arbitrary response evidence', () => {
    const diagnostic = {
      index: 0,
      source: 'HEADER',
      subject: 'authorization',
      operator: 'equals',
      outcome: 'FAIL',
      reason: 'HEADER_MISMATCH',
    };
    expect(() =>
      parseStoredAssertionEvaluation({
        contractVersion: 1,
        outcome: 'FAIL',
        diagnostics: [diagnostic, diagnostic],
      }),
    ).toThrow(StoredAssertionContractError);
    expect(() =>
      parseStoredAssertionEvaluation({
        contractVersion: 1,
        outcome: 'FAIL',
        diagnostics: [{ ...diagnostic, receivedValue: 'WATCHRAIL_SENTINEL_SECRET' }],
      }),
    ).toThrow(StoredAssertionContractError);
  });
});
