import { Resolver } from 'node:dns/promises';
import type { DnsQueryInput, DnsQueryResolver } from './dns-types.js';

export class NodeDnsQueryResolver implements DnsQueryResolver {
  async resolve(input: DnsQueryInput): Promise<string[]> {
    if (input.signal.aborted) throw input.signal.reason ?? new Error('DNS query aborted.');
    const resolver = new Resolver();
    const answers = await resolveRecords(resolver, input);
    if (input.signal.aborted) throw input.signal.reason ?? new Error('DNS query aborted.');
    return answers;
  }
}

async function resolveRecords(resolver: Resolver, input: DnsQueryInput): Promise<string[]> {
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
