import { describe, expect, it } from 'vitest';
import {
  createMonitor,
  MONITOR_DEFAULTS,
  MonitorInputError,
  parseHttpMonitorSettings,
  parseHttpConfigurationTest,
  parseStoredApiWorkflowConfiguration,
  parseMonitorLifecycleSettings,
  parseMonitorLocationSettings,
  parseMonitorScheduleSettings,
} from './monitor.js';
import {
  HeartbeatInputError,
  parseHeartbeatMonitorSettings,
  parseHeartbeatSignal,
  redactHeartbeatSignal,
} from './heartbeat.js';

describe('heartbeat monitoring contracts', () => {
  it('creates interval and cron heartbeat monitors without outbound routing', () => {
    expect(
      createMonitor({
        type: 'HEARTBEAT',
        name: 'Nightly backup',
        heartbeat: {
          schedule: { type: 'INTERVAL', intervalSeconds: 300, graceSeconds: 60 },
          maximumRuntimeSeconds: 3_600,
        },
      }),
    ).toMatchObject({
      type: 'HEARTBEAT',
      name: 'Nightly backup',
      lifecycleState: 'ENABLED',
      locations: ['local'],
    });

    expect(
      parseHeartbeatMonitorSettings({
        schedule: {
          type: 'CRON',
          expression: '0 3 * * *',
          timezone: 'Africa/Lagos',
          graceSeconds: 900,
        },
        maximumRuntimeSeconds: null,
      }),
    ).toMatchObject({ schedule: { type: 'CRON', expression: '0 3 * * *' } });
  });

  it('rejects invalid cron ranges and outbound check configuration', () => {
    expect(() =>
      parseHeartbeatMonitorSettings({
        schedule: {
          type: 'CRON',
          expression: '99 99 * * *',
          timezone: 'UTC',
          graceSeconds: 60,
        },
        maximumRuntimeSeconds: null,
      }),
    ).toThrow(HeartbeatInputError);
    expect(() =>
      createMonitor({
        type: 'HEARTBEAT',
        name: 'Unsafe heartbeat',
        url: 'https://example.com',
        heartbeat: {
          schedule: { type: 'INTERVAL', intervalSeconds: 300, graceSeconds: 60 },
          maximumRuntimeSeconds: null,
        },
      }),
    ).toThrow(MonitorInputError);
  });

  it('bounds and redacts signal metadata before retention', () => {
    const signal = parseHeartbeatSignal({
      type: 'COMPLETE',
      runId: 'backup-42',
      message: 'uploaded with Bearer super-secret-token',
      metadata: {
        rows: 42,
        accessToken: 'short',
        credentials: 'database-password',
      },
    });

    expect(redactHeartbeatSignal(signal)).toEqual({
      type: 'COMPLETE',
      runId: 'backup-42',
      message: 'uploaded with Bearer [REDACTED]',
      metadata: {
        rows: 42,
        accessToken: '[REDACTED]',
        credentials: '[REDACTED]',
      },
    });
  });
});

