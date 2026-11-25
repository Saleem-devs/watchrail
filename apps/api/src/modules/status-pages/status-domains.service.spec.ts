import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeHttpExecutor, type HttpExecutionResult } from '@watchrail/check-engine';
import { type StatusPageDomainRepository, type StatusPageDomainRecord } from '@watchrail/db';
import { type AppConfig } from '../../config/config.js';
import { StatusDomainsService } from './status-domains.service.js';
import { verifyStatusDomainDns } from './status-domain-dns.js';
vi.mock('./status-domain-dns.js', () => ({ verifyStatusDomainDns: vi.fn() }));
const token = 'internal-proof-key';
const row = {
  id: 'binding-id',
  hostname: 'status.example.com',
  verificationToken: 'dns-token',
  verifiedAt: new Date(),
  routingVerifiedAt: new Date(),
} as StatusPageDomainRecord;
function setup() {
  vi.stubEnv('STATUS_DOMAIN_CNAME_TARGET', 'status.watchrail.dev');
  const repo = {
    claimCheck: vi.fn().mockResolvedValue(row),
    recordCheck: vi.fn().mockResolvedValue(row),
    recordHttps: vi.fn(),
    find: vi.fn().mockResolvedValue(row),
    resolve: vi.fn().mockResolvedValue(null),
  };
  vi.mocked(verifyStatusDomainDns).mockResolvedValue({
    ownership: true,
    routing: true,
    error: null,
  });
  const service = new StatusDomainsService(
    repo as unknown as StatusPageDomainRepository,
    { publicStatusPageInternalToken: token } as AppConfig,
  );
  return { repo, service };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe('HTTPS readiness authorization', () => {
  it('uses certificate-valid pinned HTTPS with no redirects and requires a binding-specific signed response', async () => {
    const { service, repo } = setup();
    const execute = vi.spyOn(NodeHttpExecutor.prototype, 'execute').mockImplementation((input) => {
      expect(input.url).toBe('https://status.example.com/');
      expect(input.followRedirects).toBe(false);
      const challenge = input.requestHeaders![0]!.value;
      return Promise.resolve({
        type: 'RESPONSE',
        statusCode: 200,
        headers: [
          {
            name: 'x-watchrail-domain-proof',
            values: [
              createHmac('sha256', token)
                .update(`status-domain:binding-id:${challenge}`)
                .digest('hex'),
            ],
          },
        ],
      } as unknown as HttpExecutionResult);
    });
    await service.verify('org', 'page');
    expect(execute).toHaveBeenCalledOnce();
    expect(repo.recordHttps).toHaveBeenCalledWith(row, true);
  });
  it.each([200, 302, 500])(
    'does not accept an unsigned/wrong page even with HTTP %s',
    async (statusCode) => {
      const { service, repo } = setup();
      vi.spyOn(NodeHttpExecutor.prototype, 'execute').mockResolvedValue({
        type: 'RESPONSE',
        statusCode,
        headers: [{ name: 'x-watchrail-domain-proof', values: ['wrong'] }],
      } as unknown as HttpExecutionResult);
      await service.verify('org', 'page');
      expect(repo.recordHttps).toHaveBeenCalledWith(row, false);
    },
  );
  it('keeps TLS/network failures pending', async () => {
    const { service, repo } = setup();
    vi.spyOn(NodeHttpExecutor.prototype, 'execute').mockRejectedValue(
      new Error('certificate expired'),
    );
    await service.verify('org', 'page');
    expect(repo.recordHttps).toHaveBeenCalledWith(row, false);
  });
  it('never probes HTTPS without both ownership and routing evidence', async () => {
    const { service, repo } = setup();
    vi.mocked(verifyStatusDomainDns).mockResolvedValue({
      ownership: false,
      routing: true,
      error: 'OWNERSHIP_NOT_VERIFIED',
    });
    const execute = vi.spyOn(NodeHttpExecutor.prototype, 'execute');
    await service.verify('org', 'page');
    expect(execute).not.toHaveBeenCalled();
    expect(repo.recordHttps).not.toHaveBeenCalled();
  });
  it('does not probe a binding removed while DNS verification was running', async () => {
    const { service, repo } = setup();
    repo.recordCheck.mockResolvedValue(null);
    const execute = vi.spyOn(NodeHttpExecutor.prototype, 'execute');
    await service.verify('org', 'page');
    expect(execute).not.toHaveBeenCalled();
  });
});
