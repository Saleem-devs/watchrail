export const KEYWORD_MATCH_MODES = ['CONTAINS', 'NOT_CONTAINS'] as const;
export const KEYWORD_MONITOR_DEFAULTS = {
  timeoutMs: 10_000,
  followRedirects: true,
  match: 'CONTAINS',
} as const;
export const KEYWORD_LIMITS = {
  maximumLength: 4_096,
  maximumUrlLength: 2_048,
  minimumTimeoutMs: 1_000,
  maximumTimeoutMs: 30_000,
} as const;

export type KeywordMatchMode = (typeof KEYWORD_MATCH_MODES)[number];

export interface KeywordMonitorSettings {
  url: string;
  keyword: string;
  match: KeywordMatchMode;
  timeoutMs: number;
  followRedirects: boolean;
}

export interface KeywordMonitorFieldErrors {
  url?: string[];
  keyword?: string[];
  keywordMatch?: string[];
  timeoutMs?: string[];
  followRedirects?: string[];
}

export class KeywordMonitorInputError extends Error {
  constructor(readonly fields: KeywordMonitorFieldErrors) {
    super('Keyword monitor input is invalid.');
    this.name = 'KeywordMonitorInputError';
  }
}

export function parseKeywordMonitorSettings(value: unknown): KeywordMonitorSettings {
  const fields: KeywordMonitorFieldErrors = {};
  const input = isRecord(value) ? value : {};
  const url = parseUrl(input.url, fields);
  const keyword = parseKeyword(input.keyword, fields);
  const match = parseMatch(input.match ?? input.keywordMatch, fields);
  const timeoutMs = parseTimeout(input.timeoutMs, fields);
  const followRedirects = parseFollowRedirects(input.followRedirects, fields);

  if (Object.keys(fields).length > 0) throw new KeywordMonitorInputError(fields);
  return { url, keyword, match, timeoutMs, followRedirects };
}

function parseUrl(value: unknown, fields: KeywordMonitorFieldErrors): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fields.url = ['Enter an HTTP or HTTPS URL.'];
    return '';
  }
  const normalized = value.trim();
  if (normalized.length > KEYWORD_LIMITS.maximumUrlLength) {
    fields.url = [`URL must contain at most ${KEYWORD_LIMITS.maximumUrlLength} characters.`];
    return normalized;
  }
  try {
    const url = new URL(normalized);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      fields.url = ['Enter an HTTP or HTTPS URL without embedded credentials.'];
    }
    return url.toString();
  } catch {
    fields.url = ['Enter a valid HTTP or HTTPS URL.'];
    return normalized;
  }
}

function parseKeyword(value: unknown, fields: KeywordMonitorFieldErrors): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fields.keyword = ['Enter the text Watchrail should look for.'];
    return '';
  }
  if (value.length > KEYWORD_LIMITS.maximumLength) {
    fields.keyword = [`Keyword must contain at most ${KEYWORD_LIMITS.maximumLength} characters.`];
  }
  return value.replace(/\r\n?/g, '\n');
}

function parseMatch(value: unknown, fields: KeywordMonitorFieldErrors): KeywordMatchMode {
  if (typeof value === 'string' && KEYWORD_MATCH_MODES.includes(value as KeywordMatchMode)) {
    return value as KeywordMatchMode;
  }
  fields.keywordMatch = ['Choose whether the response must contain or must not contain the text.'];
  return KEYWORD_MONITOR_DEFAULTS.match;
}

function parseTimeout(value: unknown, fields: KeywordMonitorFieldErrors): number {
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= KEYWORD_LIMITS.minimumTimeoutMs &&
    value <= KEYWORD_LIMITS.maximumTimeoutMs
  ) {
    return value;
  }
  fields.timeoutMs = [
    `Use a whole-number timeout from ${KEYWORD_LIMITS.minimumTimeoutMs} to ${KEYWORD_LIMITS.maximumTimeoutMs} milliseconds.`,
  ];
  return KEYWORD_MONITOR_DEFAULTS.timeoutMs;
}

function parseFollowRedirects(value: unknown, fields: KeywordMonitorFieldErrors): boolean {
  if (typeof value === 'boolean') return value;
  fields.followRedirects = ['Choose whether redirects should be followed.'];
  return KEYWORD_MONITOR_DEFAULTS.followRedirects;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
