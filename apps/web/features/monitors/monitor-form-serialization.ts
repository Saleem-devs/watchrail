import { statusPolicyFromForm } from './formatting';
import { responseAssertionsFromForm } from './response-assertions';

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
  const sensitiveIds = new Set(
    formData.getAll('requestHeaderSensitive').map((value) => formEntryString(value)),
  );

  return names.map((name, index) => {
    const headerName = formEntryString(name);
    const id = formEntryString(ids[index]);
    const value = formEntryString(values[index]);
    const sensitive = sensitiveIds.has(id);
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
