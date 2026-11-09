import {
  AssertionInputError,
  isValidJsonSelector,
  parseResponseAssertions,
  type ResponseAssertions,
} from './assertion.js';
import {
  API_WORKFLOW_LIMITS,
  type ApiWorkflowConfigurationInput,
  type ApiWorkflowExtraction,
  type ApiWorkflowRequestBodyUpdate,
  type ApiWorkflowStepInput,
  type StoredApiWorkflowRequestBodyV1,
  type StoredApiWorkflowConfigurationV1,
} from './api-workflow.js';
import { parseStoredAssertionConfiguration } from './assertion-persistence.js';
import { parseWorkspaceSecretReference } from './workspace-secret-reference.js';
import {
  DISABLED_TLS_CERTIFICATE_POLICY,
  parseTlsCertificatePolicy,
  TlsCertificatePolicyError,
  type TlsCertificatePolicy,
} from './tls.js';
import { parseTcpMonitorSettings, TcpMonitorInputError } from './tcp.js';
import {
  DNS_MONITOR_DEFAULTS,
  DnsMonitorInputError,
  parseDnsMonitorSettings,
  type DnsRecordType,
} from './dns.js';
import {
  parseHeartbeatMonitorSettings,
  HeartbeatInputError,
  type HeartbeatMonitorSettings,
} from './heartbeat.js';
import {
  DOMAIN_EXPIRY_TIMEOUT_LIMITS,
  DOMAIN_EXPIRY_WARNING_LIMITS,
  DomainExpiryInputError,
  parseDomainExpiryMonitorSettings,
} from './domain-expiry.js';
import { ICMP_MONITOR_DEFAULTS, IcmpMonitorInputError, parseIcmpMonitorSettings } from './icmp.js';

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export const HTTP_MONITOR_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const;
export const MONITOR_LIFECYCLE_STATES = ['ENABLED', 'PAUSED', 'ARCHIVED'] as const;
export const MONITOR_TYPES = [
  'HTTP',
  'TCP',
  'DNS',
  'API_WORKFLOW',
  'HEARTBEAT',
  'DOMAIN_EXPIRY',
  'ICMP',
] as const;
export const MONITOR_LOCATIONS = ['local'] as const;
export const MONITOR_INTERVAL_LIMITS = {
  minimumSeconds: 60,
  maximumSeconds: 86_400,
} as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];
export type HttpMonitorMethod = (typeof HTTP_MONITOR_METHODS)[number];
export type MonitorLifecycleState = (typeof MONITOR_LIFECYCLE_STATES)[number];
export type MonitorType = (typeof MONITOR_TYPES)[number];
export type HttpStatusPolicy = { type: 'ANY_2XX' } | { type: 'EXACT'; statusCodes: number[] };
export type HttpRequestBody =
  | { type: 'NONE' }
  | { type: 'JSON'; value: string }
  | { type: 'FORM_URLENCODED'; fields: Array<{ name: string; value: string }> }
  | { type: 'RAW'; contentType: string; value: string };

export const HTTP_REQUEST_BODY_LIMIT_BYTES = 64 * 1024;

export const MONITOR_DEFAULTS = {
  method: 'GET',
  lifecycleState: 'ENABLED',
  timeoutMs: 10_000,
  intervalSeconds: 60,
  followRedirects: true,
  statusPolicy: { type: 'ANY_2XX' } as const,
  tlsPolicy: DISABLED_TLS_CERTIFICATE_POLICY,
  locations: [...MONITOR_LOCATIONS],
} as const satisfies {
  method: HttpMethod;
  lifecycleState: MonitorLifecycleState;
  timeoutMs: number;
  intervalSeconds: number;
  followRedirects: boolean;
  statusPolicy: HttpStatusPolicy;
  tlsPolicy: TlsCertificatePolicy;
  locations: readonly string[];
};

export interface CreateMonitorCommand {
  name: unknown;
  type?: unknown;
  url?: unknown;
  host?: unknown;
  port?: unknown;
  dnsName?: unknown;
  dnsRecordType?: unknown;
  dnsExpectedValues?: unknown;
  domainName?: unknown;
  domainWarningDays?: unknown;
  statusPolicy?: unknown;
  tlsPolicy?: unknown;
  method?: unknown;
  timeoutMs?: unknown;
  followRedirects?: unknown;
  lifecycleState?: unknown;
  locations?: unknown;
  requestHeaders?: unknown;
  requestBody?: unknown;
  assertions?: unknown;
  workflow?: unknown;
  heartbeat?: unknown;
  intervalSeconds?: unknown;
}

interface NewMonitorBase {
  name: string;
  lifecycleState: MonitorLifecycleState;
  timeoutMs: number;
  intervalSeconds: number;
  locations: string[];
}

export interface NewHttpMonitor extends NewMonitorBase {
  type: 'HTTP';
  url: string;
  method: HttpMonitorMethod;
  followRedirects: boolean;
  statusPolicy: HttpStatusPolicy;
  tlsPolicy: TlsCertificatePolicy;
  requestHeaders: RequestHeaderUpdate[];
  requestBody: HttpRequestBody;
  assertions: unknown;
}

export interface NewTcpMonitor extends NewMonitorBase {
  type: 'TCP';
  host: string;
  port: number;
}

export interface NewDnsMonitor extends NewMonitorBase {
  type: 'DNS';
  dnsName: string;
  dnsRecordType: DnsRecordType;
  dnsExpectedValues: string[];
}

export interface NewApiWorkflowMonitor extends NewMonitorBase {
  type: 'API_WORKFLOW';
  workflow: ApiWorkflowConfigurationInput;
}

export interface NewHeartbeatMonitor extends NewMonitorBase {
  type: 'HEARTBEAT';
  heartbeat: HeartbeatMonitorSettings;
}

export interface NewDomainExpiryMonitor extends NewMonitorBase {
  type: 'DOMAIN_EXPIRY';
  domainName: string;
  domainWarningDays: number;
}

export interface NewIcmpMonitor extends NewMonitorBase {
  type: 'ICMP';
  host: string;
}

export type NewMonitor =
  | NewHttpMonitor
  | NewTcpMonitor
  | NewDnsMonitor
  | NewApiWorkflowMonitor
  | NewHeartbeatMonitor
  | NewDomainExpiryMonitor
  | NewIcmpMonitor;

