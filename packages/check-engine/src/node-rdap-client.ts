import {
  RdapUnsupportedTldError,
  type RdapDomainClient,
  type RdapDomainRecord,
} from './domain-expiry-types.js';

const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const CACHE_MS = 24 * 60 * 60 * 1_000;

interface BootstrapDocument {
  services?: unknown;
}

export class NodeRdapDomainClient implements RdapDomainClient {
  private bootstrap: { loadedAt: number; services: Map<string, string> } | null = null;

  async lookup(domainName: string, signal: AbortSignal): Promise<RdapDomainRecord> {
    const baseUrl = await this.resolveBaseUrl(domainName, signal);
    const sourceUrl = new URL(
      `domain/${encodeURIComponent(domainName)}`,
      ensureTrailingSlash(baseUrl),
    );
    const response = await fetch(sourceUrl, {
      signal,
      headers: { accept: 'application/rdap+json, application/json' },
    });
    if (!response.ok) throw new Error(`RDAP lookup failed with status ${response.status}.`);
    const payload = (await response.json()) as unknown;
    return { expirationDate: expirationDate(payload), sourceUrl: sourceUrl.toString() };
  }

  private async resolveBaseUrl(domainName: string, signal: AbortSignal): Promise<string> {
    const now = Date.now();
    if (this.bootstrap === null || now - this.bootstrap.loadedAt >= CACHE_MS) {
      const response = await fetch(BOOTSTRAP_URL, {
        signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`RDAP bootstrap failed with status ${response.status}.`);
      const document = (await response.json()) as BootstrapDocument;
      this.bootstrap = { loadedAt: now, services: parseServices(document.services) };
    }
    const tld = domainName.slice(domainName.lastIndexOf('.') + 1).toLowerCase();
    const baseUrl = this.bootstrap.services.get(tld);
    if (!baseUrl) throw new RdapUnsupportedTldError(`No RDAP service is registered for .${tld}.`);
    return baseUrl;
  }
}

function parseServices(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (!Array.isArray(value)) return result;
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const suffixes: unknown = entry[0];
    const urls: unknown = entry[1];
    if (!Array.isArray(suffixes) || !Array.isArray(urls)) continue;
    const baseUrl = urls.find(
      (url): url is string => typeof url === 'string' && url.startsWith('https://'),
    );
    if (!baseUrl) continue;
    for (const suffix of suffixes) {
      if (typeof suffix === 'string' && suffix !== '') result.set(suffix.toLowerCase(), baseUrl);
    }
  }
  return result;
}

function expirationDate(value: unknown): Date | null {
  if (!isRecord(value) || !Array.isArray(value.events)) return null;
  for (const event of value.events) {
    if (
      !isRecord(event) ||
      event.eventAction !== 'expiration' ||
      typeof event.eventDate !== 'string'
    )
      continue;
    const date = new Date(event.eventDate);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
