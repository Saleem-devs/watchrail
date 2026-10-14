import {
  parseProbeExecutionConfiguration,
  parseProbeLeaseReference,
  type ProbeExecutionConfigurationV1,
  type ProbeLeaseReferenceV1,
  type ProbeResultSubmissionReferenceV1,
} from '@watchrail/contracts';
import type { HttpCheckResult } from '@watchrail/check-engine';

export class ProbeCoordinatorError extends Error {
  constructor(
    readonly kind: 'AUTH' | 'STALE' | 'TRANSIENT' | 'INVALID',
    message = 'Probe coordinator request failed.',
  ) {
    super(message);
    this.name = 'ProbeCoordinatorError';
  }
}

export class ProbeCoordinatorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly credential: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async heartbeat(engineVersion: string, signal?: AbortSignal): Promise<void> {
    await this.request('/api/probe-machine/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ contractVersion: 1, engineVersion }),
      signal: signal ?? null,
    });
  }

  async claim(engineVersion: string, signal?: AbortSignal): Promise<ProbeLeaseReferenceV1 | null> {
    const response = await this.request('/api/probe-machine/leases/claim', {
      method: 'POST',
      body: JSON.stringify({ contractVersion: 1, engineVersion }),
      signal: signal ?? null,
    });
    if (response.status === 204) return null;
    return parseProbeLeaseReference(await responseData(response));
  }

  async configuration(
    lease: ProbeLeaseReferenceV1,
    signal?: AbortSignal,
  ): Promise<ProbeExecutionConfigurationV1> {
    const response = await this.request(
      `/api/probe-machine/leases/${lease.attemptId}/configuration`,
      { method: 'GET', signal: signal ?? null, headers: claimHeader(lease.claimToken) },
    );
    return parseProbeExecutionConfiguration(await responseData(response));
  }

  async renew(lease: ProbeLeaseReferenceV1, engineVersion: string): Promise<void> {
    await this.request(`/api/probe-machine/leases/${lease.attemptId}/renew`, {
      method: 'POST',
      headers: claimHeader(lease.claimToken),
      body: JSON.stringify(reference(lease, engineVersion)),
    });
  }

  async submitSerialized(lease: ProbeLeaseReferenceV1, serializedBody: string): Promise<void> {
    await this.request(`/api/probe-machine/leases/${lease.attemptId}/results`, {
      method: 'POST',
      headers: claimHeader(lease.claimToken),
      body: serializedBody,
    });
  }

  serializeSubmission(
    lease: ProbeLeaseReferenceV1,
    engineVersion: string,
    result: HttpCheckResult,
  ): string {
    return JSON.stringify({
      reference: reference(lease, engineVersion),
      result: { ...result, checkedAt: result.checkedAt.toISOString() },
    });
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.credential}`,
          'content-type': 'application/json',
          ...init.headers,
        },
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ProbeCoordinatorError('TRANSIENT');
    }
    if (response.ok) return response;
    if (response.status === 401 || response.status === 403) throw new ProbeCoordinatorError('AUTH');
    if (response.status === 409) throw new ProbeCoordinatorError('STALE');
    if (response.status >= 500 || response.status === 429)
      throw new ProbeCoordinatorError('TRANSIENT');
    throw new ProbeCoordinatorError('INVALID');
  }
}

export async function enrollProbeAgent(
  baseUrl: string,
  enrollment: { id: string; token: string },
  fetcher: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(`${baseUrl}/api/probe-machine/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollmentId: enrollment.id, token: enrollment.token }),
    });
  } catch {
    throw new ProbeCoordinatorError('TRANSIENT');
  }
  if (!response.ok) {
    throw new ProbeCoordinatorError(response.status >= 500 ? 'TRANSIENT' : 'AUTH');
  }
  const data = await responseData(response);
  if (
    typeof data !== 'object' ||
    data === null ||
    Array.isArray(data) ||
    !('credential' in data) ||
    typeof data.credential !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(data.credential)
  ) {
    throw new ProbeCoordinatorError('INVALID');
  }
  return data.credential;
}

function reference(
  lease: ProbeLeaseReferenceV1,
  engineVersion: string,
): ProbeResultSubmissionReferenceV1 {
  return {
    contractVersion: 1,
    assignmentId: lease.assignmentId,
    attemptId: lease.attemptId,
    attemptNumber: lease.attemptNumber,
    engineVersion,
  };
}

function claimHeader(token: string): Record<string, string> {
  return { 'x-watchrail-claim-token': token };
}

async function responseData(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || Array.isArray(body) || !('data' in body)) {
    throw new ProbeCoordinatorError('INVALID');
  }
  return body.data;
}
