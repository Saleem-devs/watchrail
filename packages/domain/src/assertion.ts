import type { HttpMonitorMethod } from './monitor.js';

export const HEADER_ASSERTION_OPERATORS = [
  'exists',
  'does_not_exist',
  'equals',
  'not_equals',
  'contains',
  'not_contains',
] as const;
export const TEXT_BODY_ASSERTION_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
] as const;
export const JSON_BODY_ASSERTION_OPERATORS = [
  'exists',
  'does_not_exist',
  'equals',
  'not_equals',
] as const;
export const ASSERTION_OUTCOMES = ['PASS', 'FAIL', 'NOT_EVALUATED'] as const;
export const ASSERTION_LIMITS = {
  maxAssertions: 32,
  maxTargetLength: 4_096,
  maxSelectorLength: 512,
  maxSelectorDepth: 32,
  maxJsonNumberDigits: 256,
  maxAbsoluteJsonExponent: 1_000_255,
  maxEncryptedValueBytes: 4_352,
} as const;

export type HeaderAssertionOperator = (typeof HEADER_ASSERTION_OPERATORS)[number];
export type TextBodyAssertionOperator = (typeof TEXT_BODY_ASSERTION_OPERATORS)[number];
export type JsonBodyAssertionOperator = (typeof JSON_BODY_ASSERTION_OPERATORS)[number];
export type AssertionOutcome = (typeof ASSERTION_OUTCOMES)[number];

export interface SensitiveStringTarget {
  value: string;
  sensitive: boolean;
}

export type HeaderAssertion =
  | { name: string; operator: 'exists' | 'does_not_exist' }
  | {
      name: string;
      operator: 'equals' | 'not_equals' | 'contains' | 'not_contains';
      target: SensitiveStringTarget;
    };

export interface TextBodyAssertion {
  operator: TextBodyAssertionOperator;
  target: SensitiveStringTarget;
}

export type JsonScalarTarget =
  | { type: 'string'; value: string }
  | { type: 'number'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'null' };

export interface SensitiveJsonTarget {
  value: JsonScalarTarget;
  sensitive: boolean;
}

export type JsonBodyAssertion =
  | { selector: string; operator: 'exists' | 'does_not_exist' }
  | {
      selector: string;
      operator: 'equals' | 'not_equals';
      target: SensitiveJsonTarget;
    };

export interface ResponseAssertions {
  headers: HeaderAssertion[];
  textBody: TextBodyAssertion[];
  jsonBody: JsonBodyAssertion[];
}

export type AssertionDiagnosticReason =
  | 'MATCHED'
  | 'HEADER_MISMATCH'
  | 'TEXT_BODY_MISMATCH'
  | 'JSON_BODY_MISMATCH'
  | 'INVALID_JSON'
  | 'DUPLICATE_JSON_KEY'
  | 'JSON_TYPE_UNSUPPORTED'
  | 'UNSUPPORTED_CONTENT_ENCODING'
  | 'UNSUPPORTED_CHARSET'
  | 'BODY_TOO_LARGE'
  | 'BODY_READ_FAILED'
  | 'RESPONSE_UNAVAILABLE';

export interface AssertionDiagnostic {
  index: number;
  source: 'HEADER' | 'TEXT_BODY' | 'JSON_BODY';
  subject: string | null;
  operator: HeaderAssertionOperator | TextBodyAssertionOperator | JsonBodyAssertionOperator;
  outcome: AssertionOutcome;
  reason: AssertionDiagnosticReason;
}

export class AssertionInputError extends Error {
  constructor(readonly issues: string[]) {
    super('Response assertions are invalid.');
    this.name = 'AssertionInputError';
  }
}

const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const JSON_NUMBER = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/;
const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_CONTINUE = /[A-Za-z0-9_]/;

export function parseResponseAssertions(
  value: unknown,
  method: HttpMonitorMethod,
): ResponseAssertions {
  if (value === undefined) return { headers: [], textBody: [], jsonBody: [] };
  if (!isRecord(value) || !hasExactKeys(value, ['headers', 'textBody', 'jsonBody'])) {
    throw new AssertionInputError([
      'Provide exactly headers, textBody, and jsonBody assertion arrays.',
    ]);
  }

  const issues: string[] = [];
  const totalAssertions =
    (Array.isArray(value.headers) ? value.headers.length : 0) +
    (Array.isArray(value.textBody) ? value.textBody.length : 0) +
    (Array.isArray(value.jsonBody) ? value.jsonBody.length : 0);
  if (totalAssertions > ASSERTION_LIMITS.maxAssertions) {
    throw new AssertionInputError([
      `Configure at most ${ASSERTION_LIMITS.maxAssertions} assertions.`,
    ]);
  }
  const headers = parseArray(value.headers, 'Header assertions', issues, parseHeaderAssertion);
  const textBody = parseArray(
    value.textBody,
    'Text-body assertions',
    issues,
    parseTextBodyAssertion,
  );
  const jsonBody = parseArray(
    value.jsonBody,
    'JSON-body assertions',
    issues,
    parseJsonBodyAssertion,
  );

  try {
    assertAssertionsCompatibleWithMethod(method, { textBody, jsonBody });
  } catch (error) {
    if (error instanceof AssertionInputError) issues.push(...error.issues);
    else throw error;
  }
  if (issues.length > 0) throw new AssertionInputError(issues);

  return { headers, textBody, jsonBody };
}

