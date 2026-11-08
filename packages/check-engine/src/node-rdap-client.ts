import {
  RdapUnsupportedTldError,
  type RdapDomainClient,
  type RdapDomainRecord,
} from './domain-expiry-types.js';
import { resolveSafeHttpTarget, type DnsResolver } from './safe-http-target.js';
import { UndiciPinnedHttpTransport, type PinnedHttpTransport } from './undici-http-transport.js';

const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const CACHE_MS = 24 * 60 * 60 * 1_000;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 1_048_576;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

interface BootstrapDocument {
  services?: unknown;
}

interface NodeRdapDomainClientOptions {
  resolver?: DnsResolver;
  transport?: PinnedHttpTransport;
}

export class NodeRdapDomainClient implements RdapDomainClient {
  private bootstrap: { loadedAt: number; services: Map<string, string> } | null = null;
  private readonly resolver: DnsResolver | undefined;
  private readonly transport: PinnedHttpTransport;

  constructor(options: NodeRdapDomainClientOptions = {}) {
    this.resolver = options.resolver;
    this.transport = options.transport ?? new UndiciPinnedHttpTransport();
  }

  async lookup(domainName: string, signal: AbortSignal): Promise<RdapDomainRecord> {
    const baseUrl = await this.resolveBaseUrl(domainName, signal);
    const sourceUrl = new URL(
      `domain/${encodeURIComponent(domainName)}`,
      ensureTrailingSlash(baseUrl),
    );
    const response = await this.requestJson(sourceUrl, signal);
    return {
      expirationDate: expirationDate(response.payload, domainName),
      sourceUrl: response.finalUrl.toString(),
    };
  }

  private async resolveBaseUrl(domainName: string, signal: AbortSignal): Promise<string> {
    const now = Date.now();
    if (this.bootstrap === null || now - this.bootstrap.loadedAt >= CACHE_MS) {
      const response = await this.requestJson(new URL(BOOTSTRAP_URL), signal);
      const document = response.payload as BootstrapDocument;
      this.bootstrap = { loadedAt: now, services: parseServices(document.services) };
    }
    const labels = canonicalDomainName(domainName).split('.');
    for (let index = 0; index < labels.length; index += 1) {
      const suffix = labels.slice(index).join('.');
      const baseUrl = this.bootstrap.services.get(suffix);
      if (baseUrl) return baseUrl;
    }
    throw new RdapUnsupportedTldError(`No RDAP service is registered for ${domainName}.`);
  }

  private async requestJson(
    initialUrl: URL,
    signal: AbortSignal,
  ): Promise<{ payload: unknown; finalUrl: URL }> {
    let currentUrl = requireHttps(initialUrl);
    const visited = new Set<string>();

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const identity = currentUrl.toString();
      if (visited.has(identity)) throw new Error('RDAP redirect loop detected.');
      visited.add(identity);
      const target = await resolveSafeHttpTarget(currentUrl, {
        signal,
        ...(this.resolver ? { resolver: this.resolver } : {}),
      });
      const response = await this.transport.request({
        target,
        method: 'GET',
        signal,
        headers: [{ name: 'accept', value: 'application/rdap+json, application/json' }],
      });

      if (REDIRECT_STATUS_CODES.has(response.statusCode)) {
        const location = response.location;
        await response.discardBody();
        if (location === null) throw new Error('RDAP redirect omitted its destination.');
        if (redirectCount === MAX_REDIRECTS) throw new Error('RDAP redirect limit exceeded.');
        currentUrl = requireHttps(new URL(location, currentUrl));
        continue;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        await response.discardBody();
        throw new Error(`RDAP request failed with status ${response.statusCode}.`);
      }
      const encoded = await response.captureEncodedBody(MAX_RESPONSE_BYTES);
      return { payload: parseJson(encoded), finalUrl: currentUrl };
    }

    throw new Error('RDAP redirect limit exceeded.');
  }
}

function parseServices(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (!Array.isArray(value) || value.length === 0) throw new InvalidRdapBootstrapError();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new InvalidRdapBootstrapError();
    const suffixes: unknown = entry[0];
    const urls: unknown = entry[1];
    if (
      !Array.isArray(suffixes) ||
      suffixes.length === 0 ||
      !suffixes.every((suffix) => typeof suffix === 'string' && suffix.trim() !== '') ||
      !Array.isArray(urls) ||
      urls.length === 0 ||
      !urls.every((url) => typeof url === 'string')
    )
      throw new InvalidRdapBootstrapError();
    const baseUrl = urls.find(
      (url): url is string => typeof url === 'string' && url.startsWith('https://'),
    );
    if (!baseUrl) continue;
    for (const suffix of suffixes) {
      result.set(canonicalDomainName(suffix as string), baseUrl);
    }
  }
  if (result.size === 0) throw new InvalidRdapBootstrapError();
  return result;
}

function expirationDate(value: unknown, expectedDomainName: string): Date | null {
  if (
    !isRecord(value) ||
    value.objectClassName !== 'domain' ||
    typeof value.ldhName !== 'string' ||
    canonicalDomainName(value.ldhName) !== canonicalDomainName(expectedDomainName) ||
    !Array.isArray(value.events)
  )
    return null;
  const dates: Array<Date | null> = [];
  for (const event of value.events as unknown[]) {
    if (!isRecord(event) || event.eventAction !== 'expiration') continue;
    dates.push(typeof event.eventDate === 'string' ? parseStrictRfc3339(event.eventDate) : null);
  }
  if (dates.length === 0) return null;
  if (dates.some((date) => date === null)) return null;
  const timestamps = new Set(dates.map((date) => date!.getTime()));
  return timestamps.size === 1 ? dates[0]! : null;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function requireHttps(value: URL): URL {
  if (value.protocol !== 'https:') throw new Error('RDAP requests must use HTTPS.');
  return value;
}

function parseJson(value: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)) as unknown;
  } catch (error) {
    throw new Error('RDAP response is not valid UTF-8 JSON.', { cause: error });
  }
}

function canonicalDomainName(value: string): string {
  return value.trim().replace(/\.$/u, '').toLowerCase();
}

function parseStrictRfc3339(value: string): Date | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  )
    return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

class InvalidRdapBootstrapError extends Error {
  constructor() {
    super('The IANA RDAP bootstrap document is invalid.');
    this.name = 'InvalidRdapBootstrapError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
