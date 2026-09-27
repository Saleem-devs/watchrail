import {
  ASSERTION_LIMITS,
  ASSERTION_OUTCOMES,
  HEADER_ASSERTION_OPERATORS,
  JSON_BODY_ASSERTION_OPERATORS,
  TEXT_BODY_ASSERTION_OPERATORS,
  isValidJsonSelector,
  parseResponseAssertions,
  type AssertionDiagnostic,
  type AssertionDiagnosticReason,
  type AssertionOutcome,
  type HeaderAssertionOperator,
  type JsonBodyAssertionOperator,
  type JsonScalarTarget,
  type TextBodyAssertionOperator,
} from './assertion.js';

export interface EncryptedAssertionValueV1 {
  version: 1;
  algorithm: 'AES-256-GCM';
  keyId: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export type StoredStringAssertionTarget =
  | { sensitive: false; value: string }
  | { sensitive: true; encryptedValue: EncryptedAssertionValueV1 };

export type StoredJsonAssertionTarget =
  | { sensitive: false; value: JsonScalarTarget }
  | { sensitive: true; encryptedValue: EncryptedAssertionValueV1 };

export type StoredHeaderAssertion =
  | { name: string; operator: 'exists' | 'does_not_exist' }
  | {
      name: string;
      operator: 'equals' | 'not_equals' | 'contains' | 'not_contains';
      target: StoredStringAssertionTarget;
    };

export interface StoredTextBodyAssertion {
  operator: TextBodyAssertionOperator;
  target: StoredStringAssertionTarget;
}

export type StoredJsonBodyAssertion =
  | { selector: string; operator: 'exists' | 'does_not_exist' }
  | {
      selector: string;
      operator: 'equals' | 'not_equals';
      target: StoredJsonAssertionTarget;
    };

export interface StoredResponseAssertionsV1 {
  headers: StoredHeaderAssertion[];
  textBody: StoredTextBodyAssertion[];
  jsonBody: StoredJsonBodyAssertion[];
}

export interface ResponseAssertionConfigurationV1 {
  contractVersion: 1;
  assertions: StoredResponseAssertionsV1;
}

export interface AssertionEvaluationV1 {
  contractVersion: 1;
  outcome: AssertionOutcome;
  diagnostics: AssertionDiagnostic[];
}

export class StoredAssertionContractError extends Error {
  constructor() {
    super('Stored assertion data violates the versioned persistence contract.');
    this.name = 'StoredAssertionContractError';
  }
}

const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const DIAGNOSTIC_REASONS = new Set<AssertionDiagnosticReason>([
  'MATCHED',
  'HEADER_MISMATCH',
  'TEXT_BODY_MISMATCH',
  'JSON_BODY_MISMATCH',
  'INVALID_JSON',
  'DUPLICATE_JSON_KEY',
  'JSON_TYPE_UNSUPPORTED',
  'UNSUPPORTED_CONTENT_ENCODING',
  'UNSUPPORTED_CHARSET',
  'BODY_TOO_LARGE',
  'RESPONSE_UNAVAILABLE',
]);

export function parseStoredAssertionConfiguration(
  value: unknown,
): ResponseAssertionConfigurationV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['contractVersion', 'assertions']) ||
    value.contractVersion !== 1
  ) {
    throw new StoredAssertionContractError();
  }

  return { contractVersion: 1, assertions: parseStoredAssertions(value.assertions) };
}

export function parseStoredAssertionEvaluation(value: unknown): AssertionEvaluationV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['contractVersion', 'outcome', 'diagnostics']) ||
    value.contractVersion !== 1 ||
    !isAssertionOutcome(value.outcome) ||
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length > ASSERTION_LIMITS.maxAssertions
  ) {
    throw new StoredAssertionContractError();
  }

  const diagnostics = value.diagnostics.map(parseDiagnostic);
  const identities = new Set<string>();
  for (const diagnostic of diagnostics) {
    const identity = `${diagnostic.source}:${diagnostic.index}`;
    if (identities.has(identity)) throw new StoredAssertionContractError();
    identities.add(identity);
  }

  return { contractVersion: 1, outcome: value.outcome, diagnostics };
}

