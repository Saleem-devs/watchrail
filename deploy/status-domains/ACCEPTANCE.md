# Custom-domain verification record — 2026-11-25

Branch: `feature/status-page-custom-domains`. Migration: `0067_status_page_domains.sql`.

## Automated checks

Commands run from the repository root:

- `pnpm --filter @watchrail/db exec vitest run src/status-page-domain-repository.integration.spec.ts src/status-page-repository.integration.spec.ts src/status-page-subscription-repository.integration.spec.ts` — **34 passing**.
- `pnpm --filter @watchrail/api exec vitest run src/modules/status-pages/status-domain-dns.spec.ts src/modules/status-pages/status-domains.service.spec.ts test/status-pages.integration.spec.ts` — **18 passing**, including 8 real PostgreSQL API integrations.
- `pnpm --filter @watchrail/web test` — **184 passing**.
- `pnpm --filter @watchrail/api test` — **129 passing**.
- `pnpm --filter @watchrail/db test:migrations` — migration-chain test passed.
- API, database and web typechecks passed. `pnpm --filter @watchrail/web build` passed. Targeted ESLint passed. Impeccable detector returned no findings; screenshots were also inspected.
- `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s deploy/status-domains -p 'test_*.py'` — **4 passing**, covering reserved hosts and configuration injection.
- Reference Caddyfile validated with `caddy:2.11.2-alpine`; the adapted policy has on-demand permission checking, TLS-ALPN-01, disabled HTTP-01 and strict SNI/Host checking. Tested image digest: `sha256:834468128c7696cec0ceea6172f7d692daf645ae51983ca76e39da54a97c570d`.

These are focused database/API integration runs, not a claim that the entire integration suite was rerun.

## Connected local acceptance

The existing development web ran on 3010. An isolated API on 4012 used development identity and the local database, leaving the original API on 4000 unchanged. Playwright Chrome forwarded browser API calls to 4012 without cookies; it used real API/database responses, not mocked domain data. This verifies the domain workflow, not production session authentication.

Desktop (1440px) and mobile (390px): added a hostname, displayed its exact CNAME/TXT instructions, checked negative DNS results, verified separate pending states and checked page overflow. The mobile DNS layout was refined to stacked records and inspected again. Screenshot artifacts are local `/tmp/watchrail-domain-desktop.png` and `/tmp/watchrail-domain-mobile.png` and are not committed.

For TLS, temporary local containers ran Nginx SNI passthrough with PROXY protocol into Caddy, then the actual Next.js status page. A second SNI host represented the existing-application fallback. Ports were isolated on loopback 19443. Caddy used a **test-only internal CA** and a two-minute leaf lifetime. DNS evidence for `status.customer-example.com` was installed as a synthetic fixture; no public DNS ownership or production issuance is claimed.

Connected Node HTTPS/curl checks trusted only that test root and verified:

- HTTP 200 with the correct page content and binding-specific HMAC challenge response.
- Existing-application SNI fallback remained reachable.
- Wrong Host/SNI returned 421; authenticated application routes and another page's slug returned 404.
- An unverified hostname could not obtain a certificate.
- The connection failed when the test root was not trusted.
- Certificate files were identical immediately after restarting Caddy. The Docker network-sharing fixture needed its Nginx container reattached after restart; the Linux production reference uses host networking instead.
- A later request renewed the short-lived certificate after restart/idle time; Caddy reported successful renewal and the client validated the new leaf. This verifies internal-CA renewal, not a production ACME renewal cycle.
- Unpublication blocked requests even with a cached certificate. Republishing did not restore Ready. Removing the binding blocked the hostname while retaining the primary status page.

Local scripts and CA artifacts live under `/tmp/watchrail-tls-qa/`; they are acceptance fixtures, not deployed infrastructure. The production verifier retains the normal trust store, public destination protections and no-redirect rule. No insecure production override was introduced.

## Boston VPS public HTTPS acceptance

On 2026-11-25 UTC the shared Boston VPS started serving [Custom-domain HTTPS QA](https://status-qa.seleemabdulsalam.com/) through Caddy. A dedicated production-mode QA API, Next.js web app and PostgreSQL database serve the original QA page and its binding. Only the scoped fixture was transferred. Verification timestamps started empty, and the deployed API checked the published TXT, CNAME and HTTPS evidence again.

- At 23:19:41 UTC the deployed API recorded ownership verified, routing verified and HTTPS Ready after its fresh binding-specific HMAC challenge.
- Staging ACME issuance succeeded first. Production Let’s Encrypt then issued a leaf for the exact QA hostname (issuer YE1, expiry 2027-02-23 22:20:47 UTC). A public request through DNS returned HTTP 200 with system TLS validation. Fresh Chrome negotiated TLS 1.3, displayed “Custom-domain HTTPS QA” and “QA service”, and loaded the incident history and subscription form. QA email uses a private sink.
- Nginx owns public 443 and forwards eligible QA SNI to Caddy. All other TLS hosts use the existing Nginx vhosts. The two-hour stream idle timeout preserves existing long-lived WebSocket connections. API, web, Caddy and the existing TLS backends listen on loopback. QA Postgres has a private volume and no published port.
- Both existing HTTPS applications returned HTTP 200 in all 69 probe rounds across the cutover. Their original certificates, HTTP redirects and client-IP logging passed verification. Both application containers kept running, and both Certbot renewal dry runs succeeded.
- Caddy stores certificates in a persistent volume and manages renewal. The first renewal of the public QA certificate remains a future production observation.
