# API Contract Standardization

## Scope and compatibility

This document records the **current** `/api` HTTP boundaries. Standardization must not silently
change endpoint URLs, verbs, status codes, authentication, cursor encoding, cache policy, or
accepted payloads. A breaking contract needs a separately reviewed versioning plan.

This work is about HTTP contracts and feature ownership. The database repositories, distributed
check engine, scheduler, probe leases, incident transitions, durable outboxes, and webhook delivery
are not part of the refactor.

## API boundaries

| Area | HTTP entry points | Validation authority | Security boundary |
| --- | --- | --- | --- |
| Monitor settings | `/api/monitors`, `/:monitorId/*-settings`, lifecycle, headers, assertions, locations | `@watchrail/domain` parsing and service error mapping | Operator auth, active organization, permission decorators |
| Monitor history, uptime, incidents | `/api/monitors/:monitorId/check-rounds`, `/incidents`, `/uptime` | Strict existing query parsers in `@watchrail/db` | Operator auth and organization-scoped reads |
| Probe location, enrollment, agent administration | `/api/probe-locations`, `/probe-enrollments`, `/probe-agents` | Existing `ProbeIdentityService` strict parsers | Operator auth and scoped repositories |
| Probe machine | `/api/probe-machine/*` | `@watchrail/contracts` versioned parsers and `ProbeCoordinatorService` | Separate probe-machine auth, lease tokens, no-store, rate limiting |
| Public status pages | `/api/public/status-pages/:slug` | Published-page lookup, slug parser and public projection | Anonymous access, rate limiting, ETag, cache control |
| Internal status pages | `/api/internal/status-pages/:slug` | Published-page lookup | Constant-time internal token check, no-store, rate limiting |
| Status page management | `/api/status-pages/*` | Zod DTOs + domain invariants | Operator auth, organization-scoped repositories |
| Webhook settings and delivery history | `/api/webhook-endpoints/*` | Zod DTOs + repository/query validation | Operator auth, permission decorators, encrypted secrets |
| API credentials | `/api/api-credentials/*` | Zod DTOs + service permission/expiry checks | Operator auth, human-session-only mutations |
| Organizations, members, invitations | `/api/organizations/*` | Zod DTOs + Better Auth business rules | Operator auth, active organization and Better Auth session |

## Response conventions

- Successful JSON responses use `{ "data": value }`.
- Paginated reads use `{ "data": [], "page": { "nextCursor": string | null } }`.
- Existing `204 No Content`, `202 Accepted`, `304 Not Modified`, and endpoint-specific
  cache headers must be preserved.
- Authenticated responses use explicit presenter allow-lists. Never spread database rows or
  serialize credentials, encrypted fields, internal claim tokens, or persistence-only metadata.
- Public status pages use the versioned public projection and retain their ETag/freshness behavior.
- Probe-machine responses use their existing machine-specific contract; the enrollment and
  rotation endpoints return a credential once, never on later reads.

## Error conventions

- Known application errors use a stable uppercase `code` and a safe `message`.
- Zod transport validation uses `VALIDATION_FAILED` and `fields` keyed to the existing
  feature convention, where each field value is a `string[]`.
- Keep existing domain-specific error codes and response bodies where clients rely on them.
  Do not force `INVALID_HISTORY_QUERY`, `INVALID_REQUEST`, resource-not-found codes,
  or probe-machine authentication errors through a newly invented universal error shape.
- The global guard must fail closed on protected routes without a permission policy.
- Foreign organization resources must not leak existence through response differences.

## Validation ownership

Use strict Zod transport DTOs for new operator API features where the public transport shape
is known. For established monitor and probe APIs, domain parsers already own behavior, semantic
validation, and feature-specific field errors. The consolidated refactor deliberately keeps
those existing parsers until a separate contract-equivalence test proves a Zod migration is
compatible. **Do not stack conflicting validators** merely for visual consistency.

Keep the API's input DTO separate from the domain entity and the database row. The
`@watchrail/contracts` package owns versioned inter-service and probe-agent wire contracts;
it is not a place to move every HTTP DTO.

## Regression gate

For each refactored capability, verify unchanged route/method/permission metadata, success
envelopes, pagination, redaction, tenant isolation, error code/field shape, and cache/security
headers. The root `pnpm test:integration` gate must pass in one run; individual passing
Testcontainers suites are useful diagnostics but do not replace the full gate. Run format check,
lint, typecheck, unit suite, builds, migrations, and `git diff --check` before merge.
