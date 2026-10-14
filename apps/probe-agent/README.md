# Watchrail remote probe agent

The probe agent is a standalone process. It talks only to the Watchrail coordinator over HTTPS and
executes the shared `watchrail-http-v1` engine. It does not need PostgreSQL, Redis, HTTP-header or
assertion encryption keyrings.

Provide either an existing `PROBE_MACHINE_CREDENTIAL`, or a one-time
`PROBE_ENROLLMENT_ID`/`PROBE_ENROLLMENT_TOKEN` pair plus an absolute `PROBE_CREDENTIAL_FILE` path
backed by a protected persistent secret volume. Enrollment credentials are exchanged in memory and the
machine credential is created with mode `0600`. If persistence fails after redemption, an operator must
revoke the agent and issue a new enrollment.

Required production configuration:

```text
PROBE_COORDINATOR_URL=https://watchrail.example.com
PROBE_MACHINE_CREDENTIAL=<43-character base64url credential>
```

The runtime sends heartbeats independently, claims one fenced lease at a time, renews while the check
is executing, and retries transient result-submission failures using the exact same serialized body.
Authentication or stale-lease responses stop that claim from being submitted.
