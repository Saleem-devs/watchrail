import { statusPolicyFromForm } from './formatting';
import { responseAssertionsFromForm } from './response-assertions';
import type { ApiWorkflowConfiguration } from './types';

export function requiresStateChangingMethodConfirmation(method: string): boolean {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
}

export function tcpSettingsFromForm(formData: FormData) {
  return {
    host: formEntryString(formData.get('host') ?? undefined),
    port: Number(formData.get('port')),
    timeoutMs: Number(formData.get('timeoutSeconds')) * 1_000,
  };
}

export function icmpSettingsFromForm(formData: FormData) {
  return {
    host: formEntryString(formData.get('host') ?? undefined),
    timeoutMs: Number(formData.get('timeoutSeconds')) * 1_000,
  };
}

export function keywordSettingsFromForm(formData: FormData) {
  return {
    url: formEntryString(formData.get('url') ?? undefined),
    keyword: normalizeKeywordLineEndings(formEntryString(formData.get('keyword') ?? undefined)),
    match: formEntryString(formData.get('keywordMatch') ?? undefined),
    timeoutMs: Number(formData.get('timeoutSeconds')) * 1_000,
    followRedirects: formData.get('followRedirects') === 'on',
  };
}

function normalizeKeywordLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

export function keywordConfigurationTestFromForm(formData: FormData) {
  const settings = keywordSettingsFromForm(formData);
  return {
    httpSettings: {
      url: settings.url,
      method: 'GET',
      timeoutMs: settings.timeoutMs,
      followRedirects: settings.followRedirects,
      requestBody: { type: 'NONE' },
      tlsPolicy: { type: 'DISABLED' },
    },
    statusPolicy: { type: 'ANY_2XX' },
    requestHeaders: [],
    assertions: {
      headers: [],
      textBody: [
        {
          operator: settings.match === 'NOT_CONTAINS' ? 'not_contains' : 'contains',
          target: { value: settings.keyword, sensitive: false },
        },
      ],
      jsonBody: [],
    },
  };
}

export function dnsSettingsFromForm(formData: FormData) {
  return {
    name: formEntryString(formData.get('dnsName') ?? undefined),
    recordType: formEntryString(formData.get('dnsRecordType') ?? undefined),
    expectedValues: formData
      .getAll('dnsExpectedValue')
      .flatMap((value) => formEntryString(value).split(','))
      .map((value) => value.trim())
      .filter(Boolean),
    timeoutMs: Number(formData.get('timeoutSeconds')) * 1_000,
  };
}

export function domainExpirySettingsFromForm(formData: FormData) {
  return {
    domainName: formEntryString(formData.get('domainName') ?? undefined),
    warningDays: Number(formData.get('domainWarningDays')),
    timeoutMs: Number(formData.get('timeoutSeconds')) * 1_000,
  };
}

export function domainExpiryCreateSettingsFromForm(formData: FormData) {
  const settings = domainExpirySettingsFromForm(formData);
  return {
    domainName: settings.domainName,
    domainWarningDays: settings.warningDays,
    timeoutMs: settings.timeoutMs,
  };
}

export function heartbeatSettingsFromForm(formData: FormData) {
  const type = formData.get('heartbeatScheduleType') === 'CRON' ? 'CRON' : 'INTERVAL';
  const graceSeconds = Number(formData.get('heartbeatGraceMinutes')) * 60;
  return {
    schedule:
      type === 'CRON'
        ? {
            type,
            expression: formEntryString(formData.get('heartbeatCronExpression') ?? undefined),
            timezone: formEntryString(formData.get('heartbeatTimezone') ?? undefined),
            graceSeconds,
          }
        : {
            type,
            intervalSeconds: Number(formData.get('heartbeatIntervalMinutes')) * 60,
            graceSeconds,
          },
    maximumRuntimeSeconds:
      formData.get('heartbeatRuntimeEnabled') === 'on'
        ? Number(formData.get('heartbeatMaximumRuntimeMinutes')) * 60
        : null,
  };
}

