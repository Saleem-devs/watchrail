import { BlockList, isIP } from 'node:net';

/** Explicit proxy addresses/subnets only. Never trust a hop count or arbitrary forwarding headers. */
export function trustedProxyPredicate(value: string | undefined): (address: string) => boolean {
  const list = new BlockList();
  for (const entry of (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const [address, prefix, extra] = entry.split('/');
    const version = isIP(address!);
    const width = version === 4 ? 32 : 128;
    if (
      !version ||
      extra !== undefined ||
      (prefix !== undefined &&
        (!/^\d+$/u.test(prefix) || Number(prefix) < 1 || Number(prefix) > width))
    ) {
      throw new Error(
        'API_TRUSTED_PROXIES must contain explicit IP addresses or nonzero CIDR ranges.',
      );
    }
    const family = version === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(address!, family);
    else list.addSubnet(address!, Number(prefix), family);
  }
  return (address) => {
    const normalized =
      address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
    const version = isIP(normalized);
    return version !== 0 && list.check(normalized, version === 4 ? 'ipv4' : 'ipv6');
  };
}
