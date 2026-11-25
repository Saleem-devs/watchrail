# Status-page custom domains (Caddy v1)

One ASCII customer subdomain per status page; apex names, wildcard names, URLs, IP literals and public suffixes are rejected. `tldts` supplies public/private suffix boundaries. Hostnames are canonicalized and globally unique. Every binding has a random TXT challenge. No ownership is inferred from a CNAME alone.

## Application configuration

Set the API's `STATUS_DOMAIN_CNAME_TARGET` to a dedicated hostname such as `status-domains.your-domain.com`. Publish its A record pointing to the ingress host. Publish AAAA only after the IPv6 path passes the same tests. Configure customer DNS in **DNS-only mode** (no CDN proxy):

- `status.customer.com CNAME status-domains.your-domain.com`
- `_watchrail.status.customer.com TXT watchrail-verification=<binding-specific token from the UI>`

The API and web must share `PUBLIC_STATUS_PAGE_INTERNAL_TOKEN` (random 32+ characters in production). Set the API and Caddy `STATUS_DOMAIN_CADDY_ASK_SECRET` to a separate random 32+ character secret. Keep both out of Git and access logs. Caddy permission-error logs can include the ask URL; restrict log access and redact its `key` query parameter in any log export. The ask endpoint is internal; Caddy's protocol requires its secret in the query. Do not publish API port 4000 or Next port 3010 on the VPS.

Set `FRONTEND_URL` on both API and web to the primary Watchrail origin. Customer domains never enter the authenticated dashboard or OAuth trusted-origin list. Set `STATUS_DOMAIN_RESERVED_HOSTNAMES` on the API and the sync job to **every existing Nginx hostname**, the primary Watchrail host, and the CNAME target, comma separated. This prevents a verified customer binding from stealing an existing application's SNI route.

Ownership, CNAME routing and HTTPS evidence are independent. A manual check is rate-limited to once per 30 seconds per binding using a database claim. UUID check tokens fence delayed results, removal/recreation and publication changes. Background sweeps retry pending checks after five minutes and refresh successful checks after six hours. Evidence expires after 24 hours; routing and issuance fail closed when ownership or routing expires. Workers share claims when multiple API instances run. Never-checked bindings need an initial operator check.

Ready requires a successful certificate-valid HTTPS GET to the custom hostname, HTTP 200 and a fresh HMAC challenge response tied to its binding. It uses the existing pinned HTTP executor with destination safety checks, a 20-second deadline and no redirects. The primary address remains available. Subscription email and unsubscribe URLs retain the stable primary origin so removing a custom hostname cannot strand subscribers.

## TLS routing on a shared Nginx host

This reference keeps existing HTTP routing and certificate ownership intact:

```text
Customer browser / ACME TLS-ALPN-01 on public :443
  -> Nginx stream reads SNI and sends PROXY protocol
       explicit verified customer host -> Caddy 127.0.0.1:8443 -> Next 127.0.0.1:3010
       every other host                -> existing Nginx TLS vhosts 127.0.0.1:8444
```

Caddy checks the API ask endpoint before on-demand issuance. Nginx's map is only an ingress optimization; the application and ask endpoint independently check eligibility. Unpublishing/removing a binding denies subsequent page requests even while an old certificate is cached or the map awaits synchronization. Unpublishing also invalidates HTTPS evidence and in-flight verification; republishing requires a fresh HTTPS check before Ready. This does not revoke an already issued certificate or retract content already delivered to a visitor.

## Reviewed cutover required on the shared VPS

These are deployment instructions, **not an automated production installer**. Before execution, inventory `nginx -T`, listeners, firewall rules, Certbot renewal configuration and all application health URLs again. Take a root-readable backup of `/etc/nginx` and `/etc/letsencrypt`. Record the HTTPS response and certificate for each existing application. Preserve its server blocks when moving the TLS listeners.