export function httpConfigurationTestFromForm(formData: FormData) {
  return {
    httpSettings: {
      url: urlFromMonitorForm(formData),
      method: formEntryString(formData.get('method') ?? undefined),
      timeoutMs: Number(formData.get('timeoutSeconds')) * 1_000,
      followRedirects: formData.get('followRedirects') === 'on',
      requestBody: requestBodyFromForm(formData),
      tlsPolicy: tlsPolicyFromForm(formData),
    },
    statusPolicy: statusPolicyFromForm(formData),
    requestHeaders: requestHeadersFromForm(formData),
    assertions: responseAssertionsFromForm(formData),
  };
}

export function apiWorkflowFromForm(formData: FormData): ApiWorkflowConfiguration {
  const value = formData.get('apiWorkflow');
  if (typeof value !== 'string' || value.length === 0) {
    return { contractVersion: 1, steps: [] };
  }
  return JSON.parse(value) as ApiWorkflowConfiguration;
}

export function tlsPolicyFromForm(formData: FormData) {
  if (formData.get('tlsExpiryEnabled') !== 'on') return { type: 'DISABLED' } as const;
  return {
    type: 'MINIMUM_VALIDITY' as const,
    days: Number(formData.get('tlsExpiryDays')),
  };
}

export function requestHeadersFromForm(formData: FormData): Array<Record<string, unknown>> {
  const names = formData.getAll('requestHeaderName');
  const values = formData.getAll('requestHeaderValue');
  const ids = formData.getAll('requestHeaderId');
  const storedValues = formData.getAll('requestHeaderHasStoredValue');
  const sources = formData.getAll('requestHeaderSource');
  const secretIds = formData.getAll('requestHeaderSecretId');
  const sensitiveIds = new Set(
    formData.getAll('requestHeaderSensitive').map((value) => formEntryString(value)),
  );

  return names.map((name, index) => {
    const headerName = formEntryString(name);
    const id = formEntryString(ids[index]);
    const value = formEntryString(values[index]);
    const sensitive = sensitiveIds.has(id);
    if (sources[index] === 'VAULT') {
      return {
        name: headerName,
        sensitive: true,
        secretReference: { contractVersion: 1, secretId: formEntryString(secretIds[index]) },
      };
    }
    if (storedValues[index] === 'true' && value === '') {
      return { name: headerName, sensitive: true, retain: true };
    }
    return { name: headerName, sensitive, value };
  });
}

export function requestBodyFromForm(formData: FormData): Record<string, unknown> {
  const type = formEntryString(formData.get('requestBodyType') ?? undefined);
  if (type === 'JSON')
    return { type, value: formEntryString(formData.get('requestBodyValue') ?? undefined) };
  if (type === 'RAW') {
    return {
      type,
      contentType: formEntryString(formData.get('requestBodyContentType') ?? undefined),
      value: formEntryString(formData.get('requestBodyValue') ?? undefined),
    };
  }
  if (type === 'FORM_URLENCODED') {
    const names = formData.getAll('requestBodyFieldName');
    const values = formData.getAll('requestBodyFieldValue');
    return {
      type,
      fields: names.map((name, index) => ({
        name: formEntryString(name),
        value: formEntryString(values[index]),
      })),
    };
  }
  return { type: 'NONE' };
}

export function urlFromMonitorForm(formData: FormData): string {
  const rawUrl = formEntryString(formData.get('url') ?? undefined);
  try {
    const url = new URL(rawUrl);
    const names = formData.getAll('queryParameterName');
    const values = formData.getAll('queryParameterValue');
    for (const [index, name] of names.entries()) {
      url.searchParams.append(formEntryString(name), formEntryString(values[index]));
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function formEntryString(value: FormDataEntryValue | undefined): string {
  return typeof value === 'string' ? value : '';
}