export interface MonitorFieldErrors {
  name?: string[];
  type?: string[];
  host?: string[];
  port?: string[];
  dnsName?: string[];
  dnsRecordType?: string[];
  dnsExpectedValues?: string[];
  dnsSettings?: string[];
  domainName?: string[];
  domainWarningDays?: string[];
  url?: string[];
  statusPolicy?: string[];
  tlsPolicy?: string[];
  requestHeaders?: string[];
  requestBody?: string[];
  assertions?: string[];
  workflow?: string[];
  heartbeat?: string[];
  schedule?: string[];
  expression?: string[];
  timezone?: string[];
  graceSeconds?: string[];
  maximumRuntimeSeconds?: string[];
  method?: string[];
  timeoutMs?: string[];
  followRedirects?: string[];
  httpSettings?: string[];
  intervalSeconds?: string[];
  lifecycleState?: string[];
  locations?: string[];
}

export interface MonitorConfigurationUpdate {
  settings: HttpMonitorSettings;
  requestHeaders: unknown;
  assertions: unknown;
}

export interface HttpConfigurationTestInput {
  settings: HttpMonitorSettings;
  statusPolicy: HttpStatusPolicy;
  requestHeaders: RequestHeaderUpdate[];
  assertions: unknown;
}

/**
 * Validates the complete unsaved HTTP surface without introducing a second
 * monitor-configuration contract. Secret-retention markers are intentionally
 * left for the security packages to resolve against an existing monitor.
 */
export function parseHttpConfigurationTest(value: unknown): HttpConfigurationTestInput {
  if (!hasExactKeys(value, ['assertions', 'httpSettings', 'requestHeaders', 'statusPolicy'])) {
    throw new MonitorInputError({
      httpSettings: ['Provide exactly httpSettings, statusPolicy, requestHeaders, and assertions.'],
    });
  }

  return {
    settings: parseHttpMonitorSettings(value.httpSettings),
    statusPolicy: parseHttpStatusPolicy(value.statusPolicy),
    requestHeaders: normalizeRequestHeaderUpdates(value.requestHeaders),
    assertions: value.assertions,
  };
}

export function parseMonitorConfigurationUpdate(value: unknown): MonitorConfigurationUpdate {
  if (!hasExactKeys(value, ['assertions', 'httpSettings', 'requestHeaders'])) {
    throw new MonitorInputError({
      httpSettings: [
        'Provide exactly httpSettings, requestHeaders, and assertions for a configuration update.',
      ],
    });
  }

  return {
    settings: parseHttpMonitorSettings(value.httpSettings),
    requestHeaders: value.requestHeaders,
    assertions: value.assertions,
  };
}

const WORKFLOW_STEP_KEYS = [
  'assertions',
  'extractions',
  'followRedirects',
  'id',
  'method',
  'name',
  'requestBody',
  'requestHeaders',
  'statusPolicy',
  'timeoutMs',
  'tlsPolicy',
  'url',
] as const;
const WORKFLOW_STEP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const WORKFLOW_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const WORKFLOW_VARIABLE_REFERENCE = /\{\{([A-Za-z_][A-Za-z0-9_]{0,63})\}\}/gu;
const WORKFLOW_URL_MARKER = 'watchrail-variable-marker';

export function parseApiWorkflowConfiguration(value: unknown): ApiWorkflowConfigurationInput {
  if (!hasExactKeys(value, ['contractVersion', 'steps']) || value.contractVersion !== 1) {
    throw new MonitorInputError({
      workflow: ['Provide a supported API workflow configuration.'],
    });
  }
  if (
    !Array.isArray(value.steps) ||
    value.steps.length < API_WORKFLOW_LIMITS.minimumSteps ||
    value.steps.length > API_WORKFLOW_LIMITS.maximumSteps
  ) {
    throw new MonitorInputError({
      workflow: [
        `Provide ${API_WORKFLOW_LIMITS.minimumSteps} to ${API_WORKFLOW_LIMITS.maximumSteps} workflow steps.`,
      ],
    });
  }

  const issues: string[] = [];
  const stepIds = new Set<string>();
  const variables = new Set<string>();
  const steps = value.steps.map((candidate, index) => {
    const label = `Step ${index + 1}`;
    if (!hasExactKeys(candidate, WORKFLOW_STEP_KEYS)) {
      issues.push(`${label} must provide the complete HTTP step configuration.`);
      return emptyApiWorkflowStep(index);
    }
    const stepFields: MonitorFieldErrors = {};
    const id = normalizeWorkflowStepId(candidate.id, stepIds, label, issues);
    const name = normalizeWorkflowStepName(candidate.name, label, issues);
    const url = normalizeWorkflowStepUrl(candidate.url, label, issues);
    const method = normalizeHttpMonitorMethod(candidate.method, stepFields);
    const timeoutMs = normalizeTimeout(candidate.timeoutMs, stepFields);
    const followRedirects = normalizeFollowRedirects(candidate.followRedirects, stepFields);
    const statusPolicy = normalizeStatusPolicy(candidate.statusPolicy, stepFields);
    const requestBody = normalizeApiWorkflowRequestBody(candidate.requestBody, method, stepFields);
    const tlsPolicy = normalizeTlsPolicy(candidate.tlsPolicy, url, stepFields, false);
    let requestHeaders: RequestHeaderUpdate[] = [];
    try {
      requestHeaders = normalizeRequestHeaderUpdates(candidate.requestHeaders);
    } catch (error) {
      if (!(error instanceof RequestHeaderInputError)) throw error;
      stepFields.requestHeaders = error.issues;
    }
    const extractions = normalizeWorkflowExtractions(
      candidate.extractions,
      variables,
      label,
      issues,
    );
    for (const [field, messages] of Object.entries(stepFields)) {
      for (const message of messages ?? []) issues.push(`${label} ${field}: ${message}`);
    }
    return {
      id,
      name,
      url,
      method,
      timeoutMs,
      followRedirects,
      statusPolicy,
      tlsPolicy,
      requestHeaders,
      requestBody,
      assertions: candidate.assertions,
      extractions,
    } satisfies ApiWorkflowStepInput;
  });
  if (
    steps.reduce((total, step) => total + step.timeoutMs, 0) >
    API_WORKFLOW_LIMITS.maximumExecutionMs
  ) {
    issues.push(
      `Workflow step timeouts may total at most ${API_WORKFLOW_LIMITS.maximumExecutionMs / 1_000} seconds.`,
    );
  }
  if (issues.length > 0) throw new MonitorInputError({ workflow: issues });
  return { contractVersion: 1, steps };
}

export class StoredApiWorkflowConfigurationInvariantError extends Error {
  constructor() {
    super('Stored API workflow configuration violates the persistence contract.');
    this.name = 'StoredApiWorkflowConfigurationInvariantError';
  }
}