describe('createMonitor', () => {
  it('creates keyword monitors as fixed GET checks with one literal text assertion', () => {
    expect(
      createMonitor({
        type: 'KEYWORD',
        name: 'Marketing copy',
        url: 'https://example.com/',
        keyword: 'Launch ready',
        match: 'CONTAINS',
        timeoutMs: 7_000,
        followRedirects: false,
      }),
    ).toMatchObject({
      type: 'KEYWORD',
      method: 'GET',
      statusPolicy: { type: 'ANY_2XX' },
      requestBody: { type: 'NONE' },
      keyword: 'Launch ready',
      keywordMatch: 'CONTAINS',
      assertions: {
        textBody: [
          {
            operator: 'contains',
            target: { value: 'Launch ready', sensitive: false },
          },
        ],
      },
    });
  });

  it('rejects HTTP-only customization on a keyword monitor', () => {
    expect(() =>
      createMonitor({
        type: 'KEYWORD',
        name: 'Unsafe keyword check',
        url: 'https://example.com',
        keyword: 'ready',
        keywordMatch: 'CONTAINS',
        method: 'POST',
      }),
    ).toThrow(MonitorInputError);
  });

  it('creates a ping monitor with a normalized public target', () => {
    expect(
      createMonitor({
        type: 'ICMP',
        name: 'Edge reachability',
        host: ' Edge.Example.com ',
        timeoutMs: 3_000,
        intervalSeconds: 60,
      }),
    ).toEqual({
      type: 'ICMP',
      name: 'Edge reachability',
      host: 'edge.example.com',
      timeoutMs: 3_000,
      lifecycleState: 'ENABLED',
      intervalSeconds: 60,
      locations: ['local'],
    });
  });

  it('creates centrally scheduled domain-expiry monitors with a daily default', () => {
    expect(
      createMonitor({
        type: 'DOMAIN_EXPIRY',
        name: 'Primary domain',
        domainName: 'Example.COM.',
        domainWarningDays: 45,
      }),
    ).toEqual({
      type: 'DOMAIN_EXPIRY',
      name: 'Primary domain',
      domainName: 'example.com',
      domainWarningDays: 45,
      timeoutMs: 10_000,
      lifecycleState: 'ENABLED',
      intervalSeconds: 86_400,
      locations: ['local'],
    });
  });

  it('accepts canonical remote multi-location settings and rejects mixed local routing', () => {
    expect(
      parseMonitorLocationSettings({
        locations: ['BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      }),
    ).toEqual({
      locations: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    });
    expect(() =>
      parseMonitorLocationSettings({
        locations: ['local', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      }),
    ).toThrow(MonitorInputError);
  });
  it('normalizes input and applies server-owned defaults', () => {
    expect(createMonitor({ name: '  API  ', url: 'https://example.com/health' })).toEqual({
      type: 'HTTP',
      name: 'API',
      url: 'https://example.com/health',
      ...MONITOR_DEFAULTS,
      requestHeaders: [],
      requestBody: { type: 'NONE' },
      assertions: { headers: [], textBody: [], jsonBody: [] },
      locations: ['local'],
    });
  });

  it('rejects protocol-specific configuration on an HTTP monitor', () => {
    expect(() =>
      createMonitor({
        type: 'HTTP',
        name: 'API',
        url: 'https://example.com',
        dnsName: 'example.com',
      }),
    ).toThrow(MonitorInputError);
  });

  it('accepts an optional creation interval and rejects invalid values', () => {
    expect(
      createMonitor({ name: 'API', url: 'https://example.com', intervalSeconds: 300 })
        .intervalSeconds,
    ).toBe(300);
    expect(() =>
      createMonitor({ name: 'API', url: 'https://example.com', intervalSeconds: '300' }),
    ).toThrow(MonitorInputError);
  });

  it('accepts supported HTTPS certificate-expiry policies and rejects them for HTTP endpoints', () => {
    expect(
      createHttpMonitor({
        name: 'API',
        url: 'https://example.com',
        tlsPolicy: { type: 'MINIMUM_VALIDITY', days: 30 },
      }).tlsPolicy,
    ).toEqual({ type: 'MINIMUM_VALIDITY', days: 30 });

    expect(() =>
      createHttpMonitor({
        name: 'API',
        url: 'http://example.com',
        tlsPolicy: { type: 'MINIMUM_VALIDITY', days: 30 },
      }),
    ).toThrow(MonitorInputError);
    expect(() =>
      createHttpMonitor({
        name: 'API',
        url: 'https://example.com',
        tlsPolicy: { type: 'MINIMUM_VALIDITY', days: 31 },
      }),
    ).toThrow(MonitorInputError);
  });

  it('normalizes assertions and rejects retained assertion secrets during creation', () => {
    expect(
      createHttpMonitor({
        name: 'API',
        url: 'https://example.com',
        assertions: {
          headers: [{ name: 'x-state', operator: 'exists' }],
          textBody: [],
          jsonBody: [],
        },
      }).assertions,
    ).toEqual({
      headers: [{ name: 'x-state', operator: 'exists' }],
      textBody: [],
      jsonBody: [],
    });

    expect(() =>
      createHttpMonitor({
        name: 'API',
        url: 'https://example.com',
        assertions: {
          headers: [],
          textBody: [{ operator: 'equals', target: { sensitive: true, retain: true } }],
          jsonBody: [],
        },
      }),
    ).toThrow(MonitorInputError);
  });

  it('normalizes request headers and rejects retained secrets during creation', () => {
    expect(
      createHttpMonitor({
        name: 'API',
        url: 'https://example.com',
        requestHeaders: [{ name: 'Authorization', sensitive: false, value: 'Bearer secret' }],
      }).requestHeaders,
    ).toEqual([{ name: 'authorization', sensitive: true, value: 'Bearer secret' }]);

    expect(() =>
      createMonitor({
        name: 'API',
        url: 'https://example.com',
        requestHeaders: [{ name: 'Authorization', sensitive: true, retain: true }],
      }),
    ).toThrow(MonitorInputError);
  });

  it.each(['ftp://example.com', 'example.com', 'not a url'])('rejects invalid URL %s', (url) => {
    expect(() => createMonitor({ name: 'API', url })).toThrow(MonitorInputError);
  });

  it('rejects an empty name and URL with field errors', () => {
    try {
      createMonitor({ name: ' ', url: '' });
      expect.unreachable('Expected monitor validation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(MonitorInputError);
      expect((error as MonitorInputError).fields).toEqual({
        name: ['Enter a monitor name.'],
        url: ['Enter an HTTP or HTTPS URL.'],
      });
    }
  });

  it('normalizes an exact status policy into a unique deterministic order', () => {
    const monitor = createHttpMonitor({
      name: 'API',
      url: 'https://example.com',
      statusPolicy: { type: 'EXACT', statusCodes: [404, 200, 404, 204] },
    });

    expect(monitor.statusPolicy).toEqual({ type: 'EXACT', statusCodes: [200, 204, 404] });
  });

  it.each([
    { type: 'EXACT', statusCodes: [] },
    { type: 'EXACT', statusCodes: [99] },
    { type: 'EXACT', statusCodes: [600] },
    { type: 'EXACT', statusCodes: [200.5] },
  ])('rejects invalid exact policy $statusCodes', (statusPolicy) => {
    expect(() => createMonitor({ name: 'API', url: 'https://example.com', statusPolicy })).toThrow(
      MonitorInputError,
    );
  });

  it('creates an enabled API workflow monitor with normalized step configuration', () => {
    const monitor = createMonitor({
      type: 'API_WORKFLOW',
      name: 'Checkout journey',
      workflow: workflowConfiguration(),
    });

    expect(monitor).toMatchObject({
      type: 'API_WORKFLOW',
      lifecycleState: 'ENABLED',
      timeoutMs: 7_000,
      workflow: { contractVersion: 1 },
    });
    if (monitor.type !== 'API_WORKFLOW') throw new Error('Expected an API workflow monitor.');
    expect(monitor.workflow.steps.map((step) => step.id)).toEqual(['authenticate', 'fetch-user']);
    expect(monitor.workflow.steps[1]?.url).toBe('https://api.example.com/users/{{token}}');
  });

  it('rejects unsafe workflow origins and duplicate extractions', () => {
    const unsafe = workflowConfiguration();
    unsafe.steps[1]!.url = 'https:{{token}}.example.com/health';
    expect(() => createMonitor({ type: 'API_WORKFLOW', name: 'Unsafe', workflow: unsafe })).toThrow(
      MonitorInputError,
    );

    const duplicate = workflowConfiguration();
    duplicate.steps[1]!.extractions = [{ variable: 'token', selector: '$.token', sensitive: true }];
    expect(() =>
      createMonitor({ type: 'API_WORKFLOW', name: 'Duplicate', workflow: duplicate }),
    ).toThrow(MonitorInputError);
  });

  it('rejects workflows whose combined step timeouts exceed the execution deadline', () => {
    const workflow = workflowConfiguration();
    workflow.steps.push(
      ...['three', 'four'].map((id) => ({
        ...workflow.steps[1]!,
        id,
        name: id,
        timeoutMs: 30_000,
        extractions: [],
      })),
    );
    workflow.steps[0]!.timeoutMs = 30_000;
    workflow.steps[1]!.timeoutMs = 30_000;

    expect(() => createMonitor({ type: 'API_WORKFLOW', name: 'Too slow', workflow })).toThrow(
      MonitorInputError,
    );
  });

  it.each(['text/plain\r\nx-injected: true', 'application/json\n', '   '])(
    'rejects an invalid Vault-backed raw workflow content type %j',
    (contentType) => {
      const base = workflowConfiguration();
      const workflow = {
        ...base,
        steps: base.steps.map((step, index) =>
          index === 0
            ? {
                ...step,
                requestBody: {
                  type: 'RAW' as const,
                  sensitive: true as const,
                  secretReference: {
                    contractVersion: 1 as const,
                    secretId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                  },
                  contentType,
                },
              }
            : step,
        ),
      };

      expect(() =>
        createMonitor({ type: 'API_WORKFLOW', name: 'Invalid raw body', workflow }),
      ).toThrow(MonitorInputError);
    },
  );

  it('parses the strict stored API workflow contract', () => {
    const workflow = workflowConfiguration();
    expect(
      parseStoredApiWorkflowConfiguration({
        ...workflow,
        steps: workflow.steps.map((step) => ({
          ...step,
          requestBody:
            step.requestBody.type === 'NONE'
              ? step.requestBody
              : {
                  type: step.requestBody.type,
                  sensitive: true,
                  encryptedValue: {
                    version: 1,
                    algorithm: 'AES-256-GCM',
                    keyId: 'active',
                    iv: 'AAAAAAAAAAAAAAAA',
                    ciphertext: 'YQ',
                    authTag: 'AAAAAAAAAAAAAAAAAAAAAA',
                  },
                },
          requestHeaders: [{ name: 'x-environment', sensitive: false, value: 'test' }],
          assertions: { contractVersion: 1, assertions: step.assertions },
        })),
      }),
    ).toMatchObject({ contractVersion: 1, steps: [{ id: 'authenticate' }, { id: 'fetch-user' }] });
  });
});

function workflowConfiguration() {
  return {
    contractVersion: 1 as const,
    steps: [
      {
        id: 'authenticate',
        name: 'Authenticate',
        url: 'https://api.example.com/session',
        method: 'POST' as const,
        timeoutMs: 7_000,
        followRedirects: true,
        statusPolicy: { type: 'ANY_2XX' as const },
        tlsPolicy: { type: 'DISABLED' as const },
        requestHeaders: [
          { name: 'authorization', sensitive: true as const, value: 'Bearer credential' },
        ],
        requestBody: { type: 'JSON' as const, value: '{"username":"saleem"}' },
        assertions: { headers: [], textBody: [], jsonBody: [] },
        extractions: [{ variable: 'token', selector: '$.token', sensitive: true }],
      },
      {
        id: 'fetch-user',
        name: 'Fetch user',
        url: 'https://api.example.com/users/{{token}}',
        method: 'GET' as const,
        timeoutMs: 5_000,
        followRedirects: true,
        statusPolicy: { type: 'ANY_2XX' as const },
        tlsPolicy: { type: 'DISABLED' as const },
        requestHeaders: [],
        requestBody: { type: 'NONE' as const },
        assertions: { headers: [], textBody: [], jsonBody: [] },
        extractions: [],
      },
    ],
  };
}

function createHttpMonitor(command: Parameters<typeof createMonitor>[0]) {
  const monitor = createMonitor(command);
  if (monitor.type !== 'HTTP') throw new Error('Expected an HTTP monitor.');
  return monitor;
}

describe('monitor scheduling settings', () => {
  it.each([60, 86_400])('accepts interval boundary %i', (intervalSeconds) => {
    expect(parseMonitorScheduleSettings({ intervalSeconds })).toEqual({ intervalSeconds });
  });

  it.each([undefined, '60', 59, 86_401, 60.5, 0, -1])(
    'rejects invalid interval %s',
    (intervalSeconds) => {
      expect(() => parseMonitorScheduleSettings({ intervalSeconds })).toThrow(MonitorInputError);
    },
  );

  it('rejects missing and additional schedule properties', () => {
    expect(() => parseMonitorScheduleSettings({})).toThrow(MonitorInputError);
    expect(() => parseMonitorScheduleSettings({ intervalSeconds: 60, nextCheckAt: null })).toThrow(
      MonitorInputError,
    );
  });

  it.each(['ENABLED', 'PAUSED', 'ARCHIVED'] as const)(
    'accepts lifecycle state %s',
    (lifecycleState) => {
      expect(parseMonitorLifecycleSettings({ lifecycleState })).toEqual({ lifecycleState });
    },
  );

  it.each(['enabled', 'DELETED', undefined, null])(
    'rejects invalid lifecycle state %s',
    (lifecycleState) => {
      expect(() => parseMonitorLifecycleSettings({ lifecycleState })).toThrow(MonitorInputError);
    },
  );
});

describe('parseHttpMonitorSettings', () => {
  it('keeps legacy TLS policy omission distinguishable and accepts a validated policy', () => {
    expect(
      parseHttpMonitorSettings({
        url: 'https://example.com',
        method: 'GET',
        timeoutMs: 5_000,
        followRedirects: true,
        requestBody: { type: 'NONE' },
        tlsPolicy: { type: 'MINIMUM_VALIDITY', days: 14 },
      }),
    ).toMatchObject({ tlsPolicy: { type: 'MINIMUM_VALIDITY', days: 14 } });

    expect(
      parseHttpMonitorSettings({
        url: 'https://example.com',
        method: 'GET',
        timeoutMs: 5_000,
        followRedirects: true,
      }),
    ).not.toHaveProperty('tlsPolicy');
  });
  it('accepts the complete strict HTTP settings contract', () => {
    expect(
      parseHttpMonitorSettings({
        url: 'https://api.example.com/health',
        method: 'HEAD',
        timeoutMs: 5_000,
        followRedirects: false,
      }),
    ).toEqual({
      url: 'https://api.example.com/health',
      method: 'HEAD',
      timeoutMs: 5_000,
      followRedirects: false,
      requestBody: { type: 'NONE' },
    });
  });

  it('validates structured request bodies and rejects bodies on GET', () => {
    expect(
      parseHttpMonitorSettings({
        url: 'https://api.example.com/jobs',
        method: 'POST',
        timeoutMs: 5_000,
        followRedirects: true,
        requestBody: { type: 'JSON', value: '{"ready":true}' },
      }).requestBody,
    ).toEqual({ type: 'JSON', value: '{"ready":true}' });

    expect(() =>
      parseHttpMonitorSettings({
        url: 'https://api.example.com/jobs',
        method: 'GET',
        timeoutMs: 5_000,
        followRedirects: true,
        requestBody: { type: 'RAW', contentType: 'text/plain', value: 'payload' },
      }),
    ).toThrow(MonitorInputError);
  });

  it.each([1_000, 30_000])('accepts timeout boundary %i', (timeoutMs) => {
    expect(
      parseHttpMonitorSettings({
        url: 'https://example.com',
        method: 'GET',
        timeoutMs,
        followRedirects: true,
      }).timeoutMs,
    ).toBe(timeoutMs);
  });

  it.each([999, 30_001, 1_000.5, '5000'])('rejects invalid timeout %s', (timeoutMs) => {
    expect(() =>
      parseHttpMonitorSettings({
        url: 'https://example.com',
        method: 'GET',
        timeoutMs,
        followRedirects: true,
      }),
    ).toThrow(MonitorInputError);
  });

  it.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const)(
    'accepts supported method %s',
    (method) => {
      expect(
        parseHttpMonitorSettings({
          url: 'https://example.com',
          method,
          timeoutMs: 5_000,
          followRedirects: true,
        }).method,
      ).toBe(method);
    },
  );

  it.each(['TRACE', 'get', undefined])('rejects unsupported method %s', (method) => {
    expect(() =>
      parseHttpMonitorSettings({
        url: 'https://example.com',
        method,
        timeoutMs: 5_000,
        followRedirects: true,
      }),
    ).toThrow(MonitorInputError);
  });

  it.each(['false', 0, undefined])('rejects non-boolean followRedirects %s', (followRedirects) => {
    expect(() =>
      parseHttpMonitorSettings({
        url: 'https://example.com',
        method: 'GET',
        timeoutMs: 5_000,
        followRedirects,
      }),
    ).toThrow(MonitorInputError);
  });

  it('rejects missing and additional settings', () => {
    expect(() =>
      parseHttpMonitorSettings({
        url: 'https://example.com',
        method: 'GET',
        timeoutMs: 5_000,
      }),
    ).toThrow(MonitorInputError);
    expect(() =>
      parseHttpMonitorSettings({
        url: 'https://example.com',
        method: 'GET',
        timeoutMs: 5_000,
        followRedirects: true,
        statusPolicy: { type: 'ANY_2XX' },
      }),
    ).toThrow(MonitorInputError);
  });
});

describe('parseHttpConfigurationTest', () => {
  it('reuses HTTP, status-policy, and request-header validation while preserving retention markers', () => {
    expect(
      parseHttpConfigurationTest({
        httpSettings: {
          url: 'https://api.example.com/jobs?verbose=true',
          method: 'POST',
          timeoutMs: 5_000,
          followRedirects: true,
          requestBody: { type: 'JSON', value: '{"ready":true}' },
        },
        statusPolicy: { type: 'EXACT', statusCodes: [202] },
        requestHeaders: [{ name: 'Authorization', sensitive: true, retain: true }],
        assertions: { headers: [], textBody: [], jsonBody: [] },
      }),
    ).toMatchObject({
      settings: { method: 'POST', requestBody: { type: 'JSON' } },
      statusPolicy: { type: 'EXACT', statusCodes: [202] },
      requestHeaders: [{ name: 'authorization', sensitive: true, retain: true }],
    });
  });

  it('rejects incomplete and incompatible test configurations', () => {
    expect(() =>
      parseHttpConfigurationTest({ httpSettings: {}, requestHeaders: [], assertions: {} }),
    ).toThrow(MonitorInputError);
    expect(() =>
      parseHttpConfigurationTest({
        httpSettings: {
          url: 'https://api.example.com',
          method: 'HEAD',
          timeoutMs: 5_000,
          followRedirects: true,
          requestBody: { type: 'JSON', value: '{}' },
        },
        statusPolicy: { type: 'ANY_2XX' },
        requestHeaders: [],
        assertions: {},
      }),
    ).toThrow(MonitorInputError);
  });
});
