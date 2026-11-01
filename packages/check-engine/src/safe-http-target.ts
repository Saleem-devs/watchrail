import { resolveSafeNetworkTarget } from './safe-network-target.js';
import type { DnsResolver, ValidatedAddress } from './safe-network-target.js';

export type { DnsAddress, DnsResolver, ValidatedAddress } from './safe-network-target.js';
export { ProhibitedDestinationError } from './safe-network-target.js';

export interface ResolvedHttpTarget {
  url: URL;
  hostname: string;
  port: number;
  addresses: readonly ValidatedAddress[];
}

export class InvalidHttpTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidHttpTargetError';
  }
}

export async function resolveSafeHttpTarget(
  input: string | URL,
  options: { signal: AbortSignal; resolver?: DnsResolver },
): Promise<ResolvedHttpTarget> {
  const url = validateHttpTargetUrl(input);
  const target = await resolveSafeNetworkTarget(url.hostname, options);

  return {
    url,
    hostname: target.hostname,
    port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
    addresses: target.addresses,
  };
}

export function validateHttpTargetUrl(input: string | URL): URL {
  let url: URL;

  try {
    url = input instanceof URL ? new URL(input) : new URL(input);
  } catch {
    throw new InvalidHttpTargetError('The HTTP target must be an absolute URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidHttpTargetError('The HTTP target must use HTTP or HTTPS.');
  }

  if (url.username !== '' || url.password !== '') {
    throw new InvalidHttpTargetError('The HTTP target must not contain embedded credentials.');
  }

  return url;
}
