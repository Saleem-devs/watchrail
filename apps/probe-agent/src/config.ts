export interface ProbeAgentConfig {
  coordinatorUrl: string;
  credential: string | null;
  enrollment: { id: string; token: string } | null;
  credentialFile: string | null;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  renewalIntervalMs: number;
  requestTimeoutMs: number;
}

export function loadProbeAgentConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ProbeAgentConfig {
  const coordinatorUrl = environment.PROBE_COORDINATOR_URL;
  const credential = environment.PROBE_MACHINE_CREDENTIAL;
  if (!coordinatorUrl) throw new Error('PROBE_COORDINATOR_URL is required.');
  const url = new URL(coordinatorUrl);
  if (url.protocol !== 'https:' && environment.NODE_ENV !== 'test') {
    throw new Error('PROBE_COORDINATOR_URL must use HTTPS.');
  }
  const enrollmentId = environment.PROBE_ENROLLMENT_ID;
  const enrollmentToken = environment.PROBE_ENROLLMENT_TOKEN;
  const credentialFile = environment.PROBE_CREDENTIAL_FILE;
  const validCredential = credential !== undefined && /^[A-Za-z0-9_-]{43}$/u.test(credential);
  const validEnrollment =
    enrollmentId !== undefined &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      enrollmentId,
    ) &&
    enrollmentToken !== undefined &&
    /^[A-Za-z0-9_-]{43}$/u.test(enrollmentToken) &&
    typeof credentialFile === 'string' &&
    credentialFile.startsWith('/');
  if (validCredential === validEnrollment) {
    throw new Error(
      'Configure exactly one of PROBE_MACHINE_CREDENTIAL or PROBE_ENROLLMENT_ID/PROBE_ENROLLMENT_TOKEN.',
    );
  }
  return {
    coordinatorUrl: url.toString().replace(/\/$/u, ''),
    credential: validCredential ? credential : null,
    enrollment: validEnrollment ? { id: enrollmentId, token: enrollmentToken } : null,
    credentialFile: validEnrollment ? credentialFile : null,
    pollIntervalMs: boundedInteger(environment.PROBE_POLL_INTERVAL_MS, 1_000, 60_000, 5_000),
    heartbeatIntervalMs: boundedInteger(
      environment.PROBE_HEARTBEAT_INTERVAL_MS,
      5_000,
      60_000,
      15_000,
    ),
    renewalIntervalMs: boundedInteger(environment.PROBE_RENEWAL_INTERVAL_MS, 5_000, 20_000, 10_000),
    requestTimeoutMs: boundedInteger(
      environment.PROBE_COORDINATOR_REQUEST_TIMEOUT_MS,
      1_000,
      30_000,
      10_000,
    ),
  };
}

function boundedInteger(
  raw: string | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Probe interval must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}
