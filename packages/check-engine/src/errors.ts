import { HTTP_CHECK_TIMEOUT_LIMITS } from './types.js';
import type { HttpTargetFailure } from './types.js';

export class InvalidHttpMethodError extends Error {
  constructor(method: unknown) {
    super(`Unsupported HTTP method: ${String(method)}`);
    this.name = 'InvalidHttpMethodError';
  }
}

export class InvalidHttpTimeoutError extends Error {
  readonly timeoutMs: unknown;

  constructor(timeoutMs: unknown) {
    const { minMs, maxMs } = HTTP_CHECK_TIMEOUT_LIMITS;
    super(
      `HTTP timeout must be an integer between ${minMs} and ${maxMs} milliseconds; received ${String(timeoutMs)}`,
    );
    this.name = 'InvalidHttpTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class HttpTargetFailureError extends Error {
  readonly failure: HttpTargetFailure;

  constructor(failure: HttpTargetFailure, options?: ErrorOptions) {
    super(`HTTP target failure: ${failure.reason}`, options);
    this.name = 'HttpTargetFailureError';
    this.failure = failure;
  }
}