export function assertAssertionsCompatibleWithMethod(
  method: HttpMonitorMethod,
  assertions: { textBody: readonly unknown[]; jsonBody: readonly unknown[] },
): void {
  if (method === 'HEAD' && (assertions.textBody.length > 0 || assertions.jsonBody.length > 0)) {
    throw new AssertionInputError(['HEAD monitors cannot configure body assertions.']);
  }
}

export function isValidJsonSelector(selector: string): boolean {
  if (!selector.startsWith('$') || selector.length > ASSERTION_LIMITS.maxSelectorLength)
    return false;
  let index = 1;
  let depth = 0;

  while (index < selector.length) {
    depth += 1;
    if (depth > ASSERTION_LIMITS.maxSelectorDepth) return false;
    if (selector[index] === '.') {
      index += 1;
      if (!isCharacter(selector[index], IDENTIFIER_START)) return false;
      index += 1;
      while (isCharacter(selector[index], IDENTIFIER_CONTINUE)) index += 1;
      continue;
    }

    if (selector[index] !== '[') return false;
    index += 1;

    if (selector[index] === "'") {
      const parsed = consumeQuotedProperty(selector, index + 1);
      if (parsed === null) return false;
      index = parsed;
      continue;
    }

    const start = index;
    while (isDigit(selector[index])) index += 1;
    const digits = selector.slice(start, index);
    if (digits.length === 0 || (digits.length > 1 && digits.startsWith('0'))) return false;
    if (selector[index] !== ']') return false;
    index += 1;
  }

  return true;
}

function parseHeaderAssertion(
  value: unknown,
  index: number,
  issues: string[],
): HeaderAssertion | null {
  const label = `Header assertion ${index + 1}`;
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.operator !== 'string') {
    issues.push(`${label} must provide a header name and operator.`);
    return null;
  }

  const name = value.name.trim().toLowerCase();
  if (!HTTP_TOKEN.test(name)) issues.push(`${label} has an invalid header name.`);

  if (value.operator === 'exists' || value.operator === 'does_not_exist') {
    if (!hasExactKeys(value, ['name', 'operator'])) {
      issues.push(`${label} must not provide a target for ${value.operator}.`);
      return null;
    }
    return { name, operator: value.operator };
  }

  if (!isHeaderComparisonOperator(value.operator)) {
    issues.push(`${label} has an unsupported operator.`);
    return null;
  }
  if (!hasExactKeys(value, ['name', 'operator', 'target'])) {
    issues.push(`${label} must provide exactly name, operator, and target.`);
    return null;
  }
  const target = parseSensitiveStringTarget(value.target, label, issues);
  return target === null ? null : { name, operator: value.operator, target };
}

function parseTextBodyAssertion(
  value: unknown,
  index: number,
  issues: string[],
): TextBodyAssertion | null {
  const label = `Text-body assertion ${index + 1}`;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['operator', 'target']) ||
    !isTextBodyOperator(value.operator)
  ) {
    issues.push(`${label} must provide a supported operator and target.`);
    return null;
  }
  const target = parseSensitiveStringTarget(value.target, label, issues);
  return target === null ? null : { operator: value.operator, target };
}

function parseJsonBodyAssertion(
  value: unknown,
  index: number,
  issues: string[],
): JsonBodyAssertion | null {
  const label = `JSON-body assertion ${index + 1}`;
  if (
    !isRecord(value) ||
    typeof value.selector !== 'string' ||
    !isValidJsonSelector(value.selector)
  ) {
    issues.push(`${label} has an invalid selector.`);
    return null;
  }

  if (value.operator === 'exists' || value.operator === 'does_not_exist') {
    if (!hasExactKeys(value, ['selector', 'operator'])) {
      issues.push(`${label} must not provide a target for ${value.operator}.`);
      return null;
    }
    return { selector: value.selector, operator: value.operator };
  }

  if (
    (value.operator !== 'equals' && value.operator !== 'not_equals') ||
    !hasExactKeys(value, ['selector', 'operator', 'target'])
  ) {
    issues.push(`${label} must provide a supported operator and target.`);
    return null;
  }
  const target = parseSensitiveJsonTarget(value.target, label, issues);
  return target === null ? null : { selector: value.selector, operator: value.operator, target };
}

function parseSensitiveStringTarget(
  value: unknown,
  label: string,
  issues: string[],
): SensitiveStringTarget | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['value', 'sensitive']) ||
    typeof value.value !== 'string' ||
    typeof value.sensitive !== 'boolean' ||
    value.value.length > ASSERTION_LIMITS.maxTargetLength
  ) {
    issues.push(`${label} must provide a string target and explicit sensitivity.`);
    return null;
  }
  return { value: value.value, sensitive: value.sensitive };
}

