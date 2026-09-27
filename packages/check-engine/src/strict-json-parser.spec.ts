import { describe, expect, it } from 'vitest';
import { parseStrictJson, STRICT_JSON_LIMITS } from './strict-json-parser.js';

describe('parseStrictJson', () => {
  it.each([
    ['"watchrail"', { type: 'string', value: 'watchrail' }],
    ['9007199254740993', { type: 'number', value: '9007199254740993' }],
    ['true', { type: 'boolean', value: true }],
    ['false', { type: 'boolean', value: false }],
    ['null', { type: 'null' }],
    ['[]', { type: 'array', items: [] }],
    ['{}', { type: 'object', members: [] }],
  ] as const)('parses top-level %s without type coercion', (source, value) => {
    expect(parseStrictJson(source)).toEqual({ status: 'PARSED', value });
  });

  it('parses nested arrays and ordered object members', () => {
    expect(parseStrictJson('{"ready":true,"items":[null,{"id":"one"}]}')).toEqual({
      status: 'PARSED',
      value: {
        type: 'object',
        members: [
          { key: 'ready', value: { type: 'boolean', value: true } },
          {
            key: 'items',
            value: {
              type: 'array',
              items: [
                { type: 'null' },
                {
                  type: 'object',
                  members: [{ key: 'id', value: { type: 'string', value: 'one' } }],
                },
              ],
            },
          },
        ],
      },
    });
  });

  it.each(['1', '1.0', '1e0', '1.00e+00'])('canonicalizes %s as the same number', (source) => {
    expect(parseStrictJson(source)).toEqual({
      status: 'PARSED',
      value: { type: 'number', value: '1' },
    });
  });

  it.each(['0', '-0', '-0.0', '0e999999999999999999999'])('canonicalizes %s as zero', (source) => {
    expect(parseStrictJson(source)).toEqual({
      status: 'PARSED',
      value: { type: 'number', value: '0' },
    });
  });

  it.each([
    ['1e999999999999999999999999999999', '1e999999999999999999999999999999'],
    ['1e-999999999999999999999999999999', '1e-999999999999999999999999999999'],
    ['10.00e999999999999999999999999999999', '1e1000000000000000000000000000000'],
    ['0.00100e-999999999999999999999999999999', '1e-1000000000000000000000000000002'],
  ])('canonicalizes unbounded exponent %s losslessly', (source, expected) => {
    expect(parseStrictJson(source)).toEqual({
      status: 'PARSED',
      value: { type: 'number', value: expected },
    });
  });

  it('canonicalizes a near-body-limit coefficient with trailing zeroes', () => {
    const trailingZeroes = 250_000;
    expect(parseStrictJson(`1${'0'.repeat(trailingZeroes)}`)).toEqual({
      status: 'PARSED',
      value: { type: 'number', value: `1e${trailingZeroes}` },
    });
  });

  it.each(['', '-'])('canonicalizes a near-body-limit %s exponent', (sign) => {
    const exponent = `${sign}${'9'.repeat(250_000)}`;
    expect(parseStrictJson(`1e${exponent}`)).toEqual({
      status: 'PARSED',
      value: { type: 'number', value: `1e${exponent}` },
    });
  });

  it('handles a near-body-limit fraction requiring exponent subtraction', () => {
    const fractionZeroes = 249_000;
    expect(parseStrictJson(`0.${'0'.repeat(fractionZeroes)}1`)).toEqual({
      status: 'PARSED',
      value: { type: 'number', value: `1e-${fractionZeroes + 1}` },
    });
  });

  it('handles large exponent and fraction operands without iterative prepending', () => {
    const fractionZeroes = 124_000;
    const exponent = `1${'0'.repeat(124_000)}`;
    expect(parseStrictJson(`0.${'0'.repeat(fractionZeroes)}1e${exponent}`)).toMatchObject({
      status: 'PARSED',
      value: { type: 'number' },
    });
  });

  it.each([
    ['{"a":1,"a":2}', 'direct'],
    ['{"outer":{"secret":1,"secret":2}}', 'nested'],
    [String.raw`{"a":1,"\u0061":2}`, 'decoded key'],
    [String.raw`{"a/b":1,"a\/b":2}`, 'escaped slash'],
    [`{"😀":1,"${String.raw`\uD83D\uDE00`}":2}`, 'surrogate pair'],
    [String.raw`{"outer":{"secret":1,"\u0073ecret":2}}`, 'nested decoded key'],
  ])('rejects %s duplicate keys', (source) => {
    expect(parseStrictJson(source)).toEqual({ status: 'FAILED', reason: 'DUPLICATE_JSON_KEY' });
  });

  it('allows the same key in different objects without Unicode normalization', () => {
    expect(parseStrictJson(String.raw`[{"é":1},{"e\u0301":2},{"a":3}]`)).toMatchObject({
      status: 'PARSED',
    });
  });

  it('decodes a valid escaped surrogate pair', () => {
    expect(parseStrictJson(String.raw`"\uD83D\uDE00"`)).toEqual({
      status: 'PARSED',
      value: { type: 'string', value: '😀' },
    });
  });

  it.each([
    String.raw`"\u12G4"`,
    String.raw`"\uD83D"`,
    String.raw`"\uDE00"`,
    String.raw`"\uD83D\u0041"`,
    `"${String.fromCharCode(0xd83d)}"`,
    `"${String.fromCharCode(0xde00)}"`,
  ])('rejects malformed Unicode string %#', (source) => {
    expectInvalid(source);
  });

  it.each([
    '01',
    '+1',
    '1.',
    '.1',
    '[1,]',
    '{"a":1,}',
    '{"a" 1}',
    '{"a":1 "b":2}',
    'true false',
    'null secret',
    'undefined',
    '"unterminated',
    '"line\nbreak"',
  ])('rejects invalid syntax %s', (source) => {
    expectInvalid(source);
  });

  it('accepts the exact depth limit and rejects one additional container', () => {
    expect(parseStrictJson(nestedArrays(STRICT_JSON_LIMITS.maxDepth))).toMatchObject({
      status: 'PARSED',
    });
    expectInvalid(nestedArrays(STRICT_JSON_LIMITS.maxDepth + 1));
  });

  it('accepts and rejects the per-array item boundary', () => {
    expect(parseStrictJson(jsonArray(STRICT_JSON_LIMITS.maxArrayLength))).toMatchObject({
      status: 'PARSED',
    });
    expectInvalid(jsonArray(STRICT_JSON_LIMITS.maxArrayLength + 1));
  });

  it('accepts and rejects the per-object member boundary', () => {
    expect(parseStrictJson(jsonObject(STRICT_JSON_LIMITS.maxObjectMembers))).toMatchObject({
      status: 'PARSED',
    });
    expectInvalid(jsonObject(STRICT_JSON_LIMITS.maxObjectMembers + 1));
  });

  it('accepts the exact token budget and rejects one additional token', () => {
    expect(parseStrictJson(tokenBudgetDocument(STRICT_JSON_LIMITS.maxTokens))).toMatchObject({
      status: 'PARSED',
    });
    expectInvalid(tokenBudgetDocument(STRICT_JSON_LIMITS.maxTokens + 1));
  });

  it('returns value-free failures without exposing body secrets', () => {
    const secret = 'WATCHRAIL_JSON_BODY_SECRET';
    const result = parseStrictJson(`{"${secret}":1,"${secret}":2}`);

    expect(result).toEqual({ status: 'FAILED', reason: 'DUPLICATE_JSON_KEY' });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(() => parseStrictJson(`{"value":"${secret}"`)).not.toThrow();
  });
});

function expectInvalid(source: string): void {
  expect(parseStrictJson(source)).toEqual({ status: 'FAILED', reason: 'INVALID_JSON' });
}

function nestedArrays(depth: number): string {
  return `${'['.repeat(depth)}null${']'.repeat(depth)}`;
}

function jsonArray(length: number): string {
  return `[${Array.from({ length }, () => 'null').join(',')}]`;
}

function jsonObject(length: number): string {
  return `{${Array.from({ length }, (_, index) => `"k${index}":null`).join(',')}}`;
}

function tokenBudgetDocument(tokens: number): string {
  // Root array + eight child arrays + their scalar values.
  const containerTokens = 9;
  const scalarTokens = tokens - containerTokens;
  const lengths = Array.from({ length: 8 }, (_, index) =>
    index < 7
      ? STRICT_JSON_LIMITS.maxArrayLength
      : scalarTokens - 7 * STRICT_JSON_LIMITS.maxArrayLength,
  );
  return `[${lengths.map((length) => jsonArray(length)).join(',')}]`;
}
