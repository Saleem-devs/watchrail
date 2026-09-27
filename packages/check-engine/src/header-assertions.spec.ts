import { ASSERTION_LIMITS, type HeaderAssertion } from '@watchrail/domain';
import { describe, expect, it } from 'vitest';
import { evaluateHeaderAssertions, notEvaluateHeaderAssertions } from './header-assertions.js';

const target = (value: string, sensitive = false) => ({ value, sensitive });

describe('evaluateHeaderAssertions', () => {
  it.each([
    [{ name: 'x-state', operator: 'exists' }, [], 'FAIL'],
    [{ name: 'x-state', operator: 'exists' }, [''], 'PASS'],
    [{ name: 'x-state', operator: 'does_not_exist' }, [], 'PASS'],
    [{ name: 'x-state', operator: 'does_not_exist' }, [''], 'FAIL'],
    [{ name: 'x-state', operator: 'equals', target: target('ready') }, ['ready'], 'PASS'],
    [{ name: 'x-state', operator: 'equals', target: target('ready') }, ['READY'], 'FAIL'],
    [{ name: 'x-state', operator: 'contains', target: target('read') }, ['ready'], 'PASS'],
    [{ name: 'x-state', operator: 'contains', target: target('READ') }, ['ready'], 'FAIL'],
    [{ name: 'x-state', operator: 'not_equals', target: target('ready') }, ['other'], 'PASS'],
    [{ name: 'x-state', operator: 'not_equals', target: target('ready') }, [], 'PASS'],
    [{ name: 'x-state', operator: 'not_contains', target: target('read') }, ['other'], 'PASS'],
    [{ name: 'x-state', operator: 'not_contains', target: target('read') }, [], 'PASS'],
  ] as const)('evaluates %o against %o as %s', (assertion, values, outcome) => {
    const evaluation = evaluateHeaderAssertions([assertion], [{ name: 'X-State', values }]);

    expect(evaluation).toMatchObject({
      contractVersion: 1,
      outcome,
      diagnostics: [{ outcome, reason: outcome === 'PASS' ? 'MATCHED' : 'HEADER_MISMATCH' }],
    });
  });

  it.each([
    ['equals', 'ready', 'FAIL'],
    ['equals', 'secondary=true', 'PASS'],
    ['contains', 'cond', 'PASS'],
    ['not_equals', 'secondary=true', 'FAIL'],
    ['not_contains', 'cond', 'FAIL'],
  ] as const)('applies %s with any-match repeated-value semantics', (operator, value, outcome) => {
    const assertion = {
      name: 'set-cookie',
      operator,
      target: target(value),
    } satisfies HeaderAssertion;

    expect(
      evaluateHeaderAssertions(
        [assertion],
        [{ name: 'set-cookie', values: ['primary=true', 'secondary=true'] }],
      ).outcome,
    ).toBe(outcome);
  });

  it('matches names case-insensitively without changing value case', () => {
    const evaluation = evaluateHeaderAssertions(
      [
        { name: 'X-State', operator: 'equals', target: target('Ready') },
        { name: 'x-state', operator: 'not_equals', target: target('ready') },
      ],
      [{ name: 'X-STATE', values: ['Ready'] }],
    );

    expect(evaluation.outcome).toBe('PASS');
  });

  it('evaluates every assertion and derives the aggregate with AND semantics', () => {
    const evaluation = evaluateHeaderAssertions(
      [
        { name: 'x-state', operator: 'exists' },
        { name: 'x-state', operator: 'equals', target: target('wrong') },
        { name: 'x-missing', operator: 'not_contains', target: target('secret', true) },
      ],
      [{ name: 'x-state', values: ['ready'] }],
    );

    expect(evaluation.outcome).toBe('FAIL');
    expect(evaluation.diagnostics.map((diagnostic) => diagnostic.outcome)).toEqual([
      'PASS',
      'FAIL',
      'PASS',
    ]);
    expect(JSON.stringify(evaluation)).not.toContain('wrong');
    expect(JSON.stringify(evaluation)).not.toContain('secret');
    expect(JSON.stringify(evaluation)).not.toContain('ready');
  });

  it('defensively rejects more than the domain assertion limit', () => {
    const assertions = Array.from(
      { length: ASSERTION_LIMITS.maxAssertions + 1 },
      (): HeaderAssertion => ({ name: 'x-state', operator: 'exists' }),
    );

    expect(() => evaluateHeaderAssertions(assertions, [])).toThrow(
      `Cannot evaluate more than ${ASSERTION_LIMITS.maxAssertions} assertions.`,
    );
    expect(() => notEvaluateHeaderAssertions(assertions)).toThrow(
      `Cannot evaluate more than ${ASSERTION_LIMITS.maxAssertions} assertions.`,
    );
  });
});

describe('notEvaluateHeaderAssertions', () => {
  it('marks every configured assertion unavailable without retaining values', () => {
    const evaluation = notEvaluateHeaderAssertions([
      { name: 'authorization', operator: 'equals', target: target('Bearer SECRET', true) },
      { name: 'x-state', operator: 'exists' },
    ]);

    expect(evaluation).toMatchObject({
      contractVersion: 1,
      outcome: 'NOT_EVALUATED',
      diagnostics: [
        { index: 0, outcome: 'NOT_EVALUATED', reason: 'RESPONSE_UNAVAILABLE' },
        { index: 1, outcome: 'NOT_EVALUATED', reason: 'RESPONSE_UNAVAILABLE' },
      ],
    });
    expect(JSON.stringify(evaluation)).not.toContain('Bearer SECRET');
  });

  it('returns PASS when there is nothing to evaluate', () => {
    expect(notEvaluateHeaderAssertions([])).toEqual({
      contractVersion: 1,
      outcome: 'PASS',
      diagnostics: [],
    });
  });
});
