import { describe, expect, it } from 'vitest';
import { loadProbeAgentConfig } from './config.js';

describe('loadProbeAgentConfig', () => {
  it('requires only coordinator connectivity and a machine credential', () => {
    expect(
      loadProbeAgentConfig({
        NODE_ENV: 'test',
        PROBE_COORDINATOR_URL: 'http://127.0.0.1:4000',
        PROBE_MACHINE_CREDENTIAL: 'x'.repeat(43),
      }),
    ).toMatchObject({
      coordinatorUrl: 'http://127.0.0.1:4000',
      credential: 'x'.repeat(43),
      enrollment: null,
      credentialFile: null,
    });
  });

  it('supports one-time enrollment bootstrap without central infrastructure secrets', () => {
    expect(
      loadProbeAgentConfig({
        NODE_ENV: 'test',
        PROBE_COORDINATOR_URL: 'http://127.0.0.1:4000',
        PROBE_ENROLLMENT_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        PROBE_ENROLLMENT_TOKEN: 'e'.repeat(43),
        PROBE_CREDENTIAL_FILE: '/run/secrets/watchrail-probe-credential',
      }),
    ).toMatchObject({
      credential: null,
      enrollment: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        token: 'e'.repeat(43),
      },
      credentialFile: '/run/secrets/watchrail-probe-credential',
    });
  });

  it('requires HTTPS outside tests', () => {
    expect(() =>
      loadProbeAgentConfig({
        NODE_ENV: 'production',
        PROBE_COORDINATOR_URL: 'http://coordinator.example',
        PROBE_MACHINE_CREDENTIAL: 'x'.repeat(43),
      }),
    ).toThrow('must use HTTPS');
  });
});
