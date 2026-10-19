# Application Architecture Audit

## Scope and baseline

This audit covers the API, worker, domain, database, contracts, tests, and repository tooling at
commit `bf225bf`. It distinguishes maintainability risks from preferences and does not propose a
rewrite of Watchrail's monitoring engine.

The baseline on 19 October 2026 was:

- lint: passing;
- typecheck: passing;
- formatting: failing on three authored files and eight generated Drizzle metadata files;
- API source: 5,669 lines in a flat directory, with a 536-line monitor controller;
- API integration tests: eight files, including a 1,101-line monitor suite; and
- database source: several intentionally substantial repositories around locking and distributed
  execution, including a 1,014-line probe coordinator.

Generated Drizzle snapshots are not hand-authored source. They should be excluded from Prettier and
validated through migration tests instead.

## Findings

### P1 — API provider ownership is centralized in the root module

**Impact:** high · **Risk:** medium · **Effort:** incremental

`AppModule` owns controllers, services, rate limiters, middleware, database infrastructure, and the
global authorization guard. This makes dependency ownership unclear and increases the chance that a
new feature is partially registered or accidentally coupled to unrelated providers.

**Recommendation:** migrate one feature at a time into feature modules. A feature module owns its
controllers and application services and imports infrastructure modules explicitly. `AppModule`
should remain the composition root for cross-cutting middleware and global guards.

### P1 — Request validation and error shapes are inconsistent

**Impact:** high · **Risk:** medium · **Effort:** medium

Some controllers accept `unknown` and delegate handwritten parsing to services. Other routes rely on
Nest pipes or Better Auth validation. Error bodies usually contain stable codes, but their field
formats and construction are not shared.

**Recommendation:** define strict Zod request schemas beside each feature, validate at the controller
boundary, and pass typed inputs into services. Preserve `{ data: ... }` success envelopes and stable
error codes. Introduce shared error utilities only after two features demonstrate the same need.

### P1 — Tenant and permission conventions are correct but implicit

**Impact:** high · **Risk:** high · **Effort:** low

The authorization guard, request context, composite database keys, and organization-scoped
repositories provide strong isolation. However, the required call pattern is not documented close to
the API architecture, so a contributor could accept organization IDs from request bodies or use an
unscoped repository lookup.

**Recommendation:** document the mandatory flow: authenticated identity → active membership →
permission decorator → server-derived organization context → organization-scoped repository method.
Never use a request-body organization ID as authority.

### P2 — Presentation mapping is mixed into controllers

**Impact:** medium · **Risk:** low · **Effort:** low

Several controllers contain response mapping functions. This makes allow-list review harder and can
couple HTTP serialization to persistence records.

**Recommendation:** use a feature-local presenter for non-trivial responses. Presenters are explicit
allow-lists and must not expose persistence entities directly.

### P2 — A few API files and suites contain several responsibilities

**Impact:** medium · **Risk:** medium · **Effort:** medium

`monitors.controller.ts` combines monitor settings, execution, history, incidents, uptime, and
regional evidence. Its integration suite mirrors that breadth. The probe identity controller holds
four distinct route groups. These are real cohesion issues, not line-count problems alone.

**Recommendation:** split by HTTP capability while retaining one feature module and the existing
application services. Split integration suites by externally observable capability and share only
deterministic setup helpers. Do not split transaction-heavy database repositories solely by size.

### P2 — Explicit injection is required by the development runtime

**Impact:** medium · **Risk:** high · **Effort:** low

The `tsx` runtime does not provide reliable emitted constructor metadata. Missing `@Inject(...)`
annotations previously caused runtime-only undefined dependencies despite successful typechecking.

**Recommendation:** require explicit injection tokens for every constructor dependency and keep the
metadata regression test until the runtime/toolchain changes.

### P2 — Formatting enforcement includes generated metadata

**Impact:** medium · **Risk:** low · **Effort:** low

Prettier checked generated Drizzle snapshots and journal files, producing failures that contributors
should not resolve by rewriting generated artifacts.

**Recommendation:** exclude generated metadata and format authored TypeScript. Keep lint, formatting,
and typechecking as separate gates.

### P3 — Test setup is duplicated

**Impact:** medium · **Risk:** low · **Effort:** medium

API integration suites repeatedly configure encryption keyrings, containers, migrations, and Nest
applications. Immediate global abstraction would hide important differences, but stable environment
and application factories would reduce noise.

**Recommendation:** extract helpers only for setup that is demonstrably identical across at least two
suites. Keep test data local when it explains behavior.

### P3 — Documentation mixes target and current state

**Impact:** medium · **Risk:** low · **Effort:** low

The architecture documentation describes intended `/api/v1` paths and generated clients while the
current application still uses `/api`. These are valuable targets but can be mistaken for current
behavior.

**Recommendation:** label target-state sections explicitly and record current module conventions in
a separate backend guide.

## Boundaries intentionally preserved

The worker roles, transactional outboxes, scheduler claims, check engine, probe leases, regional
evidence, aggregate finalization, incident transitions, availability accounting, and authentication
state machines are not CRUD modules. Their transaction and concurrency boundaries should remain
visible. Refactoring them requires a specific defect or measured maintainability benefit plus their
existing PostgreSQL and integration tests.

## Increment plan

1. Establish formatting exclusions and fix authored baseline failures.
2. Document backend module, contract, tenancy, testing, and comment conventions.
3. Refactor private status-page settings as the first feature module.
4. Next candidates: webhook settings, API credentials, and organization management.
5. Defer monitors, probes, and execution infrastructure until smaller modules validate the pattern.
