import { Resolver } from 'node:dns/promises';
import type { DnsQueryInput, DnsQueryResolver } from './dns-types.js';

interface CancellableResolver {
  cancel(): void;
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  resolveCname(hostname: string): Promise<string[]>;
  resolveMx(hostname: string): Promise<Array<{ priority: number; exchange: string }>>;
  resolveNs(hostname: string): Promise<string[]>;
  resolveTxt(hostname: string): Promise<string[][]>;
}

export class NodeDnsQueryResolver implements DnsQueryResolver {
  constructor(private readonly createResolver: () => CancellableResolver = () => new Resolver()) {}

  async resolve(input: DnsQueryInput): Promise<string[]> {
    if (input.signal.aborted) throw input.signal.reason ?? new Error('DNS query aborted.');
    const resolver = this.createResolver();
    const cancel = () => resolver.cancel();
    input.signal.addEventListener('abort', cancel, { once: true });
    try {
      const answers = await resolveRecords(resolver, input);
      if (input.signal.aborted) throw input.signal.reason ?? new Error('DNS query aborted.');
      return answers;
    } finally {
      input.signal.removeEventListener('abort', cancel);
    }
  }
}

async function resolveRecords(
  resolver: CancellableResolver,
  input: DnsQueryInput,
): Promise<string[]> {
  switch (input.recordType) {
    case 'A':
      return resolver.resolve4(input.name);
    case 'AAAA':
      return resolver.resolve6(input.name);
    case 'CNAME':
      return resolver.resolveCname(input.name);
    case 'MX':
      return (await resolver.resolveMx(input.name)).map(
        ({ priority, exchange }) => `${priority} ${exchange}`,
      );
    case 'TXT':
      return (await resolver.resolveTxt(input.name)).map((segments) => segments.join(''));
    case 'NS':
      return resolver.resolveNs(input.name);
  }
}
