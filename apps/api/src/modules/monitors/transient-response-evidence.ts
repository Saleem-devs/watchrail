import type {
  HttpBodyCapture,
  HttpCapturedResponseEvidence,
  HttpCheckResult,
  HttpResponseHeader,
} from '@watchrail/check-engine';
import type { HttpStatusPolicy, TlsCertificatePolicy } from '@watchrail/domain';
import { isSensitiveFieldName } from './sensitive-field.js';

export const RESPONSE_PREVIEW_LIMIT_BYTES = 8 * 1024;
const RESPONSE_HEADER_LIMIT = 64;
const RESPONSE_HEADER_VALUE_LIMIT = 1_024;
const REDACTED = '[REDACTED]';
const sensitiveHeaderName =
  /^(authorization|proxy-authorization|proxy-authenticate|set-cookie|cookie|www-authenticate|x-api-key|x-auth-token)$/iu;

export interface SafeTransientCheckResult {
  result: Omit<HttpCheckResult, 'responseEvidence'>;
  signals: {
    transport: 'PASS' | 'FAIL' | 'UNKNOWN';
    statusPolicy: 'PASS' | 'FAIL' | 'NOT_EVALUATED';
    assertions: 'PASS' | 'FAIL' | 'NOT_EVALUATED';
    tlsCertificate: 'PASS' | 'FAIL' | 'NOT_EVALUATED' | 'DISABLED';
  };
  response: {
    headers: Array<{ name: string; values: string[]; redacted: boolean }>;
    withheldHeaderCount: number;
    body:
      | { state: 'PREVIEW'; contentType: string; text: string; truncated: boolean }
      | {
          state: 'UNAVAILABLE';
          reason:
            | 'NO_RESPONSE'
            | 'HEAD_REQUEST'
            | 'NOT_CAPTURED'
            | 'UNSUPPORTED_CONTENT_TYPE'
            | Exclude<HttpBodyCapture, { state: 'CAPTURED' | 'NOT_REQUESTED' }>['reason'];
        };
  };
}

export function toSafeTransientCheckResult(
  result: HttpCheckResult,
  statusPolicy: HttpStatusPolicy,
  method: string,
  secretValues: readonly string[],
  tlsPolicy: TlsCertificatePolicy = { type: 'DISABLED' },
): SafeTransientCheckResult {
  const { responseEvidence, ...publicResult } = result;
  const transport = transportOutcome(result);
  return {
    result: publicResult,
    signals: {
      transport,
      statusPolicy:
        transport !== 'PASS' || result.statusCode === null
          ? 'NOT_EVALUATED'
          : matchesStatusPolicy(statusPolicy, result.statusCode)
            ? 'PASS'
            : 'FAIL',
      assertions: result.assertionEvaluation.outcome,
      tlsCertificate:
        tlsPolicy.type === 'DISABLED'
          ? 'DISABLED'
          : result.reason === 'CERTIFICATE_EVIDENCE_UNAVAILABLE' || !result.tlsCertificates?.length
            ? 'NOT_EVALUATED'
            : result.reason === 'CERTIFICATE_EXPIRING'
              ? 'FAIL'
              : 'PASS',
    },
    response: sanitizeResponseEvidence(responseEvidence, method, secretValues),
  };
}

function transportOutcome(
  result: HttpCheckResult,
): SafeTransientCheckResult['signals']['transport'] {
  if (
    result.reason === 'COMPLETED' ||
    result.reason === 'UNEXPECTED_STATUS' ||
    result.reason === 'CERTIFICATE_EXPIRING' ||
    result.reason === 'CERTIFICATE_EVIDENCE_UNAVAILABLE'
  )
    return 'PASS';
  if (result.outcome === 'UNKNOWN') return 'UNKNOWN';
  return 'FAIL';
}

function sanitizeResponseEvidence(
  evidence: HttpCapturedResponseEvidence | undefined,
  method: string,
  secretValues: readonly string[],
): SafeTransientCheckResult['response'] {
  const headers = sanitizeHeaders(evidence?.headers ?? [], secretValues);
  return {
    ...headers,
    body: sanitizeBody(evidence, method, secretValues),
  };
}

function sanitizeHeaders(headers: readonly HttpResponseHeader[], secretValues: readonly string[]) {
  const visible = headers.slice(0, RESPONSE_HEADER_LIMIT).map((header) => {
    const redacted = sensitiveHeaderName.test(header.name);
    return {
      name: header.name,
      values: header.values
        .slice(0, 16)
        .map((value) =>
          redacted
            ? REDACTED
            : redactKnownSecrets(value, secretValues).slice(0, RESPONSE_HEADER_VALUE_LIMIT),
        ),
      redacted,
    };
  });
  return {
    headers: visible,
    withheldHeaderCount: Math.max(0, headers.length - visible.length),
  };
}

function sanitizeBody(
  evidence: HttpCapturedResponseEvidence | undefined,
  method: string,
  secretValues: readonly string[],
): SafeTransientCheckResult['response']['body'] {
  if (method === 'HEAD') return { state: 'UNAVAILABLE', reason: 'HEAD_REQUEST' };
  if (!evidence) return { state: 'UNAVAILABLE', reason: 'NO_RESPONSE' };
  if (!evidence.body || evidence.body.state === 'NOT_REQUESTED') {
    return { state: 'UNAVAILABLE', reason: 'NOT_CAPTURED' };
  }
  if (evidence.body.state === 'UNAVAILABLE') {
    return { state: 'UNAVAILABLE', reason: evidence.body.reason };
  }

  const contentType = headerValue(evidence.headers, 'content-type');
  if (!contentType || !isInspectableContentType(contentType)) {
    return { state: 'UNAVAILABLE', reason: 'UNSUPPORTED_CONTENT_TYPE' };
  }

  const safeText = contentType.toLowerCase().includes('json')
    ? redactJson(evidence.body.text, secretValues)
    : redactKnownSecrets(evidence.body.text, secretValues);
  const preview = truncateUtf8(safeText, RESPONSE_PREVIEW_LIMIT_BYTES);
  return {
    state: 'PREVIEW',
    contentType,
    text: preview.text,
    truncated: preview.truncated,
  };
}

function isInspectableContentType(value: string): boolean {
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return (
    mediaType.startsWith('text/') ||
    mediaType === 'application/json' ||
    mediaType.endsWith('+json') ||
    mediaType === 'application/xml' ||
    mediaType.endsWith('+xml')
  );
}

function redactJson(value: string, secretValues: readonly string[]): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    return redactKnownSecrets(JSON.stringify(redactJsonValue(parsed), null, 2), secretValues);
  } catch {
    return redactKnownSecrets(value, secretValues);
  }
}

function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      isSensitiveFieldName(key) ? REDACTED : redactJsonValue(child),
    ]),
  );
}

function redactKnownSecrets(value: string, secretValues: readonly string[]): string {
  return secretValues
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((text, secret) => text.split(secret).join(REDACTED), value);
}

function headerValue(headers: readonly HttpResponseHeader[], name: string): string | null {
  return headers.find((header) => header.name.toLowerCase() === name)?.values.join(', ') ?? null;
}

function truncateUtf8(value: string, limit: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= limit) return { text: value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, midpoint)).byteLength <= limit) low = midpoint;
    else high = midpoint - 1;
  }
  return { text: value.slice(0, low), truncated: true };
}

function matchesStatusPolicy(policy: HttpStatusPolicy, statusCode: number): boolean {
  return policy.type === 'ANY_2XX'
    ? statusCode >= 200 && statusCode <= 299
    : policy.statusCodes.includes(statusCode);
}
