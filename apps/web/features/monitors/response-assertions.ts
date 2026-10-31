import type {
  HeaderAssertionOperator,
  JsonBodyAssertionOperator,
  JsonScalarTarget,
  TextBodyAssertionOperator,
} from '@watchrail/domain';

export type AssertionSource = 'HEADER' | 'TEXT_BODY' | 'JSON_BODY';
export type AssertionOperator =
  HeaderAssertionOperator | TextBodyAssertionOperator | JsonBodyAssertionOperator;
export type JsonTargetType = JsonScalarTarget['type'];

export interface ResponseAssertionRow {
  id: string;
  source: AssertionSource;
  subject: string;
  operator: AssertionOperator;
  targetType: JsonTargetType;
  targetValue: string;
  sensitive: boolean;
  retainSensitive: boolean;
}

interface MaskedTarget {
  sensitive: true;
  hasValue: true;
}

interface PlainStringTarget {
  sensitive: false;
  value: string;
}

interface PlainJsonTarget {
  sensitive: false;
  value: JsonScalarTarget;
}

export interface RedactedResponseAssertionConfiguration {
  contractVersion: 1;
  assertions: {
    headers: Array<{
      name: string;
      operator: HeaderAssertionOperator;
      target?: MaskedTarget | PlainStringTarget;
    }>;
    textBody: Array<{
      operator: TextBodyAssertionOperator;
      target: MaskedTarget | PlainStringTarget;
    }>;
    jsonBody: Array<{
      selector: string;
      operator: JsonBodyAssertionOperator;
      target?: MaskedTarget | PlainJsonTarget;
    }>;
  };
}

export type SerializedResponseAssertions = Record<string, unknown> & {
  headers: Array<Record<string, unknown>>;
  textBody: Array<Record<string, unknown>>;
  jsonBody: Array<Record<string, unknown>>;
};

export const ASSERTION_MAX_COUNT = 32;

export function responseAssertionRows(
  configuration: RedactedResponseAssertionConfiguration | undefined,
): ResponseAssertionRow[] {
  if (!configuration) return [];
  const { assertions } = configuration;
  return [
    ...assertions.headers.map((assertion, index) =>
      rowFromStringTarget(
        `header-${index}`,
        'HEADER',
        assertion.name,
        assertion.operator,
        assertion.target,
      ),
    ),
    ...assertions.textBody.map((assertion, index) =>
      rowFromStringTarget(`text-${index}`, 'TEXT_BODY', '', assertion.operator, assertion.target),
    ),
    ...assertions.jsonBody.map((assertion, index) => {
      const target = assertion.target;
      const masked = isMaskedTarget(target);
      const value = !masked && target ? target.value : { type: 'string' as const, value: '' };
      return {
        id: `json-${index}`,
        source: 'JSON_BODY' as const,
        subject: assertion.selector,
        operator: assertion.operator,
        targetType: value.type,
        targetValue:
          value.type === 'boolean' ? String(value.value) : value.type === 'null' ? '' : value.value,
        sensitive: masked,
        retainSensitive: masked,
      };
    }),
  ];
}

export function serializeResponseAssertions(
  rows: readonly ResponseAssertionRow[],
): SerializedResponseAssertions {
  const result: SerializedResponseAssertions = { headers: [], textBody: [], jsonBody: [] };
  for (const row of rows) {
    if (row.source === 'HEADER') {
      const assertion: Record<string, unknown> = {
        name: row.subject,
        operator: row.operator,
      };
      if (operatorNeedsTarget(row.operator)) assertion.target = stringTarget(row);
      result.headers.push(assertion);
      continue;
    }
    if (row.source === 'TEXT_BODY') {
      result.textBody.push({ operator: row.operator, target: stringTarget(row) });
      continue;
    }
    const assertion: Record<string, unknown> = {
      selector: row.subject,
      operator: row.operator,
    };
    if (operatorNeedsTarget(row.operator)) assertion.target = jsonTarget(row);
    result.jsonBody.push(assertion);
  }
  return result;
}

export function responseAssertionsFromForm(formData: FormData): SerializedResponseAssertions {
  const raw = formData.get('responseAssertions');
  if (typeof raw !== 'string' || raw.length === 0) {
    return { headers: [], textBody: [], jsonBody: [] };
  }
  return serializeResponseAssertions(JSON.parse(raw) as ResponseAssertionRow[]);
}

export function newAssertionRow(id: string, source: AssertionSource): ResponseAssertionRow {
  return {
    id,
    source,
    subject: source === 'JSON_BODY' ? '$.' : '',
    operator: source === 'HEADER' ? 'exists' : source === 'TEXT_BODY' ? 'contains' : 'exists',
    targetType: 'string',
    targetValue: '',
    sensitive: false,
    retainSensitive: false,
  };
}

export function operatorNeedsTarget(operator: AssertionOperator): boolean {
  return operator !== 'exists' && operator !== 'does_not_exist';
}

function rowFromStringTarget(
  id: string,
  source: 'HEADER' | 'TEXT_BODY',
  subject: string,
  operator: AssertionOperator,
  target: MaskedTarget | PlainStringTarget | undefined,
): ResponseAssertionRow {
  const masked = isMaskedTarget(target);
  return {
    id,
    source,
    subject,
    operator,
    targetType: 'string',
    targetValue: masked ? '' : (target?.value ?? ''),
    sensitive: masked,
    retainSensitive: masked,
  };
}

function stringTarget(row: ResponseAssertionRow): Record<string, unknown> {
  if (row.sensitive && row.retainSensitive && row.targetValue === '') {
    return { sensitive: true, retain: true };
  }
  return { sensitive: row.sensitive, value: row.targetValue };
}

function jsonTarget(row: ResponseAssertionRow): Record<string, unknown> {
  if (row.sensitive && row.retainSensitive && row.targetValue === '') {
    return { sensitive: true, retain: true };
  }
  const value: JsonScalarTarget =
    row.targetType === 'null'
      ? { type: 'null' }
      : row.targetType === 'boolean'
        ? { type: 'boolean', value: row.targetValue === 'true' }
        : { type: row.targetType, value: row.targetValue };
  return { sensitive: row.sensitive, value };
}

function isMaskedTarget(value: unknown): value is MaskedTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    'sensitive' in value &&
    value.sensitive === true &&
    'hasValue' in value &&
    value.hasValue === true
  );
}