export function parseStoredApiWorkflowConfiguration(
  value: unknown,
): StoredApiWorkflowConfigurationV1 {
  if (!hasExactKeys(value, ['contractVersion', 'steps']) || value.contractVersion !== 1) {
    throw new StoredApiWorkflowConfigurationInvariantError();
  }
  if (!Array.isArray(value.steps)) throw new StoredApiWorkflowConfigurationInvariantError();
  try {
    const storedSteps = value.steps.map((candidate) => {
      if (!hasExactKeys(candidate, WORKFLOW_STEP_KEYS)) {
        throw new StoredApiWorkflowConfigurationInvariantError();
      }
      return {
        ...candidate,
        requestHeaders: parseStoredRequestHeaders(candidate.requestHeaders),
        requestBody: parseStoredApiWorkflowRequestBody(candidate.requestBody),
        assertions: parseStoredAssertionConfiguration(candidate.assertions),
      };
    });
    const normalized = parseApiWorkflowConfiguration({
      contractVersion: 1,
      steps: storedSteps.map((step) => ({
        ...step,
        requestBody:
          step.requestBody.type === 'NONE'
            ? step.requestBody
            : { type: step.requestBody.type, sensitive: true, retain: true as const },
        requestHeaders: step.requestHeaders.map((header) =>
          header.sensitive ? { name: header.name, sensitive: true, retain: true as const } : header,
        ),
      })),
    });
    return {
      contractVersion: 1,
      steps: normalized.steps.map((step, index) => ({
        ...step,
        requestBody: storedSteps[index]!.requestBody,
        requestHeaders: storedSteps[index]!.requestHeaders,
        assertions: storedSteps[index]!.assertions,
      })),
    };
  } catch (error) {
    if (error instanceof StoredApiWorkflowConfigurationInvariantError) throw error;
    throw new StoredApiWorkflowConfigurationInvariantError();
  }
}

function normalizeApiWorkflowRequestBody(
  value: unknown,
  method: HttpMonitorMethod,
  fields: MonitorFieldErrors,
): ApiWorkflowRequestBodyUpdate {
  if (
    isRecord(value) &&
    value.sensitive === true &&
    (value.type === 'JSON' || value.type === 'FORM_URLENCODED' || value.type === 'RAW') &&
    'secretReference' in value
  ) {
    if (method === 'GET' || method === 'HEAD') {
      fields.requestBody = [`${method} monitors cannot send a request body.`];
      return { type: 'NONE' };
    }
    try {
      const secretReference = parseWorkspaceSecretReference(value.secretReference);
      if (value.type === 'RAW') {
        if (!hasExactKeys(value, ['contentType', 'secretReference', 'sensitive', 'type'])) {
          fields.requestBody = ['Workspace-secret raw bodies contain unsupported fields.'];
          return { type: 'NONE' };
        }
        const contentType = normalizeRawContentType(value.contentType);
        if (contentType === null) {
          fields.requestBody = ['Raw workflow bodies require a valid content type.'];
          return { type: 'NONE' };
        }
        return {
          type: 'RAW',
          sensitive: true,
          secretReference,
          contentType,
        };
      }
      if (!hasExactKeys(value, ['sensitive', 'type', 'secretReference'])) {
        fields.requestBody = ['Workspace-secret workflow bodies contain unsupported fields.'];
        return { type: 'NONE' };
      }
      return { type: value.type, sensitive: true, secretReference };
    } catch {
      fields.requestBody = ['Choose a valid active workspace secret.'];
      return { type: 'NONE' };
    }
  }
  if (
    hasExactKeys(value, ['retain', 'sensitive', 'type']) &&
    value.retain === true &&
    value.sensitive === true &&
    (value.type === 'JSON' || value.type === 'FORM_URLENCODED' || value.type === 'RAW')
  ) {
    if (method === 'GET' || method === 'HEAD') {
      fields.requestBody = [`${method} monitors cannot send a request body.`];
      return { type: 'NONE' };
    }
    return { type: value.type, sensitive: true, retain: true };
  }
  return normalizeRequestBody(value, method, fields);
}

function parseStoredApiWorkflowRequestBody(value: unknown): StoredApiWorkflowRequestBodyV1 {
  if (hasExactKeys(value, ['type']) && value.type === 'NONE') {
    return { type: 'NONE' };
  }
  if (
    hasExactKeys(value, ['encryptedValue', 'sensitive', 'type']) &&
    (value.type === 'JSON' || value.type === 'FORM_URLENCODED' || value.type === 'RAW') &&
    value.sensitive === true &&
    isEncryptedHeaderValueV1(value.encryptedValue)
  ) {
    return {
      type: value.type,
      sensitive: true,
      encryptedValue: value.encryptedValue,
    };
  }
  if (
    isRecord(value) &&
    value.sensitive === true &&
    (value.type === 'JSON' || value.type === 'FORM_URLENCODED' || value.type === 'RAW') &&
    'secretReference' in value
  ) {
    const expectedKeys =
      value.type === 'RAW'
        ? ['contentType', 'secretReference', 'sensitive', 'type']
        : ['secretReference', 'sensitive', 'type'];
    if (!hasExactKeys(value, expectedKeys))
      throw new StoredApiWorkflowConfigurationInvariantError();
    const contentType = value.type === 'RAW' ? normalizeRawContentType(value.contentType) : null;
    if (value.type === 'RAW' && contentType === null) {
      throw new StoredApiWorkflowConfigurationInvariantError();
    }
    return {
      type: value.type,
      sensitive: true,
      secretReference: parseWorkspaceSecretReference(value.secretReference),
      ...(contentType === null ? {} : { contentType }),
    };
  }
  throw new StoredApiWorkflowConfigurationInvariantError();
}

function normalizeWorkflowStepId(
  value: unknown,
  seen: Set<string>,
  label: string,
  issues: string[],
): string {
  if (typeof value !== 'string' || !WORKFLOW_STEP_ID.test(value)) {
    issues.push(
      `${label} needs a unique ID using up to 64 letters, numbers, underscores, or dashes.`,
    );
    return `invalid-${seen.size + 1}`;
  }
  if (seen.has(value)) issues.push(`${label} reuses workflow step ID ${value}.`);
  seen.add(value);
  return value;
}

function normalizeWorkflowStepName(value: unknown, label: string, issues: string[]): string {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > 120) {
    issues.push(`${label} needs a name containing 1 to 120 characters.`);
    return '';
  }
  return value.trim();
}

