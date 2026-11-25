import { Resolver } from 'node:dns/promises';
import { normalizeStatusHostname } from '@watchrail/db';

export interface StatusDomainDns {
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
}

/** Only DNS queries are performed: supplied hostnames are never fetched over HTTP. */
export async function verifyStatusDomainDns(
  hostname: string,
  token: string,
  expectedTarget: string,
  dns: StatusDomainDns = new Resolver({ timeout: 1500, tries: 2 }),
): Promise<{ ownership: boolean; routing: boolean; error: string | null }> {
  const host = normalizeStatusHostname(hostname);
  const target = normalizeStatusHostname(expectedTarget);
  if (!host || !target || host === target)
    throw new Error('Invalid custom-domain DNS configuration.');
  const [txt, cname] = await Promise.allSettled([
    dns.resolveTxt(`_watchrail.${host}`),
    dns.resolveCname(host),
  ]);
  const ownership =
    txt.status === 'fulfilled' &&
    txt.value.some((chunks) => chunks.join('') === `watchrail-verification=${token}`);
  const routing =
    cname.status === 'fulfilled' &&
    cname.value.some((value) => value.toLowerCase().replace(/\.$/u, '') === target);
  return {
    ownership,
    routing,
    error: !ownership ? 'OWNERSHIP_NOT_VERIFIED' : !routing ? 'CNAME_NOT_VERIFIED' : null,
  };
}
