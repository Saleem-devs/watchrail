import {
  ASSERTION_LIMITS,
  isValidJsonSelector,
  type AssertionDiagnostic,
  type AssertionDiagnosticReason,
  type AssertionEvaluationV1,
  type JsonBodyAssertion,
  type JsonScalarTarget,
} from '@watchrail/domain';
import { combineAssertionEvaluations } from './assertion-evaluation.js';
import {
  parseStrictJson,
  type StrictJsonParseResult,
  type StrictJsonValue,
} from './strict-json-parser.js';
import type { HttpBodyCapture } from './types.js';

type UnavailableBodyReason = Extract<
  AssertionDiagnosticReason,
  | 'BODY_TOO_LARGE'
  | 'UNSUPPORTED_CONTENT_ENCODING'
  | 'UNSUPPORTED_CHARSET'
  | 'BODY_READ_FAILED'
  | 'RESPONSE_UNAVAILABLE'
>;

type JsonSelectorSegment = { type: 'PROPERTY'; key: string } | { type: 'INDEX'; digits: string };

type JsonSelectorResolution = { state: 'FOUND'; value: StrictJsonValue } | { state: 'MISSING' };

export function evaluateJsonBodyAssertions(
  assertions: readonly JsonBodyAssertion[],
  body: HttpBodyCapture,
): AssertionEvaluationV1 {
  assertBounded(assertions);
  if (body.state !== 'CAPTURED') {
    return notEvaluateJsonBodyAssertions(
      assertions,
      body.state === 'UNAVAILABLE' ? body.reason : 'RESPONSE_UNAVAILABLE',
    );
  }

  const parsed = parseStrictJson(body.text);
  if (parsed.status === 'FAILED') return failedParseEvaluation(assertions, parsed);

  const diagnostics = assertions.map((assertion, index): AssertionDiagnostic => {
    const resolution = resolveSelector(parsed.value, parseSelector(assertion.selector));
    const result = evaluateAssertion(assertion, resolution);
    return {
      index,
      source: 'JSON_BODY',
      subject: assertion.selector,
      operator: assertion.operator,
      outcome: result.passed ? 'PASS' : 'FAIL',
      reason: result.reason,
    };
  });
  return combineAssertionEvaluations({ contractVersion: 1, outcome: 'PASS', diagnostics });
}

export function notEvaluateJsonBodyAssertions(
  assertions: readonly JsonBodyAssertion[],
  reason: UnavailableBodyReason = 'RESPONSE_UNAVAILABLE',
): AssertionEvaluationV1 {
  assertBounded(assertions);
  return combineAssertionEvaluations({
    contractVersion: 1,
    outcome: 'PASS',
    diagnostics: assertions.map((assertion, index) => ({
      index,
      source: 'JSON_BODY',
      subject: assertion.selector,
      operator: assertion.operator,
      outcome: 'NOT_EVALUATED',
      reason,
    })),
  });
}

function failedParseEvaluation(
  assertions: readonly JsonBodyAssertion[],
  parsed: Extract<StrictJsonParseResult, { status: 'FAILED' }>,
): AssertionEvaluationV1 {
  return combineAssertionEvaluations({
    contractVersion: 1,
    outcome: 'PASS',
    diagnostics: assertions.map((assertion, index) => ({
      index,
      source: 'JSON_BODY',
      subject: assertion.selector,
      operator: assertion.operator,
      outcome: 'FAIL',
      reason: parsed.reason,
    })),
  });
}

function evaluateAssertion(
  assertion: JsonBodyAssertion,
  resolution: JsonSelectorResolution,
): { passed: boolean; reason: 'MATCHED' | 'JSON_BODY_MISMATCH' | 'JSON_TYPE_UNSUPPORTED' } {
  if (assertion.operator === 'exists') {
    const passed = resolution.state === 'FOUND';
    return { passed, reason: passed ? 'MATCHED' : 'JSON_BODY_MISMATCH' };
  }
  if (assertion.operator === 'does_not_exist') {
    const passed = resolution.state === 'MISSING';
    return { passed, reason: passed ? 'MATCHED' : 'JSON_BODY_MISMATCH' };
  }
  if (resolution.state === 'MISSING') {
    return { passed: false, reason: 'JSON_BODY_MISMATCH' };
  }
  if (resolution.value.type === 'object' || resolution.value.type === 'array') {
    return { passed: false, reason: 'JSON_TYPE_UNSUPPORTED' };
  }
  if (!('target' in assertion)) {
    throw new Error('JSON assertion violates the domain contract.');
  }
  const equal = scalarEquals(resolution.value, assertion.target.value);
  const passed = assertion.operator === 'equals' ? equal : !equal;
  return { passed, reason: passed ? 'MATCHED' : 'JSON_BODY_MISMATCH' };
}

