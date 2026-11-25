import { createHmac, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  StatusPageDomainRepository,
  StatusDomainConflictError,
  StatusDomainInputError,
  StatusPageNotFoundError,
  normalizeStatusHostname,
  type StatusPageDomainRecord,
} from '@watchrail/db';
import { NodeHttpExecutor } from '@watchrail/check-engine';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { verifyStatusDomainDns } from './status-domain-dns.js';

@Injectable()
export class StatusDomainsService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private refreshing = false;
  onModuleInit() {
    if (!process.env.STATUS_DOMAIN_CNAME_TARGET || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.refresh(), 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      for (const row of await this.domains.dueChecks()) {
        try {
          await this.verify(row.organizationId, row.statusPageId);
        } catch {
          /* Retry on the next sweep; expiry fails closed. */
        }
      }
    } catch {
      new Logger(StatusDomainsService.name).warn(
        'Custom-domain refresh failed; existing verification will expire.',
      );
    } finally {
      this.refreshing = false;
    }
  }

  constructor(
    @Inject(StatusPageDomainRepository) private readonly domains: StatusPageDomainRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  private target() {
    const target = normalizeStatusHostname(process.env.STATUS_DOMAIN_CNAME_TARGET ?? '');
    if (!target)
      throw new ServiceUnavailableException(
        'Custom domains are not configured on this installation.',
      );
    return target;
  }
  async find(org: string, page: string) {
    const domain = await this.run(() => this.domains.find(org, page));
    const binding = domain ? await this.domains.resolve(domain.hostname) : null;
    const fresh = (at: Date | null) => at !== null && at.getTime() > Date.now() - 86_400_000;
    return {
      domain,
      cnameTarget: process.env.STATUS_DOMAIN_CNAME_TARGET ?? null,
      ownershipVerified: !!domain && fresh(domain.verifiedAt),
      routingVerified: !!domain && fresh(domain.routingVerifiedAt),
      httpsReady: binding?.httpsReady ?? false,
    };
  }
  async attach(org: string, page: string, hostname: unknown) {
    const target = this.target();
    if (typeof hostname !== 'string') throw new BadRequestException('Enter a customer subdomain.');
    const host = normalizeStatusHostname(hostname);
    const reserved = [
      target,
      ...(process.env.STATUS_DOMAIN_RESERVED_HOSTNAMES ?? '')
        .split(',')
        .map((host) => host.trim().toLowerCase()),
      ...(process.env.FRONTEND_URL ?? 'http://localhost:3010')
        .split(',')
        .map((url) => new URL(url.trim()).hostname),
    ];
    if (!host || reserved.includes(host))
      throw new BadRequestException(
        'Enter a customer subdomain, not an apex, wildcard or Watchrail host.',
      );
    await this.run(() => this.domains.attach(org, page, host));
    return this.find(org, page);
  }
  async remove(org: string, page: string) {
    await this.run(() => this.domains.remove(org, page));
    return { removed: true };
  }
  async verify(org: string, page: string) {
    const target = this.target();
    const claimed = await this.run(() => this.domains.claimCheck(org, page));
    if (!claimed)
      throw new ConflictException('Wait 30 seconds before checking again, or add a domain first.');
    const evidence = await verifyStatusDomainDns(
      claimed.hostname,
      claimed.verificationToken,
      target,
    );
    const updated = await this.domains.recordCheck(
      claimed,
      evidence.ownership,
      evidence.routing,
      evidence.error,
    );
    if (updated && evidence.ownership && evidence.routing) await this.checkHttps(updated);
    return this.find(org, page);
  }
  private async checkHttps(domain: StatusPageDomainRecord) {
    let ready = false;
    const challenge = randomBytes(32).toString('hex');
    const proof = createHmac('sha256', this.config.publicStatusPageInternalToken)
      .update(`status-domain:${domain.id}:${challenge}`)
      .digest('hex');
    try {
      const result = await new NodeHttpExecutor().execute({
        url: `https://${domain.hostname}/`,
        method: 'GET',
        requestHeaders: [{ name: 'x-watchrail-domain-challenge', value: challenge }],
        followRedirects: false,
        signal: AbortSignal.timeout(20_000),
        captureResponseBody: false,
      });
      ready =
        result.type === 'RESPONSE' &&
        result.statusCode === 200 &&
        result.headers.some(
          (header) =>
            header.name.toLowerCase() === 'x-watchrail-domain-proof' &&
            header.values.includes(proof),
        );
    } catch {
      /* Unreachable/invalid TLS never means Ready. */
    }
    await this.domains.recordHttps(domain, ready);
  }
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof StatusPageNotFoundError)
        throw new NotFoundException('Status page not found.');
      if (error instanceof StatusDomainConflictError) throw new ConflictException(error.message);
      if (error instanceof StatusDomainInputError) throw new BadRequestException(error.message);
      throw error;
    }
  }
}