function normalizeWorkflowStepUrl(value: unknown, label: string, issues: string[]): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 2_048) {
    issues.push(`${label} needs an HTTP or HTTPS URL of 2,048 characters or fewer.`);
    return '';
  }
  const url = value.trim();
  try {
    const parsed = new URL(url.replace(WORKFLOW_VARIABLE_REFERENCE, WORKFLOW_URL_MARKER));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
    if (!parsed.hostname || parsed.username || parsed.password) throw new Error();
    if (
      parsed.protocol.includes(WORKFLOW_URL_MARKER) ||
      parsed.username.includes(WORKFLOW_URL_MARKER) ||
      parsed.password.includes(WORKFLOW_URL_MARKER) ||
      parsed.hostname.includes(WORKFLOW_URL_MARKER) ||
      parsed.port.includes(WORKFLOW_URL_MARKER)
    ) {
      issues.push(`${label} cannot interpolate variables into the URL origin.`);
    }
  } catch {
    issues.push(`${label} needs a valid absolute HTTP or HTTPS URL.`);
  }
  return url;
}

function normalizeWorkflowExtractions(
  value: unknown,
  variables: Set<string>,
  label: string,
  issues: string[],
): ApiWorkflowExtraction[] {
  if (!Array.isArray(value) || value.length > API_WORKFLOW_LIMITS.maximumExtractionsPerStep) {
    issues.push(
      `${label} may define up to ${API_WORKFLOW_LIMITS.maximumExtractionsPerStep} extractions.`,
    );
    return [];
  }
  return value.map((candidate, index) => {
    const extraction = `${label} extraction ${index + 1}`;
    if (!hasExactKeys(candidate, ['selector', 'sensitive', 'variable'])) {
      issues.push(`${extraction} is incomplete.`);
      return { variable: `invalid_${index}`, selector: '$', sensitive: true };
    }
    const variable = typeof candidate.variable === 'string' ? candidate.variable : '';
    const selector = typeof candidate.selector === 'string' ? candidate.selector : '';
    if (!WORKFLOW_VARIABLE_NAME.test(variable)) {
      issues.push(`${extraction} has an invalid variable name.`);
    } else if (variables.has(variable)) {
      issues.push(`${extraction} redefines variable ${variable}.`);
    } else {
      variables.add(variable);
      if (variables.size > API_WORKFLOW_LIMITS.maximumVariables) {
        issues.push(
          `The workflow defines more than ${API_WORKFLOW_LIMITS.maximumVariables} variables.`,
        );
      }
    }
    if (!isValidJsonSelector(selector)) issues.push(`${extraction} has an invalid JSON selector.`);
    if (typeof candidate.sensitive !== 'boolean') {
      issues.push(`${extraction} must declare whether its value is sensitive.`);
    }
    return { variable, selector, sensitive: candidate.sensitive === true };
  });
}

function emptyApiWorkflowStep(index: number): ApiWorkflowStepInput {
  return {
    id: `invalid-${index + 1}`,
    name: '',
    url: '',
    method: 'GET',
    timeoutMs: MONITOR_DEFAULTS.timeoutMs,
    followRedirects: true,
    statusPolicy: { type: 'ANY_2XX' },
    tlsPolicy: { type: 'DISABLED' },
    requestHeaders: [],
    requestBody: { type: 'NONE' },
    assertions: { headers: [], textBody: [], jsonBody: [] },
    extractions: [],
  };
}

