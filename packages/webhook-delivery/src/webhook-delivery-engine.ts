import {
  InvalidHttpTargetError,
  ProhibitedDestinationError,
  resolveSafeHttpTarget,
  UndiciPinnedHttpTransport,
  type DnsResolver,
  type PinnedHttpTransport,
} from '@watchrail/check-engine';

export type WebhookAttemptFailureCode =
  | 'INVALID_TARGET'
  | 'PROHIBITED_DESTINATION'
  | 'REQUEST_TIMEOUT'
  | 'NETWORK_FAILURE'
  | 'INTERNAL_ERROR';

export type WebhookDeliveryAttemptResult =
  | { type: 'HTTP'; statusCode: number }
  | { type: 'FAILURE'; errorCode: WebhookAttemptFailureCode; terminal: boolean };

export interface WebhookDeliveryEngineOptions {
  transport?: PinnedHttpTransport;
  resolver?: DnsResolver;
}

export class WebhookDeliveryEngine {
  private readonly transport: PinnedHttpTransport;
  private readonly resolver: DnsResolver | undefined;

  constructor(options: WebhookDeliveryEngineOptions = {}) {
    this.transport = options.transport ?? new UndiciPinnedHttpTransport();
    this.resolver = options.resolver;
  }

  async deliver(input: {
    url: string;
    body: Uint8Array;
    headers: readonly { name: string; value: string }[];
    timeoutMs: number;
  }): Promise<WebhookDeliveryAttemptResult> {
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)
      throw new RangeError('Webhook delivery timeout must be a positive safe integer.');
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new WebhookDeliveryDeadlineExceededError()),
      input.timeoutMs,
    );
    try {
      const target = await resolveSafeHttpTarget(input.url, {
        signal: controller.signal,
        ...(this.resolver === undefined ? {} : { resolver: this.resolver }),
      });
      const response = await this.transport.request({
        target,
        method: 'POST',
        signal: controller.signal,
        headers: input.headers,
        body: input.body,
      });
      await response.discardBody();
      return { type: 'HTTP', statusCode: response.statusCode };
    } catch (error) {
      if (
        error instanceof WebhookDeliveryDeadlineExceededError ||
        controller.signal.reason instanceof WebhookDeliveryDeadlineExceededError
      )
        return { type: 'FAILURE', errorCode: 'REQUEST_TIMEOUT', terminal: false };
      if (error instanceof ProhibitedDestinationError)
        return { type: 'FAILURE', errorCode: 'PROHIBITED_DESTINATION', terminal: true };
      if (error instanceof InvalidHttpTargetError)
        return { type: 'FAILURE', errorCode: 'INVALID_TARGET', terminal: true };
      return {
        type: 'FAILURE',
        errorCode: isExpectedNetworkError(error) ? 'NETWORK_FAILURE' : 'INTERNAL_ERROR',
        terminal: false,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

class WebhookDeliveryDeadlineExceededError extends Error {
  constructor() {
    super('Webhook delivery deadline exceeded.');
    this.name = 'WebhookDeliveryDeadlineExceededError';
  }
}

function isExpectedNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return (
    typeof code === 'string' ||
    error.name === 'AbortError' ||
    error.name === 'TypeError' ||
    error.name.startsWith('UND_ERR_')
  );
}