function parseStoredAssertions(value: unknown): StoredResponseAssertionsV1 {
  if (!isRecord(value) || !hasExactKeys(value, ['headers', 'textBody', 'jsonBody'])) {
    throw new StoredAssertionContractError();
  }
  if (
    !Array.isArray(value.headers) ||
    !Array.isArray(value.textBody) ||
    !Array.isArray(value.jsonBody)
  ) {
    throw new StoredAssertionContractError();
  }
  if (
    value.headers.length + value.textBody.length + value.jsonBody.length >
    ASSERTION_LIMITS.maxAssertions
  ) {
    throw new StoredAssertionContractError();
  }

  return {
    headers: value.headers.map(parseStoredHeaderAssertion),
    textBody: value.textBody.map(parseStoredTextBodyAssertion),
    jsonBody: value.jsonBody.map(parseStoredJsonBodyAssertion),
  };
}

function parseStoredHeaderAssertion(value: unknown): StoredHeaderAssertion {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    value.name !== value.name.toLowerCase() ||
    !HTTP_TOKEN.test(value.name)
  ) {
    throw new StoredAssertionContractError();
  }
  if (value.operator === 'exists' || value.operator === 'does_not_exist') {
    if (!hasExactKeys(value, ['name', 'operator'])) throw new StoredAssertionContractError();
    return { name: value.name, operator: value.operator };
  }
  if (
    !isHeaderComparisonOperator(value.operator) ||
    !hasExactKeys(value, ['name', 'operator', 'target'])
  ) {
    throw new StoredAssertionContractError();
  }
  return {
    name: value.name,
    operator: value.operator,
    target: parseStoredStringTarget(value.target),
  };
}

function parseStoredTextBodyAssertion(value: unknown): StoredTextBodyAssertion {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['operator', 'target']) ||
    !isTextBodyOperator(value.operator)
  ) {
    throw new StoredAssertionContractError();
  }
  return { operator: value.operator, target: parseStoredStringTarget(value.target) };
}

function parseStoredJsonBodyAssertion(value: unknown): StoredJsonBodyAssertion {
  if (
    !isRecord(value) ||
    typeof value.selector !== 'string' ||
    !isValidJsonSelector(value.selector)
  ) {
    throw new StoredAssertionContractError();
  }
  if (value.operator === 'exists' || value.operator === 'does_not_exist') {
    if (!hasExactKeys(value, ['selector', 'operator'])) throw new StoredAssertionContractError();
    return { selector: value.selector, operator: value.operator };
  }
  if (
    (value.operator !== 'equals' && value.operator !== 'not_equals') ||
    !hasExactKeys(value, ['selector', 'operator', 'target'])
  ) {
    throw new StoredAssertionContractError();
  }
  return {
    selector: value.selector,
    operator: value.operator,
    target: parseStoredJsonTarget(value.target),
  };
}

function parseStoredStringTarget(value: unknown): StoredStringAssertionTarget {
  if (!isRecord(value)) throw new StoredAssertionContractError();
  if (
    value.sensitive === false &&
    hasExactKeys(value, ['sensitive', 'value']) &&
    typeof value.value === 'string' &&
    value.value.length <= ASSERTION_LIMITS.maxTargetLength
  ) {
    return { sensitive: false, value: value.value };
  }
  if (
    value.sensitive === true &&
    hasExactKeys(value, ['sensitive', 'encryptedValue']) &&
    isEncryptedValue(value.encryptedValue)
  ) {
    return { sensitive: true, encryptedValue: value.encryptedValue };
  }
  throw new StoredAssertionContractError();
}

function parseStoredJsonTarget(value: unknown): StoredJsonAssertionTarget {
  if (!isRecord(value)) throw new StoredAssertionContractError();
  if (value.sensitive === true) {
    if (
      !hasExactKeys(value, ['sensitive', 'encryptedValue']) ||
      !isEncryptedValue(value.encryptedValue)
    ) {
      throw new StoredAssertionContractError();
    }
    return { sensitive: true, encryptedValue: value.encryptedValue };
  }
  if (value.sensitive !== false || !hasExactKeys(value, ['sensitive', 'value'])) {
    throw new StoredAssertionContractError();
  }

  try {
    const parsed = parseResponseAssertions(
      {
        headers: [],
        textBody: [],
        jsonBody: [
          { selector: '$', operator: 'equals', target: { sensitive: false, value: value.value } },
        ],
      },
      'GET',
    ).jsonBody[0];
    if (!parsed || !('target' in parsed)) throw new StoredAssertionContractError();
    return { sensitive: false, value: parsed.target.value };
  } catch {
    throw new StoredAssertionContractError();
  }
}