function parseSensitiveJsonTarget(
  value: unknown,
  label: string,
  issues: string[],
): SensitiveJsonTarget | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['value', 'sensitive']) ||
    typeof value.sensitive !== 'boolean' ||
    !isRecord(value.value) ||
    typeof value.value.type !== 'string'
  ) {
    issues.push(`${label} must provide a typed scalar target and explicit sensitivity.`);
    return null;
  }

  const target = value.value;
  let scalar: JsonScalarTarget | null = null;
  if (target.type === 'null' && hasExactKeys(target, ['type'])) scalar = { type: 'null' };
  if (
    target.type === 'string' &&
    hasExactKeys(target, ['type', 'value']) &&
    typeof target.value === 'string' &&
    target.value.length <= ASSERTION_LIMITS.maxTargetLength
  ) {
    scalar = { type: 'string', value: target.value };
  }
  if (
    target.type === 'boolean' &&
    hasExactKeys(target, ['type', 'value']) &&
    typeof target.value === 'boolean'
  ) {
    scalar = { type: 'boolean', value: target.value };
  }
  if (
    target.type === 'number' &&
    hasExactKeys(target, ['type', 'value']) &&
    typeof target.value === 'string'
  ) {
    const normalized = normalizeJsonNumber(target.value);
    if (normalized !== null) scalar = { type: 'number', value: normalized };
  }

  if (scalar === null) {
    issues.push(`${label} has an invalid typed scalar target.`);
    return null;
  }
  return { value: scalar, sensitive: value.sensitive };
}

function normalizeJsonNumber(value: string): string | null {
  if (value.length > ASSERTION_LIMITS.maxTargetLength) return null;
  const match = JSON_NUMBER.exec(value);
  if (!match) return null;
  const digitCount = (match[2]?.length ?? 0) + (match[3]?.length ?? 0);
  if (digitCount > ASSERTION_LIMITS.maxJsonNumberDigits) return null;

  const rawExponent = match[4] ?? '0';
  const unsignedExponent = rawExponent.replace(/^[+-]/u, '');
  if (unsignedExponent.length > String(ASSERTION_LIMITS.maxAbsoluteJsonExponent).length) {
    return null;
  }

  const sign = match[1] === '-' ? '-' : '';
  const integer = match[2] ?? '';
  const fraction = match[3] ?? '';
  const declaredExponent = BigInt(rawExponent);
  let digits = `${integer}${fraction}`.replace(/^0+/u, '');
  if (digits.length === 0) return '0';

  let exponent = declaredExponent - BigInt(fraction.length);
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    exponent += 1n;
  }

  if (
    exponent < -BigInt(ASSERTION_LIMITS.maxAbsoluteJsonExponent) ||
    exponent > BigInt(ASSERTION_LIMITS.maxAbsoluteJsonExponent)
  ) {
    return null;
  }

  return `${sign}${digits}${exponent === 0n ? '' : `e${exponent}`}`;
}

function consumeQuotedProperty(selector: string, start: number): number | null {
  let index = start;
  let jsonString = '"';
  while (index < selector.length) {
    const character = selector[index];
    if (character === "'") {
      if (selector[index + 1] !== ']') return null;
      try {
        JSON.parse(`${jsonString}"`);
      } catch {
        return null;
      }
      return index + 2;
    }
    if (character === '\\') {
      const next = selector[index + 1];
      if (next === "'") {
        jsonString += "'";
        index += 2;
        continue;
      }
      if (next === undefined) return null;
      jsonString += `\\${next}`;
      index += 2;
      continue;
    }
    if (character === '"') jsonString += '\\"';
    else jsonString += character;
    index += 1;
  }
  return null;
}

function parseArray<T>(
  value: unknown,
  label: string,
  issues: string[],
  parse: (candidate: unknown, index: number, issues: string[]) => T | null,
): T[] {
  if (!Array.isArray(value)) {
    issues.push(`${label} must be an array.`);
    return [];
  }
  return value
    .map((candidate, index) => parse(candidate, index, issues))
    .filter((candidate): candidate is T => candidate !== null);
}

function isHeaderComparisonOperator(
  value: string,
): value is Extract<
  HeaderAssertionOperator,
  'equals' | 'not_equals' | 'contains' | 'not_contains'
> {
  return (
    value === 'equals' || value === 'not_equals' || value === 'contains' || value === 'not_contains'
  );
}

function isTextBodyOperator(value: unknown): value is TextBodyAssertionOperator {
  return (
    typeof value === 'string' &&
    TEXT_BODY_ASSERTION_OPERATORS.includes(value as TextBodyAssertionOperator)
  );
}

function isCharacter(value: string | undefined, expression: RegExp): boolean {
  return value !== undefined && expression.test(value);
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= '0' && value <= '9';
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
