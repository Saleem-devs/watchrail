import { lookup as nodeLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export interface DnsAddress {
  address: string;
  family: 4 | 6;
}

export interface DnsResolver {
  lookup(this: void, hostname: string): Promise<readonly DnsAddress[]>;
}

export interface ValidatedAddress {
  address: string;
  family: 4 | 6;
}

export interface ResolvedHttpTarget {
  url: URL;
  hostname: string;
  port: number;
  addresses: readonly ValidatedAddress[];
}

export class ProhibitedDestinationError extends Error {
  constructor() {
    super('The HTTP target resolves to a prohibited destination.');
    this.name = 'ProhibitedDestinationError';
  }
}

export class InvalidHttpTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidHttpTargetError';
  }
}

const defaultResolver: DnsResolver = {
  async lookup(hostname) {
    const answers = await nodeLookup(hostname, { all: true, verbatim: true });
    return answers.map((answer) => {
      if (answer.family !== 4 && answer.family !== 6) {
        throw new Error('DNS lookup returned an unsupported address family.');
      }

      return { address: answer.address, family: answer.family };
    });
  },
};

const prohibitedAddresses = createProhibitedAddressList();

export async function resolveSafeHttpTarget(
  input: string | URL,
  options: { signal: AbortSignal; resolver?: DnsResolver },
): Promise<ResolvedHttpTarget> {
  const url = validateHttpTargetUrl(input);
  const hostname = normalizeHostname(url.hostname);
  const literalFamily = isIP(hostname);
  const answers =
    literalFamily === 0
      ? await abortableLookup(options.resolver ?? defaultResolver, hostname, options.signal)
      : [{ address: hostname, family: literalFamily } as DnsAddress];

  if (answers.length === 0) {
    const error = new Error(`No addresses were returned for ${hostname}.`);
    Object.assign(error, { code: 'ENOTFOUND' });
    throw error;
  }

  const addresses = deduplicateAddresses(answers.map(normalizeAddress));

  if (addresses.some(isProhibitedAddress)) {
    throw new ProhibitedDestinationError();
  }

  return {
    url,
    hostname,
    port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
    addresses,
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

function normalizeHostname(hostname: string): string {
  const unwrapped =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  return isIP(unwrapped) === 6 ? canonicalizeIpv6(unwrapped) : unwrapped.toLowerCase();
}

function normalizeAddress(answer: DnsAddress): ValidatedAddress {
  const actualFamily = isIP(answer.address);

  if (actualFamily === 0 || actualFamily !== answer.family) {
    throw new Error(`Resolver returned an invalid IPv${answer.family} address.`);
  }

  if (actualFamily === 4) {
    return { address: normalizeIpv4(answer.address), family: 4 };
  }

  const canonical = canonicalizeIpv6(answer.address);
  const mappedIpv4 = mappedIpv4Address(canonical);
  return mappedIpv4 === null
    ? { address: canonical, family: 6 }
    : { address: mappedIpv4, family: 4 };
}

function normalizeIpv4(address: string): string {
  return address
    .split('.')
    .map((part) => String(Number(part)))
    .join('.');
}

function canonicalizeIpv6(address: string): string {
  const canonical = new URL(`http://[${address}]`).hostname;
  return canonical.slice(1, -1).toLowerCase();
}

function mappedIpv4Address(address: string): string | null {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(address);
  if (!match) return null;

  const high = Number.parseInt(match[1]!, 16);
  const low = Number.parseInt(match[2]!, 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function deduplicateAddresses(addresses: readonly ValidatedAddress[]): ValidatedAddress[] {
  const seen = new Set<string>();

  return addresses.filter((address) => {
    const key = `${address.family}:${address.address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isProhibitedAddress(address: ValidatedAddress): boolean {
  return prohibitedAddresses.check(address.address, address.family === 4 ? 'ipv4' : 'ipv6');
}

function abortableLookup(
  resolver: DnsResolver,
  hostname: string,
  signal: AbortSignal,
): Promise<readonly DnsAddress[]> {
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });

    void resolver.lookup(hostname).then(
      (addresses) => {
        signal.removeEventListener('abort', onAbort);
        resolve(addresses);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(
          error instanceof Error ? error : new Error('DNS resolver rejected without an Error.'),
        );
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

function createProhibitedAddressList(): BlockList {
  const blockList = new BlockList();

  for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    blockList.addSubnet(network, prefix, 'ipv4');
  }

  for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['::', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const) {
    blockList.addSubnet(network, prefix, 'ipv6');
  }

  return blockList;
}
