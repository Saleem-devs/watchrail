import type { Monitor } from './types';

export type MonitorType = Monitor['type'];

export interface MonitorTypeDefinition {
  type: MonitorType;
  slug: 'http' | 'tcp' | 'dns' | 'ping' | 'keywords' | 'api-workflows' | 'heartbeats' | 'domains';
  label: string;
  singular: string;
  description: string;
  createDescription: string;
  supportsConfigurationTest: boolean;
}

export const MONITOR_TYPES: readonly MonitorTypeDefinition[] = [
  {
    type: 'HTTP',
    slug: 'http',
    label: 'HTTP',
    singular: 'HTTP monitor',
    description: 'Endpoint availability, response validation, latency, redirects, and TLS.',
    createDescription: 'Monitor an HTTP or HTTPS endpoint and validate its response.',
    supportsConfigurationTest: true,
  },
  {
    type: 'TCP',
    slug: 'tcp',
    label: 'TCP',
    singular: 'TCP monitor',
    description: 'Connection establishment and latency for network services and ports.',
    createDescription: 'Verify that a host accepts TCP connections on a selected port.',
    supportsConfigurationTest: false,
  },
  {
    type: 'DNS',
    slug: 'dns',
    label: 'DNS',
    singular: 'DNS monitor',
    description: 'Record resolution, expected answers, lookup latency, and mismatches.',
    createDescription: 'Resolve a DNS record and optionally require expected answers.',
    supportsConfigurationTest: false,
  },
  {
    type: 'ICMP',
    slug: 'ping',
    label: 'Ping',
    singular: 'Ping monitor',
    description: 'ICMP reachability and round-trip latency for public hosts and network edges.',
    createDescription: 'Ping a public hostname or IP address and measure its response time.',
    supportsConfigurationTest: false,
  },
  {
    type: 'KEYWORD',
    slug: 'keywords',
    label: 'Keywords',
    singular: 'Keyword monitor',
    description: 'Page availability and required or forbidden text in the final HTTP response.',
    createDescription: 'Watch a page for text that must appear—or must stay absent.',
    supportsConfigurationTest: true,
  },
  {
    type: 'API_WORKFLOW',
    slug: 'api-workflows',
    label: 'API workflows',
    singular: 'API workflow',
    description: 'Ordered HTTP steps with variables, assertions, and shared execution state.',
    createDescription: 'Verify an ordered API journey across multiple HTTP requests.',
    supportsConfigurationTest: false,
  },
  {
    type: 'HEARTBEAT',
    slug: 'heartbeats',
    label: 'Heartbeats',
    singular: 'Heartbeat monitor',
    description: 'Cron jobs, workers, backups, and other inbound scheduled signals.',
    createDescription: 'Receive authenticated signals and alert when a job is late or fails.',
    supportsConfigurationTest: false,
  },
  {
    type: 'DOMAIN_EXPIRY',
    slug: 'domains',
    label: 'Domains',
    singular: 'Domain expiry monitor',
    description:
      'Registration expiry dates and advance renewal warnings through authoritative RDAP data.',
    createDescription: 'Track a registered domain and alert before its registration expires.',
    supportsConfigurationTest: false,
  },
] as const;

export function monitorTypeDefinition(type: MonitorType): MonitorTypeDefinition {
  const definition = MONITOR_TYPES.find((candidate) => candidate.type === type);
  if (!definition) throw new Error(`Unsupported monitor type: ${type}`);
  return definition;
}

export function monitorTypeFromSlug(slug: string): MonitorTypeDefinition | undefined {
  return MONITOR_TYPES.find((candidate) => candidate.slug === slug);
}

export function monitorTypePath(projectId: string, type: MonitorType): string {
  return `/projects/${projectId}/monitors/${monitorTypeDefinition(type).slug}`;
}

export function createMonitorTypePath(projectId: string, type: MonitorType): string {
  return `/projects/${projectId}/monitors/new/${monitorTypeDefinition(type).slug}`;
}
