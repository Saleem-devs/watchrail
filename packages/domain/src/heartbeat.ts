import { CronExpressionParser } from 'cron-parser';

export const HEARTBEAT_SIGNAL_TYPES = ['PING', 'START', 'COMPLETE', 'FAIL'] as const;
export type HeartbeatSignalType = (typeof HEARTBEAT_SIGNAL_TYPES)[number];

export const HEARTBEAT_LIMITS = {
  minimumIntervalSeconds: 60,
  maximumIntervalSeconds: 30 * 24 * 60 * 60,
  maximumGraceSeconds: 7 * 24 * 60 * 60,
  maximumRuntimeSeconds: 7 * 24 * 60 * 60,
  maximumPayloadBytes: 4 * 1024,
  maximumMetadataEntries: 32,
  maximumMetadataKeyLength: 64,
  maximumMetadataValueLength: 512,
  maximumMessageLength: 500,
  maximumRunIdLength: 128,
} as const;

export type HeartbeatSchedule =
  | {
      type: 'INTERVAL';
      intervalSeconds: number;
      graceSeconds: number;
    }
  | {
      type: 'CRON';
      expression: string;
      timezone: string;
      graceSeconds: number;
    };

export interface HeartbeatMonitorSettings {
  schedule: HeartbeatSchedule;
  maximumRuntimeSeconds: number | null;
}

export interface HeartbeatSignal {
  type: HeartbeatSignalType;
  runId: string | null;
  message: string | null;
  metadata: Record<string, string | number | boolean | null>;
}

export interface HeartbeatResultEvidenceV1 {
  contractVersion: 1;
  signal: HeartbeatSignalType | 'MISSED';
  runId: string | null;
  message: string | null;
  metadata: Record<string, string | number | boolean | null>;
  expectedAt: string | null;
  receivedAt: string | null;
  runtimeMs: number | null;
}

export class HeartbeatInputError extends Error {
  constructor(readonly fields: Record<string, string[]>) {
    super('Heartbeat configuration is invalid.');
    this.name = 'HeartbeatInputError';
  }
}

export class HeartbeatSignalInputError extends Error {
  constructor(readonly issues: string[]) {
    super('Heartbeat signal is invalid.');
    this.name = 'HeartbeatSignalInputError';
  }
}

export class StoredHeartbeatResultError extends Error {
  constructor() {
    super('Stored heartbeat evidence is invalid.');
    this.name = 'StoredHeartbeatResultError';
  }
}

export function parseHeartbeatResultEvidence(value: unknown): HeartbeatResultEvidenceV1 {
  if (!isRecord(value)) throw new StoredHeartbeatResultError();
  const parsedSignal = value.signal;
  if (
    value.contractVersion !== 1 ||
    (parsedSignal !== 'MISSED' &&
      !HEARTBEAT_SIGNAL_TYPES.includes(parsedSignal as HeartbeatSignalType)) ||
    (value.runId !== null && typeof value.runId !== 'string') ||
    (value.message !== null && typeof value.message !== 'string') ||
    !isRecord(value.metadata) ||
    (value.expectedAt !== null && !isIsoDate(value.expectedAt)) ||
    (value.receivedAt !== null && !isIsoDate(value.receivedAt)) ||
    (value.runtimeMs !== null &&
      (typeof value.runtimeMs !== 'number' ||
        !Number.isFinite(value.runtimeMs) ||
        value.runtimeMs < 0))
  ) {
    throw new StoredHeartbeatResultError();
  }
  const signal = parseHeartbeatSignal({
    type: parsedSignal === 'MISSED' ? 'PING' : parsedSignal,
    runId: value.runId,
    message: value.message,
    metadata: value.metadata,
  });
  return {
    contractVersion: 1,
    signal: parsedSignal as HeartbeatResultEvidenceV1['signal'],
    runId: signal.runId,
    message: signal.message,
    metadata: signal.metadata,
    expectedAt: value.expectedAt,
    receivedAt: value.receivedAt,
    runtimeMs: value.runtimeMs,
  };
}

export function parseHeartbeatMonitorSettings(value: unknown): HeartbeatMonitorSettings {
  const fields: Record<string, string[]> = {};
  if (!isRecord(value)) {
    throw new HeartbeatInputError({ heartbeat: ['Provide heartbeat schedule settings.'] });
  }

  const schedule = parseSchedule(value.schedule, fields);
  const maximumRuntimeSeconds = parseOptionalInteger(
    value.maximumRuntimeSeconds,
    60,
    HEARTBEAT_LIMITS.maximumRuntimeSeconds,
    'maximumRuntimeSeconds',
    fields,
  );
  if (Object.keys(fields).length > 0) throw new HeartbeatInputError(fields);
  return { schedule, maximumRuntimeSeconds };
}

