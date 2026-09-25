import { HTTP_CHECK_TIMEOUT_LIMITS } from './types.js';

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

export class InvalidHttpStatusPolicyError extends Error {
  constructor() {
    super('HTTP status policy is invalid.');
    this.name = 'InvalidHttpStatusPolicyError';
  }
}
