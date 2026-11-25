import { describe, it, expect, vi } from 'vitest';
import { verifyStatusDomainDns } from './status-domain-dns.js';

describe('custom-domain DNS verification', () => {
  it('requires the exact challenge at the exact owner name and accepts split TXT chunks', async () => {
    const dns = {
      resolveTxt: vi.fn().mockResolvedValue([['watchrail-', 'verification=secret']]),
      resolveCname: vi.fn().mockResolvedValue(['STATUS.WATCHRAIL.DEV.']),
    };
    expect(
      await verifyStatusDomainDns('status.example.com', 'secret', 'status.watchrail.dev', dns),
    ).toEqual({ ownership: true, routing: true, error: null });
    expect(dns.resolveTxt).toHaveBeenCalledExactlyOnceWith('_watchrail.status.example.com');
    expect(dns.resolveCname).toHaveBeenCalledExactlyOnceWith('status.example.com');
  });
  it('does not treat routing alone as ownership', async () => {
    const dns = {
      resolveTxt: vi.fn().mockResolvedValue([['watchrail-verification=someone-else']]),
      resolveCname: vi.fn().mockResolvedValue(['status.watchrail.dev']),
    };
    expect(
      await verifyStatusDomainDns('status.example.com', 'secret', 'status.watchrail.dev', dns),
    ).toEqual({ ownership: false, routing: true, error: 'OWNERSHIP_NOT_VERIFIED' });
  });
  it('does not match CNAME suffixes and treats unavailable DNS as unverified', async () => {
    const dns = {
      resolveTxt: vi.fn().mockResolvedValue([['watchrail-verification=secret']]),
      resolveCname: vi.fn().mockResolvedValue(['status.watchrail.dev.evil.com']),
    };
    expect(
      (await verifyStatusDomainDns('status.example.com', 'secret', 'status.watchrail.dev', dns))
        .error,
    ).toBe('CNAME_NOT_VERIFIED');
    dns.resolveTxt.mockRejectedValue(new Error('timeout'));
    expect(
      (await verifyStatusDomainDns('status.example.com', 'secret', 'status.watchrail.dev', dns))
        .ownership,
    ).toBe(false);
  });
});
