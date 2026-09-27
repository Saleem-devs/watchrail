import { describe, expect, it } from 'vitest';
import {
  ASSERTION_LIMITS,
  AssertionInputError,
  isValidJsonSelector,
  parseResponseAssertions,
} from './assertion.js';

describe('parseResponseAssertions', () => {
  it('defaults to an empty assertion contract', () => {
    expect(parseResponseAssertions(undefined, 'GET')).toEqual({
      headers: [],
      textBody: [],
      jsonBody: [],
    });
  });

  it('normalizes header names and preserves explicit sensitivity metadata', () => {
    expect(
      parseResponseAssertions(
        {
          headers: [
            { name: ' Content-Type ', operator: 'exists' },
            {
              name: 'X-Deployment',
              operator: 'equals',
              target: { value: 'production', sensitive: false },
            },
            {
              name: 'Set-Cookie',
              operator: 'not_contains',
              target: { value: 'admin=true', sensitive: true },
            },
          ],
          textBody: [],
          jsonBody: [],
        },
        'GET',
      ).headers,
    ).toEqual([
      { name: 'content-type', operator: 'exists' },
      {
        name: 'x-deployment',
        operator: 'equals',
        target: { value: 'production', sensitive: false },
      },
      {
        name: 'set-cookie',
        operator: 'not_contains',
        target: { value: 'admin=true', sensitive: true },
      },
    ]);
  });

  it('accepts every MVP operator and typed JSON scalar', () => {
    const assertions = parseResponseAssertions(
      {
        headers: [
          { name: 'x-one', operator: 'exists' },
          { name: 'x-two', operator: 'does_not_exist' },
          ...['equals', 'not_equals', 'contains', 'not_contains'].map((operator) => ({
            name: `x-${operator}`,
            operator,
            target: { value: 'literal', sensitive: false },
          })),
        ],
        textBody: ['equals', 'not_equals', 'contains', 'not_contains'].map((operator) => ({
          operator,
          target: { value: 'literal', sensitive: false },
        })),
        jsonBody: [
          { selector: '$.present', operator: 'exists' },
          { selector: '$.missing', operator: 'does_not_exist' },
          {
            selector: '$.string',
            operator: 'equals',
            target: { value: { type: 'string', value: 'ready' }, sensitive: false },
          },
          {
            selector: '$.number',
            operator: 'equals',
            target: { value: { type: 'number', value: '1.2300e+10' }, sensitive: false },
          },
          {
            selector: '$.boolean',
            operator: 'not_equals',
            target: { value: { type: 'boolean', value: true }, sensitive: false },
          },
          {
            selector: '$.nullable',
            operator: 'equals',
            target: { value: { type: 'null' }, sensitive: false },
          },
        ],
      },
      'GET',
    );

    expect(assertions.headers).toHaveLength(6);
    expect(assertions.textBody).toHaveLength(4);
    expect(assertions.jsonBody).toHaveLength(6);
    expect(assertions.jsonBody[3]).toMatchObject({
      target: { value: { type: 'number', value: '123e8' } },
    });
  });

  it.each([
    ['1', '1'],
    ['1.0', '1'],
    ['1e0', '1'],
    ['-0.000', '0'],
    ['0.00100', '1e-3'],
    ['1000', '1e3'],
    ['12.34e-2', '1234e-4'],
  ])('normalizes lossless JSON number %s as %s', (value, expected) => {
    const assertions = parseResponseAssertions(
      {
        headers: [],
        textBody: [],
        jsonBody: [
          {
            selector: '$.value',
            operator: 'equals',
            target: { value: { type: 'number', value }, sensitive: false },
          },
        ],
      },
      'GET',
    );

    expect(assertions.jsonBody[0]).toMatchObject({
      target: { value: { type: 'number', value: expected } },
    });
  });

  it('allows header assertions but rejects body assertions for HEAD', () => {
    expect(
      parseResponseAssertions(
        {
          headers: [{ name: 'content-type', operator: 'exists' }],
          textBody: [],
          jsonBody: [],
        },
        'HEAD',
      ),
    ).toMatchObject({ headers: [{ name: 'content-type', operator: 'exists' }] });

    expect(() =>
      parseResponseAssertions(
        {
          headers: [],
          textBody: [{ operator: 'contains', target: { value: 'ready', sensitive: false } }],
          jsonBody: [],
        },
        'HEAD',
      ),
    ).toThrowError(new AssertionInputError(['HEAD monitors cannot configure body assertions.']));
  });

  it('requires exact shapes and explicit target sensitivity', () => {
    expect(() =>
      parseResponseAssertions(
        {
          headers: [
            { name: 'x-state', operator: 'exists', target: { value: 'ready', sensitive: false } },
            { name: 'x-state', operator: 'equals', target: { value: 'ready' } },
          ],
          textBody: [
            { operator: 'contains', target: { value: 'ready', sensitive: false }, extra: 1 },
          ],
          jsonBody: [],
        },
        'GET',
      ),
    ).toThrow(AssertionInputError);
  });

  it.each(['NaN', 'Infinity', '+1', '01', '1.', '.5', '1e'])(
    'rejects invalid lossless JSON number target %s',
    (value) => {
      expect(() =>
        parseResponseAssertions(
          {
            headers: [],
            textBody: [],
            jsonBody: [
              {
                selector: '$.value',
                operator: 'equals',
                target: { value: { type: 'number', value }, sensitive: false },
              },
            ],
          },
          'GET',
        ),
      ).toThrow(AssertionInputError);
    },
  );

  it('rejects unknown top-level fields and non-array categories', () => {
    expect(() =>
      parseResponseAssertions({ headers: [], textBody: [], jsonBody: [], groups: [] }, 'GET'),
    ).toThrow(AssertionInputError);
    expect(() =>
      parseResponseAssertions({ headers: {}, textBody: [], jsonBody: [] }, 'GET'),
    ).toThrow(AssertionInputError);
  });

  it('rejects configurations beyond the total assertion limit', () => {
    expect(() =>
      parseResponseAssertions(
        {
          headers: Array.from({ length: ASSERTION_LIMITS.maxAssertions + 1 }, (_, index) => ({
            name: `x-${index}`,
            operator: 'exists',
          })),
          textBody: [],
          jsonBody: [],
        },
        'GET',
      ),
    ).toThrow(AssertionInputError);
  });

  it('rejects oversized targets, selectors, selector depth, and number components', () => {
    const parseJsonTarget = (selector: string, value: { type: string; value?: string }) =>
      parseResponseAssertions(
        {
          headers: [],
          textBody: [],
          jsonBody: [{ selector, operator: 'equals', target: { value, sensitive: false } }],
        },
        'GET',
      );

    expect(() =>
      parseResponseAssertions(
        {
          headers: [],
          textBody: [
            {
              operator: 'equals',
              target: {
                value: 'x'.repeat(ASSERTION_LIMITS.maxTargetLength + 1),
                sensitive: false,
              },
            },
          ],
          jsonBody: [],
        },
        'GET',
      ),
    ).toThrow(AssertionInputError);
    expect(() =>
      parseJsonTarget(`$['${'x'.repeat(ASSERTION_LIMITS.maxSelectorLength)}']`, { type: 'null' }),
    ).toThrow(AssertionInputError);
    expect(() =>
      parseJsonTarget(`$${'.value'.repeat(ASSERTION_LIMITS.maxSelectorDepth + 1)}`, {
        type: 'null',
      }),
    ).toThrow(AssertionInputError);
    expect(() =>
      parseJsonTarget('$.value', {
        type: 'number',
        value: '1'.repeat(ASSERTION_LIMITS.maxJsonNumberDigits + 1),
      }),
    ).toThrow(AssertionInputError);
    expect(() =>
      parseJsonTarget('$.value', {
        type: 'number',
        value: `1e${'9'.repeat(ASSERTION_LIMITS.maxJsonExponentDigits + 1)}`,
      }),
    ).toThrow(AssertionInputError);
  });
});

describe('isValidJsonSelector', () => {
  it.each([
    '$',
    '$.status',
    '$.database.connected',
    '$.items[0].id',
    "$['key-with-dashes']",
    "$['escaped\\nproperty']",
    "$['single\\'quote']",
  ])('accepts selector %s', (selector) => {
    expect(isValidJsonSelector(selector)).toBe(true);
  });

  it.each([
    '',
    'status',
    '$.',
    '$.0invalid',
    '$[01]',
    '$[-1]',
    '$[*]',
    '$..status',
    '$[0:2]',
    '$[?(@.ready)]',
    '$["double-quoted"]',
    "$['unterminated]",
    "$['bad\\xescape']",
  ])('rejects selector %s', (selector) => {
    expect(isValidJsonSelector(selector)).toBe(false);
  });
});