export function parseHeartbeatSignal(value: unknown): HeartbeatSignal {
  if (value === undefined || value === null || value === '') {
    return { type: 'PING', runId: null, message: null, metadata: {} };
  }
  if (!isRecord(value)) throw new HeartbeatSignalInputError(['Provide a JSON object.']);

  const issues: string[] = [];
  const type = HEARTBEAT_SIGNAL_TYPES.includes(value.type as HeartbeatSignalType)
    ? (value.type as HeartbeatSignalType)
    : 'PING';
  if (value.type !== undefined && type === 'PING' && value.type !== 'PING') {
    issues.push('Signal type must be PING, START, COMPLETE, or FAIL.');
  }
  const runId = optionalBoundedString(
    value.runId,
    HEARTBEAT_LIMITS.maximumRunIdLength,
    'Run ID',
    issues,
  );
  const message = optionalBoundedString(
    value.message,
    HEARTBEAT_LIMITS.maximumMessageLength,
    'Message',
    issues,
  );
  const metadata = parseMetadata(value.metadata, issues);
  const encodedBytes = new TextEncoder().encode(
    JSON.stringify({ type, runId, message, metadata }),
  ).byteLength;
  if (encodedBytes > HEARTBEAT_LIMITS.maximumPayloadBytes) {
    issues.push(`Signal payload must not exceed ${HEARTBEAT_LIMITS.maximumPayloadBytes} bytes.`);
  }
  if (issues.length > 0) throw new HeartbeatSignalInputError(issues);
  return { type, runId, message, metadata };
}

export function redactHeartbeatSignal(signal: HeartbeatSignal): HeartbeatSignal {
  const metadata = Object.fromEntries(
    Object.entries(signal.metadata).map(([key, value]) => [
      key,
      isSensitiveMetadataKey(key) && value !== null ? '[REDACTED]' : value,
    ]),
  );
  return {
    ...signal,
    message: signal.message === null ? null : redactFreeText(signal.message),
    metadata,
  };
}

function parseSchedule(value: unknown, fields: Record<string, string[]>): HeartbeatSchedule {
  if (!isRecord(value) || (value.type !== 'INTERVAL' && value.type !== 'CRON')) {
    fields.schedule = ['Choose an interval or cron schedule.'];
    return { type: 'INTERVAL', intervalSeconds: 300, graceSeconds: 60 };
  }
  const graceSeconds = parseInteger(
    value.graceSeconds,
    0,
    HEARTBEAT_LIMITS.maximumGraceSeconds,
    'graceSeconds',
    fields,
  );
  if (value.type === 'INTERVAL') {
    return {
      type: 'INTERVAL',
      intervalSeconds: parseInteger(
        value.intervalSeconds,
        HEARTBEAT_LIMITS.minimumIntervalSeconds,
        HEARTBEAT_LIMITS.maximumIntervalSeconds,
        'intervalSeconds',
        fields,
      ),
      graceSeconds,
    };
  }

  const expression = typeof value.expression === 'string' ? value.expression.trim() : '';
  const timezone = typeof value.timezone === 'string' ? value.timezone.trim() : '';
  if (!isFiveFieldCron(expression) || !isValidCron(expression, timezone)) {
    fields.expression = ['Use a five-field cron expression.'];
  }
  if (!isTimeZone(timezone)) fields.timezone = ['Choose a valid IANA time zone.'];
  return { type: 'CRON', expression, timezone, graceSeconds };
}

function parseInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
  fields: Record<string, string[]>,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fields[field] = [`Use a whole number from ${minimum} to ${maximum}.`];
    return minimum;
  }
  return Number(value);
}

function isValidCron(expression: string, timezone: string): boolean {
  if (!expression || !isTimeZone(timezone)) return false;
  try {
    CronExpressionParser.parse(expression, { tz: timezone }).next();
    return true;
  } catch {
    return false;
  }
}

function parseOptionalInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
  fields: Record<string, string[]>,
): number | null {
  if (value === undefined || value === null) return null;
  return parseInteger(value, minimum, maximum, field, fields);
}

function parseMetadata(
  value: unknown,
  issues: string[],
): Record<string, string | number | boolean | null> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    issues.push('Metadata must be an object of scalar values.');
    return {};
  }
  const entries = Object.entries(value);
  if (entries.length > HEARTBEAT_LIMITS.maximumMetadataEntries) {
    issues.push(`Metadata supports at most ${HEARTBEAT_LIMITS.maximumMetadataEntries} entries.`);
  }
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of entries.slice(0, HEARTBEAT_LIMITS.maximumMetadataEntries)) {
    if (key.length === 0 || key.length > HEARTBEAT_LIMITS.maximumMetadataKeyLength) {
      issues.push(
        `Metadata keys must be 1–${HEARTBEAT_LIMITS.maximumMetadataKeyLength} characters.`,
      );
      continue;
    }
    if (
      entry !== null &&
      typeof entry !== 'string' &&
      typeof entry !== 'number' &&
      typeof entry !== 'boolean'
    ) {
      issues.push(`Metadata value for ${key} must be a string, number, boolean, or null.`);
      continue;
    }
    if (typeof entry === 'string' && entry.length > HEARTBEAT_LIMITS.maximumMetadataValueLength) {
      issues.push(
        `Metadata value for ${key} must not exceed ${HEARTBEAT_LIMITS.maximumMetadataValueLength} characters.`,
      );
      continue;
    }
    result[key] = entry;
  }
  return result;
}

function optionalBoundedString(
  value: unknown,
  maximum: number,
  label: string,
  issues: string[],
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    issues.push(`${label} must be 1–${maximum} characters.`);
    return null;
  }
  return value;
}

function isFiveFieldCron(value: string): boolean {
  return value.split(/\s+/u).length === 5 && /^[\d*,\-/\s]+$/u.test(value);
}

function isTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSensitiveMetadataKey(key: string): boolean {
  return /(?:authorization|cookie|credential|password|secret|session|token|api[_-]?key)/iu.test(
    key,
  );
}

function redactFreeText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(
      /\b(password|secret|token|api[_-]?key|session(?:id)?)\s*[:=]\s*[^\s,;]+/giu,
      '$1=[REDACTED]',
    );
}
