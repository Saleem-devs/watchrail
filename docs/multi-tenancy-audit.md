# Multi-Tenancy Consistency Audit

This audit reviews the `dev` baseline at `ae2af01`. It covers the
**operator identity → active organization → permission → scoped persistence** flow, plus machine
and public boundaries. This is a consistency/security increment, not a redesign of the
execution engine or PostgreSQL schema.

## Tenant authority

| Boundary | Authority | Enforcement | Isolation regression |
| --- | --- | --- | --- |
| User session | Better Auth session active organization | Guard loads current membership and role; denies missing or invalid active organization | `auth.guard.spec.ts`, `identity-auth.integration.spec.ts` |
| API credential | Persisted key hash and organization | Key authentication joins membership on user **and** organization and limits effective scopes by role | `identity-auth.integration.spec.ts`, API credential presenter tests |
| Development identity | Fixed development middleware context | The guard accepts only the middleware's **identical** fixed context; arbitrary prepopulated contexts fail closed | `request-context.spec.ts`, `auth.guard.spec.ts` |
| Monitors and uptime/history/incidents | `RequestContext.organizationId` | Repositories filter by organization and monitor; domain-derived evidence stays within scoped reads | `monitors.integration.spec.ts`, DB read-repository integration tests |
| Status pages and components | Server-derived organization | Scoped page lookup, tenant-consistent component selection and composite PostgreSQL foreign keys | `status-pages.integration.spec.ts`, `status-page-repository.integration.spec.ts` |
| Webhook endpoints and history | Server-derived organization | Scoped endpoint/version lookup, event/delivery joins and encryption context | `webhook-endpoints.integration.spec.ts`, webhook delivery read tests |
| Organizations, members and invitations | Active organization plus Better Auth session | Explicit organization in Better Auth calls; invitation cancellation additionally verifies the invitation belongs to the active organization **before** any Better Auth or outbox side effect | `organizations.service.spec.ts`, `identity-auth.integration.spec.ts` |
| Probe operator APIs | Server-derived organization | Scoped locations/enrollments/agents; tenant-safe DB constraints | `probe-identity.integration.spec.ts`, `probe-persistence.integration.spec.ts` |
| Probe machine APIs | Credential-verified machine identity | Dedicated auth and lease/claim fencing; no operator-context fallback | `probe-identity.integration.spec.ts`, probe coordinator tests |
| Public status pages | Published global slug | Explicit anonymous published projection, separate rate limit, ETag and caching | `public-status-pages.integration.spec.ts` |
| Internal status-page projection | Constant-time internal token comparison | Internal token authentication and separate no-store/rate-limit behavior | `public-status-pages.integration.spec.ts` |

## Findings and changes

1. **Invitation cancellation was scoped implicitly.** The operator endpoint accepted an invitation
   ID and forwarded it to Better Auth; the local service did not verify the active organization
   before calling Better Auth or superseding an invitation outbox entry. Add an organization-scoped
   read of invitation identity, return a stable not-found response for missing/foreign IDs, then
   retain Better Auth and email-outbox behavior on owned invitations. Avoid changing Better Auth's
   state transition or email worker.
2. **The development-context bypass depended on a populated request property.** Only the fixed
   context installed by `DevelopmentIdentityMiddleware` now authorizes the bypass; a different
   prepopulated context is rejected rather than treated as a trusted owner.
3. **Existing isolation is already substantial.** Monitor, status page, webhook, and probe
   repositories use tenant-scoped lookups or composite relational constraints. Do not rewrite
   locking, notification delivery, claim leases or incident transitions without a demonstrated
   defect.

## Required invariants

- Derive organization authority from authenticated session or credential, never client input.
- Authorization must be checked against **membership in the selected organization**.
- Foreign IDs behave like missing resources and never create, mutate or supersede side effects.
- Operator and probe-machine credentials must remain separate security principals.
- Global public slugs are an intentional exception: publication is explicit, and private
  configuration must not be returned anonymously.
- Keep one-time credentials, encrypted values and internal metadata out of response bodies.
- Preserve transactional outboxes, idempotency, fencing and locked state transitions.

## Follow-up limits

This audit is source-level and the added changes still require local formatting, static checks
and an exact full integration run. It does **not** claim to mechanically prove every SQL query
is tenant-scoped, nor to replace a separate security review, threat model or fuzz campaign.