1. Install the distribution-compatible `libnginx-mod-stream` package and confirm its module-load file is included before a top-level `stream` block. Validate the current config before changing any listeners.
2. Deploy the updated application and apply migration `0067`. Publish container ports explicitly on loopback (`127.0.0.1:4000:4000` and `127.0.0.1:3010:3010`) and verify they are unreachable externally. Do not rely on a generic host firewall rule to override Docker port publishing. Configure the environment above; keep the internal endpoints network-private. For subscription rate limiting set `API_TRUSTED_PROXIES` to only the actual local web/proxy peers; Caddy overwrites forwarded client IP headers. Do not use a blanket trust-all proxy setting.
3. Start this directory's compose service with staging ACME, persistent volumes and operator email. It uses Linux host networking and binds only loopback 8443. Run `docker compose build status-domain-tls`, then `docker compose run --rm status-domain-tls caddy validate --config /etc/caddy/Caddyfile`. The Dockerfile removes the upstream Caddy binary’s low-port file capability so the process can start on port 8443 with all runtime capabilities dropped. The base image is pinned by digest.
4. Prepare an empty `/etc/nginx/watchrail-domains.map`. Copy the sync script to the service's documented path, create root-only `/etc/watchrail/status-domains.env` with the internal token and reserved hostnames, and install the service/timer. Review any path changes before enabling it.
5. In each **existing HTTPS** vhost, replace public 443 listeners with `listen 127.0.0.1:8444 ssl proxy_protocol;`. Preserve all server names, certificates, headers, location rules and upstreams. Add `set_real_ip_from 127.0.0.1; real_ip_header proxy_protocol;` to those loopback TLS vhosts so application logs/rate limits retain client IPs. Remove their old IPv6 443 listeners too; the stream listener accepts both families. Do not apply PROXY protocol to the existing port-80 vhosts.
6. Include `nginx-stream.conf` at the top level of nginx.conf, **outside** `http {}`. Its default goes to the legacy vhosts. Ensure no public HTTP-context 443 listeners remain. Run `nginx -t`, then use a planned reload. If the listener handoff cannot be achieved safely on this Nginx build, stop and schedule an explicit maintenance window rather than forcing a restart.
7. Check both pre-existing applications, certificates, HTTP redirects, client IP logging and `certbot renew --dry-run`. Inspect any Certbot configuration rewrite for reintroduced public 443 listeners. Enable the domain-sync timer. Its atomic map update validates configuration and restores the prior map if validation/reload fails. Fetch/parse failures preserve the prior map; API eligibility still expires closed.
8. Add the QA domain through Watchrail and publish its DNS records. After DNS verification, map synchronization may take a minute. Retry HTTPS after synchronization. Staging certificates intentionally do **not** produce Ready in a normal trust store. Switch `ACME_DIRECTORY` to the production ACME directory and recreate Caddy only after staging issuance succeeds. Keep staging and production certificate storage in distinct compose project volumes; do not delete production volumes to switch issuers.

Port 80 stays with Nginx. TLS-ALPN-01 travels on public 443 through SNI routing to Caddy; HTTP-01 is disabled. This reference promises HTTPS customer addresses, not a catch-all HTTP redirect that would capture other applications. QUIC/HTTP3 is disabled because the ingress example forwards TCP only.

Rollback: stop the sync timer, restore the saved complete Nginx configuration/listeners, run `nginx -t` and reload. Confirm both original applications. Custom-domain availability will stop; primary Watchrail status URLs remain usable. Keep Caddy certificate data and the additive database table. Do not roll back unrelated application configuration.

## Storage and renewal

The named `/data` volume contains private keys, ACME accounts and certificates; `/config` persists Caddy configuration state. Back up both with restrictive permissions and encryption, and rehearse restoration. Do not run `docker compose down -v`. Caddy performs renewal automatically; DNS eligibility refresh and the map timer must remain healthy so ACME challenges can reach it. Monitor Caddy issuance/renewal errors, certificate expiry, sync-job failures, and the application's HTTPS verification results. Alert externally if the API or DNS refresh loop is unavailable long enough to approach the 24-hour eligibility expiry. A failed renewal never justifies disabling certificate verification.

## Acceptance gate

Run focused repository/API/web tests and Caddy config validation. Connected local acceptance must exercise SNI passthrough, the ask gate, TLS trust validation, correct-page routing, mismatched Host/SNI rejection, removal/unpublication, persisted certificates across restart and renewal. An internal test CA validates that chain locally; it is **not evidence of public ACME issuance**.

Before production sign-off: use a real customer subdomain, validate the browser certificate chain without trust overrides, see Ready only on the correct page, refresh incidents and subscriptions, remove/unpublish and confirm denial, and recheck all pre-existing applications. The Boston QA deployment and public acceptance results are recorded in [ACCEPTANCE.md](./ACCEPTANCE.md).

References: [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https), [Caddy TLS configuration](https://caddyserver.com/docs/caddyfile/directives/tls), [Caddy listener options](https://caddyserver.com/docs/caddyfile/options), [Nginx SNI preread](https://nginx.org/en/docs/stream/ngx_stream_ssl_preread_module.html).