function parseDiagnostic(value: unknown): AssertionDiagnostic {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['index', 'source', 'subject', 'operator', 'outcome', 'reason']) ||
    !Number.isInteger(value.index) ||
    (value.index as number) < 0 ||
    (value.index as number) >= ASSERTION_LIMITS.maxAssertions ||
    !isAssertionOutcome(value.outcome) ||
    !DIAGNOSTIC_REASONS.has(value.reason as AssertionDiagnosticReason)
  ) {
    throw new StoredAssertionContractError();
  }

  if (
    value.source === 'HEADER' &&
    typeof value.subject === 'string' &&
    value.subject === value.subject.toLowerCase() &&
    HTTP_TOKEN.test(value.subject) &&
    isHeaderOperator(value.operator)
  ) {
    return diagnostic(value, value.source, value.subject, value.operator);
  }
  if (
    value.source === 'TEXT_BODY' &&
    value.subject === null &&
    isTextBodyOperator(value.operator)
  ) {
    return diagnostic(value, value.source, null, value.operator);
  }
  if (
    value.source === 'JSON_BODY' &&
    typeof value.subject === 'string' &&
    isValidJsonSelector(value.subject) &&
    isJsonBodyOperator(value.operator)
  ) {
    return diagnostic(value, value.source, value.subject, value.operator);
  }
  throw new StoredAssertionContractError();
}

function diagnostic(
  value: Record<string, unknown>,
  source: AssertionDiagnostic['source'],
  subject: string | null,
  operator: AssertionDiagnostic['operator'],
): AssertionDiagnostic {
  return {
    index: value.index as number,
    source,
    subject,
    operator,
    outcome: value.outcome as AssertionOutcome,
    reason: value.reason as AssertionDiagnosticReason,
  };
}

function isEncryptedValue(value: unknown): value is EncryptedAssertionValueV1 {
  const ciphertextLength =
    isRecord(value) &&
    typeof value.ciphertext === 'string' &&
    value.ciphertext.length <= Math.ceil((ASSERTION_LIMITS.maxEncryptedValueBytes * 4) / 3)
      ? base64UrlByteLength(value.ciphertext)
      : null;
  return (
    isRecord(value) &&
    hasExactKeys(value, ['version', 'algorithm', 'keyId', 'iv', 'ciphertext', 'authTag']) &&
    value.version === 1 &&
    value.algorithm === 'AES-256-GCM' &&
    typeof value.keyId === 'string' &&
    value.keyId.length > 0 &&
    value.keyId.length <= 120 &&
    typeof value.iv === 'string' &&
    base64UrlByteLength(value.iv) === 12 &&
    typeof value.ciphertext === 'string' &&
    ciphertextLength !== null &&
    ciphertextLength <= ASSERTION_LIMITS.maxEncryptedValueBytes &&
    typeof value.authTag === 'string' &&
    base64UrlByteLength(value.authTag) === 16
  );
}

function isAssertionOutcome(value: unknown): value is AssertionOutcome {
  return typeof value === 'string' && ASSERTION_OUTCOMES.includes(value as AssertionOutcome);
}

function isHeaderOperator(value: unknown): value is HeaderAssertionOperator {
  return (
    typeof value === 'string' &&
    HEADER_ASSERTION_OPERATORS.includes(value as HeaderAssertionOperator)
  );
}

function isHeaderComparisonOperator(
  value: unknown,
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

function isJsonBodyOperator(value: unknown): value is JsonBodyAssertionOperator {
  return (
    typeof value === 'string' &&
    JSON_BODY_ASSERTION_OPERATORS.includes(value as JsonBodyAssertionOperator)
  );
}

function base64UrlByteLength(value: string): number | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) return null;
  try {
    const padded = value
      .replace(/-/gu, '+')
      .replace(/_/gu, '/')
      .padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
    const decoded = atob(padded);
    const canonical = btoa(decoded).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
    return canonical === value ? decoded.length : null;
  } catch {
    return null;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