function scalarEquals(actual: StrictJsonValue, expected: JsonScalarTarget): boolean {
  switch (expected.type) {
    case 'string':
      return actual.type === 'string' && actual.value === expected.value;
    case 'number':
      return actual.type === 'number' && actual.value === expected.value;
    case 'boolean':
      return actual.type === 'boolean' && actual.value === expected.value;
    case 'null':
      return actual.type === 'null';
  }
}

function resolveSelector(
  root: StrictJsonValue,
  segments: readonly JsonSelectorSegment[],
): JsonSelectorResolution {
  let current = root;
  for (const segment of segments) {
    if (segment.type === 'PROPERTY') {
      if (current.type !== 'object') return { state: 'MISSING' };
      const member = current.members.find((candidate) => candidate.key === segment.key);
      if (member === undefined) return { state: 'MISSING' };
      current = member.value;
      continue;
    }
    if (current.type !== 'array') return { state: 'MISSING' };
    const index = resolveArrayIndex(segment.digits, current.items.length);
    if (index === null) return { state: 'MISSING' };
    const item = current.items[index];
    if (item === undefined) return { state: 'MISSING' };
    current = item;
  }
  return { state: 'FOUND', value: current };
}

function resolveArrayIndex(digits: string, length: number): number | null {
  let index = 0;
  for (let offset = 0; offset < digits.length; offset += 1) {
    index = index * 10 + (digits.charCodeAt(offset) - 48);
    if (index >= length) return null;
  }
  return index;
}

function parseSelector(selector: string): JsonSelectorSegment[] {
  if (!isValidJsonSelector(selector)) {
    throw new Error('JSON assertion selector violates the domain contract.');
  }
  const segments: JsonSelectorSegment[] = [];
  let index = 1;
  while (index < selector.length) {
    if (selector[index] === '.') {
      const start = ++index;
      while (index < selector.length && /[A-Za-z0-9_]/u.test(selector[index] ?? '')) index += 1;
      segments.push({ type: 'PROPERTY', key: selector.slice(start, index) });
      continue;
    }
    index += 1;
    if (selector[index] === "'") {
      const parsed = parseQuotedProperty(selector, index + 1);
      segments.push({ type: 'PROPERTY', key: parsed.key });
      index = parsed.nextIndex;
      continue;
    }
    const start = index;
    while (selector[index] !== ']') index += 1;
    segments.push({ type: 'INDEX', digits: selector.slice(start, index) });
    index += 1;
  }
  return segments;
}

function parseQuotedProperty(selector: string, start: number): { key: string; nextIndex: number } {
  let index = start;
  let key = '';
  while (index < selector.length) {
    const character = selector[index];
    if (character === "'") return { key, nextIndex: index + 2 };
    if (character !== '\\') {
      key += character;
      index += 1;
      continue;
    }
    const escape = selector[index + 1];
    if (escape === "'") {
      key += "'";
      index += 2;
      continue;
    }
    if (escape === 'u') {
      const high = parseHexCodeUnit(selector, index + 2);
      index += 6;
      if (high >= 0xd800 && high <= 0xdbff) {
        const low = parseHexCodeUnit(selector, index + 2);
        key += String.fromCodePoint(0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00));
        index += 6;
      } else {
        key += String.fromCharCode(high);
      }
      continue;
    }
    const decoded = decodeSimpleEscape(escape);
    key += decoded;
    index += 2;
  }
  throw new Error('JSON assertion selector violates the domain contract.');
}

function parseHexCodeUnit(selector: string, start: number): number {
  return Number.parseInt(selector.slice(start, start + 4), 16);
}

function decodeSimpleEscape(escape: string | undefined): string {
  switch (escape) {
    case '"':
    case '\\':
    case '/':
      return escape;
    case 'b':
      return '\b';
    case 'f':
      return '\f';
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    default:
      throw new Error('JSON assertion selector violates the domain contract.');
  }
}

function assertBounded(assertions: readonly JsonBodyAssertion[]): void {
  if (assertions.length > ASSERTION_LIMITS.maxAssertions) {
    throw new Error(`Cannot evaluate more than ${ASSERTION_LIMITS.maxAssertions} assertions.`);
  }
}
