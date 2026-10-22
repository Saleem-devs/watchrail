# Backend Development Guide

## Feature structure

New user-facing API features use a pragmatic feature module:

```text
apps/api/src/modules/<feature>/
├── dto/                         # strict runtime request schemas and inferred input types
├── <feature>.controller.ts      # HTTP mapping, authorization, validation, response envelope
├── <feature>.service.ts         # application workflow and persistence error translation
├── <feature>.presenter.ts       # safe response allow-list
└── <feature>.module.ts          # provider ownership and infrastructure imports
```

Add files only when the responsibility exists. A small feature does not need every directory or an
interface for every class.

## Source organization

`apps/api/src/app.module.ts` and `main.ts` remain at the application root.
Common NestJS infrastructure is grouped under `auth/`, `config/`,
`infrastructure/database/` and `infrastructure/mail/`. Shared reusable
rate-limiting implementation lives in `common/rate-limiting/`.

Feature-specific controllers, application services, presenters, transport schemas,
and their colocated unit tests live under `modules/<feature>/`. In particular,
monitor services belong with monitor HTTP endpoints; probe machine authentication,
identity, and coordination services belong with probe endpoints; and the
public/internal status-page API owns its read service and HTTP cache utilities.

These paths express ownership, not an additional application layer. Keep explicit
NestJS injection tokens and the existing root middleware/global-guard registrations.
Do not move the distributed probe engine, transactions, workers, or database
repositories merely to mirror the HTTP directory structure.

## Responsibilities

### Controller

- declares routes and permission requirements;
- validates path, query, and body input at the HTTP boundary;
- obtains organization authority from `RequestWithContext`;
- invokes one application-service operation; and
- returns the established `{ data: ... }` envelope.

Controllers do not query repositories, implement transactions, or expose database records directly.

### DTO schema

- uses a strict runtime schema for untrusted input;
- rejects unknown keys unless compatibility explicitly requires them;
- exports the inferred TypeScript input type; and
- describes transport shape, not persistence entities.

Zod validation failures use `VALIDATION_FAILED`. Domain validation remains authoritative for product
rules that are also used by workers or repositories.

### Application service

- coordinates a focused use case;
- accepts a server-derived `RequestContext` and typed input;
- calls organization-scoped repositories;
- owns application-level error translation; and
- leaves multi-write atomicity inside an explicit repository transaction or transaction service.

Do not create generic CRUD base services. Similar-looking operations often have different
authorization, idempotency, and transaction requirements.

### Presenter

A presenter maps internal records to a public allow-list. It serializes dates and omits tenant IDs,
credentials, encrypted fields, internal claim tokens, and other persistence-only state. Public and
authenticated projections may use different presenters.

### Repository and domain

`packages/db` owns schema-aware persistence, organization-scoped queries, row locking, constraints,
and transaction boundaries. `packages/domain` owns pure parsing and state-machine rules that have
multiple application consumers. Neither package imports from an application.

## Dependency injection

Feature modules own their controllers and services and import `DatabaseModule` or another explicit
infrastructure module. Constructor dependencies always use `@Inject(Token)`. This is required because
the development `tsx` runtime must not depend on emitted design metadata.

The root module is the composition boundary for global guards and middleware. It should not own every
feature service.

## Multi-tenancy and authorization

Every protected request follows this sequence:

```text
authenticated user or API credential
→ active organization membership
→ @RequirePermission(...)
→ RequestContext.organizationId
→ organization-scoped repository operation
```

Rules:

- never trust `organizationId`, membership, role, or permissions from a request body;
- use not-found responses when revealing foreign-resource existence would leak tenant data;
- include organization identity in database lookups and relational constraints;
- machine-probe authentication remains separate from operator authentication; and
- public/internal endpoints explicitly opt out of the global operator guard and enforce their own
  boundary.

## Errors and responses

- Successful JSON responses use `{ data: value }` unless an established endpoint contract differs.
- Expected errors include a stable uppercase `code` and a safe `message`.
- Validation errors use `VALIDATION_FAILED` and structured `fields`.
- Do not return stack traces, raw database errors, encrypted values, secrets, or sensitive upstream
  response content.
- Translate known persistence/domain errors close to the application service; let unexpected errors
  reach the global exception boundary.

## Transactions and idempotency

Transactions follow business atomicity, not file or layer boundaries. If a state transition must
commit with an outbox event, both belong in the same PostgreSQL transaction. Do not hold transactions
open across HTTP or Redis operations.

Every queue, retry, webhook, machine submission, and externally replayable command documents its
idempotency key or database uniqueness guarantee. Preserve fencing tokens and database locks in
distributed workflows.

## Testing

- colocate unit tests with pure parsers, presenters, services, and utilities;
- keep API integration tests under `apps/api/test` as `*.integration.spec.ts`;
- test PostgreSQL locking, migrations, constraints, and rollback with real PostgreSQL;
- name tests after observable behavior;
- keep security, tenant isolation, idempotency, and concurrency regressions explicit; and
- extract fixtures only when doing so makes behavior clearer.

A reference feature should normally cover strict input rejection, organization isolation, permission
enforcement, safe serialization, known error translation, and its primary success workflow.

## Formatting and comments

Prettier owns layout; ESLint owns correctness; TypeScript owns type safety. Generated migration
metadata is excluded from formatting and validated by migration tests.

Comments explain why: security boundaries, concurrency, transaction semantics, compatibility, and
non-obvious product invariants. Delete comments that narrate imports, method names, or obvious control
flow. Avoid separator banners and decorative file headers.

## Adding a feature

1. Identify the domain rule, transport contract, tenant boundary, and transaction boundary.
2. Add strict request schemas and stable error codes.
3. Add a feature module with thin controllers and focused services.
4. Use an explicit presenter for response allow-listing.
5. Add the cheapest tests that prove behavior, plus real PostgreSQL tests where database behavior is
   part of correctness.
6. Register the module and any required middleware at the composition root.
7. Run formatting, lint, typecheck, relevant tests, integration tests, and `git diff --check`.