export interface MonitorLocationSettings {
  locations: string[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseMonitorLocationSettings(value: unknown): MonitorLocationSettings {
  if (!hasExactKeys(value, ['locations']) || !Array.isArray(value.locations)) {
    throw new MonitorInputError({ locations: ['Provide one to seven execution locations.'] });
  }
  if (value.locations.length < 1 || value.locations.length > 7) {
    throw new MonitorInputError({ locations: ['Choose one to seven execution locations.'] });
  }
  const locations = (value.locations as unknown[]).map((location) => {
    if (typeof location !== 'string' || (location !== 'local' && !UUID_PATTERN.test(location))) {
      throw new MonitorInputError({ locations: ['Choose local or remote location IDs.'] });
    }
    return location.toLowerCase();
  });
  if (new Set(locations).size !== locations.length) {
    throw new MonitorInputError({ locations: ['Execution locations must be unique.'] });
  }
  if (locations.includes('local') && locations.length > 1) {
    throw new MonitorInputError({
      locations: ['Local execution cannot be combined with remote locations.'],
    });
  }
  return { locations: locations.sort() };
}

export interface HttpMonitorSettings {
  url: string;
  method: HttpMonitorMethod;
  timeoutMs: number;
  followRedirects: boolean;
  requestBody: HttpRequestBody;
  tlsPolicy?: TlsCertificatePolicy;
}

export class MonitorInputError extends Error {
  readonly fields: MonitorFieldErrors;

  constructor(fields: MonitorFieldErrors) {
    super('Monitor input is invalid.');
    this.name = 'MonitorInputError';
    this.fields = fields;
  }
}

export function isHttpMonitorMethod(value: unknown): value is HttpMonitorMethod {
  return typeof value === 'string' && HTTP_MONITOR_METHODS.includes(value as HttpMonitorMethod);
}

export function createMonitor(command: CreateMonitorCommand): NewMonitor {
  const fields: MonitorFieldErrors = {};
  const name = normalizeName(command.name, fields);
  const type = normalizeMonitorType(command.type, fields);
  if (type === 'TCP') return createTcpMonitor(command, name, fields);
  if (type === 'DNS') return createDnsMonitor(command, name, fields);
  if (type === 'API_WORKFLOW') return createApiWorkflowMonitor(command, name, fields);
  if (type === 'HEARTBEAT') return createHeartbeatMonitor(command, name, fields);
  if (type === 'DOMAIN_EXPIRY') return createDomainExpiryMonitor(command, name, fields);
  if (type === 'ICMP') return createIcmpMonitor(command, name, fields);
  const url = normalizeUrl(command.url, fields);
  const statusPolicy = normalizeStatusPolicy(command.statusPolicy, fields);
  const tlsPolicy = normalizeTlsPolicy(command.tlsPolicy, url, fields, true);
  const method =
    command.method === undefined
      ? MONITOR_DEFAULTS.method
      : normalizeHttpMonitorMethod(command.method, fields);
  const timeoutMs =
    command.timeoutMs === undefined
      ? MONITOR_DEFAULTS.timeoutMs
      : normalizeTimeout(command.timeoutMs, fields);
  const followRedirects =
    command.followRedirects === undefined
      ? MONITOR_DEFAULTS.followRedirects
      : normalizeFollowRedirects(command.followRedirects, fields);
  const lifecycleState = normalizeInitialLifecycleState(command.lifecycleState, fields);
  let locations: string[] = [...MONITOR_DEFAULTS.locations];
  if (command.locations !== undefined) {
    try {
      locations = parseMonitorLocationSettings({ locations: command.locations }).locations;
    } catch (error) {
      if (error instanceof MonitorInputError) Object.assign(fields, error.fields);
      else throw error;
    }
  }
  const requestHeaders = normalizeHeaders(command.requestHeaders, fields);
  const requestBody = normalizeRequestBody(command.requestBody, method, fields);
  const assertions = containsWorkspaceSecretReference(command.assertions)
    ? command.assertions
    : normalizeAssertions(command.assertions, fields);
  const intervalSeconds = normalizeIntervalSeconds(command.intervalSeconds, fields, true);

  if (
    [
      command.host,
      command.port,
      command.dnsName,
      command.dnsRecordType,
      command.dnsExpectedValues,
      command.workflow,
      command.heartbeat,
      command.domainName,
      command.domainWarningDays,
    ].some((value) => value !== undefined)
  ) {
    fields.type = ['HTTP monitors cannot include TCP, DNS, or workflow configuration.'];
  }

  if (Object.keys(fields).length > 0) throw new MonitorInputError(fields);

  return {
    type: 'HTTP',
    name,
    url,
    method,
    lifecycleState,
    timeoutMs,
    intervalSeconds,
    followRedirects,
    statusPolicy,
    tlsPolicy,
    requestHeaders,
    requestBody,
    assertions,
    locations,
  };
}

function createIcmpMonitor(
  command: CreateMonitorCommand,
  name: string,
  fields: MonitorFieldErrors,
): NewIcmpMonitor {
  let settings: { host: string; timeoutMs: number } = {
    host: '',
    timeoutMs: ICMP_MONITOR_DEFAULTS.timeoutMs,
  };
  try {
    settings = parseIcmpMonitorSettings({
      host: command.host,
      timeoutMs: command.timeoutMs ?? ICMP_MONITOR_DEFAULTS.timeoutMs,
    });
  } catch (error) {
    if (!(error instanceof IcmpMonitorInputError)) throw error;
    Object.assign(fields, error.fields);
  }
  const lifecycleState = normalizeInitialLifecycleState(command.lifecycleState, fields);
  const intervalSeconds = normalizeIntervalSeconds(command.intervalSeconds, fields, true);
  let locations: string[] = [...MONITOR_DEFAULTS.locations];
  if (command.locations !== undefined) {
    try {
      locations = parseMonitorLocationSettings({ locations: command.locations }).locations;
    } catch (error) {
      if (error instanceof MonitorInputError) Object.assign(fields, error.fields);
      else throw error;
    }
  }
  const incompatibleFields = [
    command.port,
    command.url,
    command.dnsName,
    command.dnsRecordType,
    command.dnsExpectedValues,
    command.domainName,
    command.domainWarningDays,
    command.statusPolicy,
    command.tlsPolicy,
    command.method,
    command.followRedirects,
    command.requestHeaders,
    command.requestBody,
    command.assertions,
    command.workflow,
    command.heartbeat,
  ];
  if (incompatibleFields.some((value) => value !== undefined)) {
    fields.type = [
      'ICMP monitors cannot include HTTP, TCP, DNS, workflow, or heartbeat configuration.',
    ];
  }
  if (Object.keys(fields).length > 0) throw new MonitorInputError(fields);
  return {
    type: 'ICMP',
    name,
    host: settings.host,
    timeoutMs: settings.timeoutMs,
    lifecycleState,
    intervalSeconds,
    locations,
  };
}

function createDomainExpiryMonitor(
  command: CreateMonitorCommand,
  name: string,
  fields: MonitorFieldErrors,
): NewDomainExpiryMonitor {
  let settings: { domainName: string; warningDays: number; timeoutMs: number } = {
    domainName: '',
    warningDays: DOMAIN_EXPIRY_WARNING_LIMITS.defaultDays,
    timeoutMs: DOMAIN_EXPIRY_TIMEOUT_LIMITS.defaultMs,
  };
  try {
    settings = parseDomainExpiryMonitorSettings({
      domainName: command.domainName,
      warningDays: command.domainWarningDays ?? DOMAIN_EXPIRY_WARNING_LIMITS.defaultDays,
      timeoutMs: command.timeoutMs ?? DOMAIN_EXPIRY_TIMEOUT_LIMITS.defaultMs,
    });
  } catch (error) {
    if (!(error instanceof DomainExpiryInputError)) throw error;
    Object.assign(fields, error.fields);
  }
  const lifecycleState = normalizeInitialLifecycleState(command.lifecycleState, fields);
  const intervalSeconds =
    command.intervalSeconds === undefined
      ? MONITOR_INTERVAL_LIMITS.maximumSeconds
      : normalizeIntervalSeconds(command.intervalSeconds, fields, true);
  const incompatibleFields = [
    command.url,
    command.host,
    command.port,
    command.dnsName,
    command.dnsRecordType,
    command.dnsExpectedValues,
    command.statusPolicy,
    command.tlsPolicy,
    command.method,
    command.followRedirects,
    command.requestHeaders,
    command.requestBody,
    command.assertions,
    command.workflow,
    command.heartbeat,
    command.locations,
  ];
  if (incompatibleFields.some((value) => value !== undefined)) {
    fields.type = ['Domain expiry monitors cannot include network probe configuration.'];
  }
  if (Object.keys(fields).length > 0) throw new MonitorInputError(fields);
  return {
    type: 'DOMAIN_EXPIRY',
    name,
    domainName: settings.domainName,
    domainWarningDays: settings.warningDays,
    timeoutMs: settings.timeoutMs,
    lifecycleState,
    intervalSeconds,
    locations: ['local'],
  };
}

function createHeartbeatMonitor(
  command: CreateMonitorCommand,
  name: string,
  fields: MonitorFieldErrors,
): NewHeartbeatMonitor {
  let heartbeat: HeartbeatMonitorSettings = {
    schedule: { type: 'INTERVAL', intervalSeconds: 300, graceSeconds: 60 },
    maximumRuntimeSeconds: null,
  };
  try {
    heartbeat = parseHeartbeatMonitorSettings(command.heartbeat);
  } catch (error) {
    if (!(error instanceof HeartbeatInputError)) throw error;
    Object.assign(fields, error.fields);
  }
  const lifecycleState = normalizeInitialLifecycleState(command.lifecycleState, fields);
  const incompatibleFields = [
    command.url,
    command.host,
    command.port,
    command.dnsName,
    command.dnsRecordType,
    command.dnsExpectedValues,
    command.domainName,
    command.domainWarningDays,
    command.statusPolicy,
    command.tlsPolicy,
    command.method,
    command.timeoutMs,
    command.followRedirects,
    command.requestHeaders,
    command.requestBody,
    command.assertions,
    command.workflow,
    command.intervalSeconds,
    command.locations,
  ];
  if (incompatibleFields.some((value) => value !== undefined)) {
    fields.type = ['Heartbeat monitors cannot include outbound check configuration.'];
  }
  if (Object.keys(fields).length > 0) throw new MonitorInputError(fields);
  const intervalSeconds =
    heartbeat.schedule.type === 'INTERVAL' ? heartbeat.schedule.intervalSeconds : 60;
  return {
    type: 'HEARTBEAT',
    name,
    heartbeat,
    lifecycleState,
    timeoutMs: MONITOR_DEFAULTS.timeoutMs,
    intervalSeconds,
    locations: ['local'],
  };
}

function createApiWorkflowMonitor(
  command: CreateMonitorCommand,
  name: string,
  fields: MonitorFieldErrors,
): NewApiWorkflowMonitor {
  let workflow: ApiWorkflowConfigurationInput = { contractVersion: 1, steps: [] };
  try {
    workflow = parseApiWorkflowConfiguration(command.workflow);
  } catch (error) {
    if (!(error instanceof MonitorInputError)) throw error;
    Object.assign(fields, error.fields);
  }
  const intervalSeconds = normalizeIntervalSeconds(command.intervalSeconds, fields, true);
  let locations: string[] = [...MONITOR_DEFAULTS.locations];
  if (command.locations !== undefined) {
    try {
      locations = parseMonitorLocationSettings({ locations: command.locations }).locations;
    } catch (error) {
      if (error instanceof MonitorInputError) Object.assign(fields, error.fields);
      else throw error;
    }
  }
  const lifecycleState = normalizeInitialLifecycleState(command.lifecycleState, fields);
  const incompatibleFields = [
    command.url,
    command.host,
    command.port,
    command.dnsName,
    command.dnsRecordType,
    command.dnsExpectedValues,
    command.domainName,
    command.domainWarningDays,
    command.statusPolicy,
    command.tlsPolicy,
    command.method,
    command.timeoutMs,
    command.followRedirects,
    command.requestHeaders,
    command.requestBody,
    command.assertions,
  ];
  if (incompatibleFields.some((value) => value !== undefined)) {
    fields.type = ['API workflow monitors cannot include single-protocol configuration.'];
  }
  if (Object.keys(fields).length > 0) throw new MonitorInputError(fields);
  return {
    type: 'API_WORKFLOW',
    name,
    workflow,
    lifecycleState,
    timeoutMs: Math.max(...workflow.steps.map((step) => step.timeoutMs)),
    intervalSeconds,
    locations,
  };
}

function createDnsMonitor(
  command: CreateMonitorCommand,
  name: string,
  fields: MonitorFieldErrors,
): NewDnsMonitor {
  let settings: {
    name: string;
    recordType: DnsRecordType;
    expectedValues: string[];
    timeoutMs: number;
  } = {
    name: '',
    recordType: DNS_MONITOR_DEFAULTS.recordType,
    expectedValues: [],
    timeoutMs: DNS_MONITOR_DEFAULTS.timeoutMs,
  };
  try {
    settings = parseDnsMonitorSettings({
      name: command.dnsName,
      recordType: command.dnsRecordType ?? DNS_MONITOR_DEFAULTS.recordType,
      expectedValues: command.dnsExpectedValues ?? DNS_MONITOR_DEFAULTS.expectedValues,
      timeoutMs: command.timeoutMs ?? DNS_MONITOR_DEFAULTS.timeoutMs,
    });
  } catch (error) {
    if (!(error instanceof DnsMonitorInputError)) throw error;
    Object.assign(fields, error.fields);
  }
  const lifecycleState = normalizeInitialLifecycleState(command.lifecycleState, fields);
  const intervalSeconds = normalizeIntervalSeconds(command.intervalSeconds, fields, true);
  let locations: string[] = [...MONITOR_DEFAULTS.locations];
  if (command.locations !== undefined) {
    try {
      locations = parseMonitorLocationSettings({ locations: command.locations }).locations;
    } catch (error) {
      if (error instanceof MonitorInputError) Object.assign(fields, error.fields);
      else throw error;
    }
  }
  const incompatibleFields = [
    command.url,
    command.host,
    command.port,
    command.statusPolicy,
    command.tlsPolicy,
    command.method,
    command.followRedirects,
    command.requestHeaders,
    command.requestBody,
    command.assertions,
    command.workflow,
    command.domainName,
    command.domainWarningDays,
  ];
  if (incompatibleFields.some((value) => value !== undefined)) {
    fields.type = ['DNS monitors cannot include HTTP, TCP, or workflow configuration.'];
  }
  if (Object.keys(fields).length > 0) throw new MonitorInputError(fields);
  return {
    type: 'DNS',
    name,
    dnsName: settings.name,
    dnsRecordType: settings.recordType,
    dnsExpectedValues: settings.expectedValues,
    timeoutMs: settings.timeoutMs,
    lifecycleState,
    intervalSeconds,
    locations,
  };
}

function createTcpMonitor(
  command: CreateMonitorCommand,
  name: string,
  fields: MonitorFieldErrors,
): NewTcpMonitor {
  let settings: { host: string; port: number; timeoutMs: number } = {
    host: '',
    port: 443,
    timeoutMs: MONITOR_DEFAULTS.timeoutMs,
  };
  try {
    settings = parseTcpMonitorSettings({
      host: command.host,
      port: command.port,
      timeoutMs: command.timeoutMs ?? MONITOR_DEFAULTS.timeoutMs,
    });
  } catch (error) {
    if (!(error instanceof TcpMonitorInputError)) throw error;
    Object.assign(fields, error.fields);
  }
  const lifecycleState = normalizeInitialLifecycleState(command.lifecycleState, fields);
  const intervalSeconds = normalizeIntervalSeconds(command.intervalSeconds, fields, true);
  let locations: string[] = [...MONITOR_DEFAULTS.locations];
  if (command.locations !== undefined) {
    try {
      locations = parseMonitorLocationSettings({ locations: command.locations }).locations;
    } catch (error) {
      if (error instanceof MonitorInputError) Object.assign(fields, error.fields);
      else throw error;
    }
  }
  const httpOnlyFields = [
    command.dnsName,
    command.dnsRecordType,
    command.dnsExpectedValues,
    command.domainName,
    command.domainWarningDays,
    command.url,
    command.statusPolicy,
    command.tlsPolicy,
    command.method,
    command.followRedirects,
    command.requestHeaders,
    command.requestBody,
    command.assertions,
    command.workflow,
  ];
  if (httpOnlyFields.some((value) => value !== undefined)) {
    fields.type = ['TCP monitors cannot include HTTP, DNS, or workflow configuration.'];
  }
  if (Object.keys(fields).length > 0) throw new MonitorInputError(fields);
  return {
    type: 'TCP',
    name,
    host: settings.host,
    port: settings.port,
    timeoutMs: settings.timeoutMs,
    lifecycleState,
    intervalSeconds,
    locations,
  };
}

function normalizeMonitorType(value: unknown, fields: MonitorFieldErrors): MonitorType {
  if (value === undefined) return 'HTTP';
  if (typeof value !== 'string' || !MONITOR_TYPES.includes(value as MonitorType)) {
    fields.type = ['Choose HTTP, TCP, DNS, ICMP, API workflow, heartbeat, or domain expiry.'];
    return 'HTTP';
  }
  return value as MonitorType;
}

export interface MonitorScheduleSettings {
  intervalSeconds: number;
}

export interface MonitorLifecycleSettings {
  lifecycleState: MonitorLifecycleState;
}

export function parseMonitorScheduleSettings(value: unknown): MonitorScheduleSettings {
  const fields: MonitorFieldErrors = {};
  if (!hasExactKeys(value, ['intervalSeconds'])) {
    throw new MonitorInputError({
      intervalSeconds: ['Provide exactly intervalSeconds.'],
    });
  }
  const intervalSeconds = normalizeIntervalSeconds(value.intervalSeconds, fields, false);
  if (fields.intervalSeconds) throw new MonitorInputError(fields);
  return { intervalSeconds };
}

export function parseMonitorLifecycleSettings(value: unknown): MonitorLifecycleSettings {
  if (!hasExactKeys(value, ['lifecycleState'])) {
    throw new MonitorInputError({ lifecycleState: ['Provide exactly lifecycleState.'] });
  }
  if (
    typeof value.lifecycleState !== 'string' ||
    !MONITOR_LIFECYCLE_STATES.includes(value.lifecycleState as MonitorLifecycleState)
  ) {
    throw new MonitorInputError({ lifecycleState: ['Choose ENABLED, PAUSED, or ARCHIVED.'] });
  }
  return { lifecycleState: value.lifecycleState as MonitorLifecycleState };
}

function normalizeIntervalSeconds(
  value: unknown,
  fields: MonitorFieldErrors,
  optional: boolean,
): number {
  if (optional && value === undefined) return MONITOR_DEFAULTS.intervalSeconds;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MONITOR_INTERVAL_LIMITS.minimumSeconds ||
    value > MONITOR_INTERVAL_LIMITS.maximumSeconds
  ) {
    fields.intervalSeconds = [
      `Use a whole-number interval from ${MONITOR_INTERVAL_LIMITS.minimumSeconds} to ${MONITOR_INTERVAL_LIMITS.maximumSeconds} seconds.`,
    ];
    return MONITOR_DEFAULTS.intervalSeconds;
  }
  return value;
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const required = [...expected].sort();
  return keys.length === required.length && keys.every((key, index) => key === required[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsWorkspaceSecretReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsWorkspaceSecretReference);
  if (!isRecord(value)) return false;
  if (Object.prototype.hasOwnProperty.call(value, 'secretReference')) return true;
  return Object.values(value).some(containsWorkspaceSecretReference);
}

function normalizeAssertions(value: unknown, fields: MonitorFieldErrors): ResponseAssertions {
  try {
    return parseResponseAssertions(value, MONITOR_DEFAULTS.method);
  } catch (error) {
    if (error instanceof AssertionInputError) {
      fields.assertions = error.issues;
      return { headers: [], textBody: [], jsonBody: [] };
    }
    throw error;
  }
}

function normalizeHeaders(value: unknown, fields: MonitorFieldErrors): RequestHeaderUpdate[] {
  if (value === undefined) return [];

  try {
    const headers = normalizeRequestHeaderUpdates(value);
    assertNoRetainedHeaders(headers);
    return headers;
  } catch (error) {
    if (error instanceof RequestHeaderInputError) {
      fields.requestHeaders = error.issues;
      return [];
    }
    throw error;
  }
}

export function parseHttpStatusPolicy(value: unknown): HttpStatusPolicy {
  const fields: MonitorFieldErrors = {};
  const policy = normalizeStatusPolicy(value, fields);
  if (fields.statusPolicy) throw new MonitorInputError(fields);
  return policy;
}

export function parseHttpMonitorSettings(value: unknown): HttpMonitorSettings {
  const fields: MonitorFieldErrors = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MonitorInputError({
      httpSettings: ['Provide the complete HTTP monitor settings object.'],
    });
  }

  const settings = value as Record<string, unknown>;
  const legacyKeys = ['followRedirects', 'method', 'timeoutMs', 'url'];
  const requestBodyKeys = ['followRedirects', 'method', 'requestBody', 'timeoutMs', 'url'];
  const expectedKeys = [
    'followRedirects',
    'method',
    'requestBody',
    'timeoutMs',
    'tlsPolicy',
    'url',
  ];
  const keys = Object.keys(settings).sort();
  if (!(
    (keys.length === legacyKeys.length && keys.every((key, index) => key === legacyKeys[index])) ||
    (keys.length === requestBodyKeys.length &&
      keys.every((key, index) => key === requestBodyKeys[index])) ||
    (keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]))
  )) {
    fields.httpSettings = [
      'Provide exactly url, method, timeoutMs, followRedirects, requestBody, and tlsPolicy.',
    ];
  }

  const url = normalizeUrl(settings.url, fields);
  const method = normalizeHttpMonitorMethod(settings.method, fields);
  const timeoutMs = normalizeTimeout(settings.timeoutMs, fields);
  const followRedirects = normalizeFollowRedirects(settings.followRedirects, fields);
  const requestBody = normalizeRequestBody(settings.requestBody, method, fields);
  const tlsPolicy =
    settings.tlsPolicy === undefined
      ? undefined
      : normalizeTlsPolicy(settings.tlsPolicy, url, fields, false);

  if (Object.keys(fields).length > 0) throw new MonitorInputError(fields);
  return {
    url,
    method,
    timeoutMs,
    followRedirects,
    requestBody,
    ...(tlsPolicy === undefined ? {} : { tlsPolicy }),
  };
}

function normalizeTlsPolicy(
  value: unknown,
  url: string,
  fields: MonitorFieldErrors,
  optional: boolean,
): TlsCertificatePolicy {
  if (optional && value === undefined) return { ...MONITOR_DEFAULTS.tlsPolicy };
  try {
    const policy = parseTlsCertificatePolicy(value);
    if (policy.type !== 'DISABLED' && !url.startsWith('https://')) {
      fields.tlsPolicy = ['Certificate expiry monitoring requires an HTTPS URL.'];
      return { ...MONITOR_DEFAULTS.tlsPolicy };
    }
    return policy;
  } catch (error) {
    if (error instanceof TlsCertificatePolicyError) {
      fields.tlsPolicy = [error.message];
      return { ...MONITOR_DEFAULTS.tlsPolicy };
    }
    throw error;
  }
}

function normalizeRequestBody(
  value: unknown,
  method: HttpMonitorMethod,
  fields: MonitorFieldErrors,
): HttpRequestBody {
  if (value === undefined) return { type: 'NONE' };
  const fail = (message: string): HttpRequestBody => {
    fields.requestBody = [message];
    return { type: 'NONE' };
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('Choose a valid request body type.');
  }
  const body = value as Record<string, unknown>;
  if (body.type === 'NONE' && hasExactKeys(body, ['type'])) return { type: 'NONE' };
  if (method === 'GET' || method === 'HEAD') {
    return fail(`${method} monitors cannot send a request body.`);
  }
  if (body.type === 'JSON' && hasExactKeys(body, ['type', 'value'])) {
    if (typeof body.value !== 'string' || body.value.trim() === '') {
      return fail('Enter a JSON request body.');
    }
    try {
      JSON.parse(body.value);
    } catch {
      return fail('Enter valid JSON.');
    }
    if (utf8Bytes(body.value) > HTTP_REQUEST_BODY_LIMIT_BYTES) {
      return fail('Keep the encoded request body at 64 KB or less.');
    }
    return { type: 'JSON', value: body.value };
  }
  if (body.type === 'FORM_URLENCODED' && hasExactKeys(body, ['fields', 'type'])) {
    if (!Array.isArray(body.fields) || body.fields.length === 0 || body.fields.length > 50) {
      return fail('Provide one to 50 form fields.');
    }
    const fieldsList: Array<{ name: string; value: string }> = [];
    for (const field of body.fields) {
      if (
        !hasExactKeys(field, ['name', 'value']) ||
        typeof field.name !== 'string' ||
        typeof field.value !== 'string' ||
        field.name.trim() === ''
      ) {
        return fail('Every form field needs a name and string value.');
      }
      fieldsList.push({ name: field.name.trim(), value: field.value });
    }
    const encoded = new URLSearchParams(
      fieldsList.map(({ name, value }) => [name, value]),
    ).toString();
    if (utf8Bytes(encoded) > HTTP_REQUEST_BODY_LIMIT_BYTES) {
      return fail('Keep the encoded request body at 64 KB or less.');
    }
    return { type: 'FORM_URLENCODED', fields: fieldsList };
  }
  if (body.type === 'RAW' && hasExactKeys(body, ['contentType', 'type', 'value'])) {
    const contentType = normalizeRawContentType(body.contentType);
    if (contentType === null) {
      return fail('Enter a valid content type for the raw body.');
    }
    if (typeof body.value !== 'string' || utf8Bytes(body.value) > HTTP_REQUEST_BODY_LIMIT_BYTES) {
      return fail('Keep the raw request body at 64 KB or less.');
    }
    return { type: 'RAW', contentType, value: body.value };
  }
  return fail('Choose none, JSON, form URL encoded, or raw request body.');
}

function normalizeRawContentType(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '' || /[\r\n]/u.test(value)) return null;
  return value.trim();
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeStatusPolicy(value: unknown, fields: MonitorFieldErrors): HttpStatusPolicy {
  if (value === undefined) return { type: 'ANY_2XX' };

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fields.statusPolicy = ['Choose a valid expected-status policy.'];
    return { type: 'ANY_2XX' };
  }

  const policy = value as Record<string, unknown>;
  if (policy.type === 'ANY_2XX') return { type: 'ANY_2XX' };

  if (policy.type !== 'EXACT' || !Array.isArray(policy.statusCodes)) {
    fields.statusPolicy = ['Choose any 2xx response or provide specific status codes.'];
    return { type: 'ANY_2XX' };
  }

  if (
    policy.statusCodes.length === 0 ||
    policy.statusCodes.some(
      (code) => !Number.isInteger(code) || (code as number) < 100 || (code as number) > 599,
    )
  ) {
    fields.statusPolicy = ['Enter one or more integer status codes from 100 to 599.'];
    return { type: 'ANY_2XX' };
  }

  return {
    type: 'EXACT',
    statusCodes: [...new Set(policy.statusCodes as number[])].sort((left, right) => left - right),
  };
}

function normalizeName(value: unknown, fields: MonitorFieldErrors): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fields.name = ['Enter a monitor name.'];
    return '';
  }

  const name = value.trim();
  if (name.length > 120) fields.name = ['Use 120 characters or fewer.'];
  return name;
}

function normalizeHttpMonitorMethod(value: unknown, fields: MonitorFieldErrors): HttpMonitorMethod {
  if (!isHttpMonitorMethod(value)) {
    fields.method = [`Choose ${HTTP_MONITOR_METHODS.join(', ')}.`];
    return 'GET';
  }
  return value;
}

function normalizeInitialLifecycleState(
  value: unknown,
  fields: MonitorFieldErrors,
): 'ENABLED' | 'PAUSED' {
  if (value === undefined) return MONITOR_DEFAULTS.lifecycleState;
  if (value !== 'ENABLED' && value !== 'PAUSED') {
    fields.lifecycleState = ['Choose enabled or paused.'];
    return MONITOR_DEFAULTS.lifecycleState;
  }
  return value;
}

function normalizeTimeout(value: unknown, fields: MonitorFieldErrors): number {
  if (!Number.isInteger(value) || (value as number) < 1_000 || (value as number) > 30_000) {
    fields.timeoutMs = ['Enter an integer timeout from 1,000 to 30,000 milliseconds.'];
    return MONITOR_DEFAULTS.timeoutMs;
  }
  return value as number;
}

function normalizeFollowRedirects(value: unknown, fields: MonitorFieldErrors): boolean {
  if (typeof value !== 'boolean') {
    fields.followRedirects = ['Choose whether Watchrail should follow redirects.'];
    return MONITOR_DEFAULTS.followRedirects;
  }
  return value;
}

function normalizeUrl(value: unknown, fields: MonitorFieldErrors): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fields.url = ['Enter an HTTP or HTTPS URL.'];
    return '';
  }

  if (value.length > 2_048) {
    fields.url = ['Use 2,048 characters or fewer.'];
    return '';
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      fields.url = ['Use an HTTP or HTTPS URL.'];
      return '';
    }
    if (!url.hostname) {
      fields.url = ['Enter a URL with a hostname.'];
      return '';
    }
    if (url.username || url.password) {
      fields.url = ['Credentials are not allowed in the URL.'];
      return '';
    }
    return url.toString();
  } catch {
    fields.url = ['Enter a valid absolute URL.'];
    return '';
  }
}
import {
  assertNoRetainedHeaders,
  isEncryptedHeaderValueV1,
  normalizeRequestHeaderUpdates,
  parseStoredRequestHeaders,
  RequestHeaderInputError,
  type RequestHeaderUpdate,
} from './request-header.js';
