# Watchrail ICMP Check Contract

## Status

This document defines the observable behavior of one Watchrail ping attempt. ICMP is a dedicated
monitor type with its own execution policy (`icmp-v1`) and probe engine
(`watchrail-icmp-v1`). It is not implemented as a TCP port check.

## Configuration

```text
Target            Public hostname, IPv4 address, or IPv6 address
Timeout           5 seconds by default
Minimum timeout   1 second
Maximum timeout   30 seconds
Request count     One ICMP echo request per address attempt
```

Targets are stored without a URL scheme, path, credentials, or IPv6 brackets. Monitor configuration
is immutable per execution round, so edits do not change an already-created round.

## Network safety

Watchrail resolves a hostname through the same outbound-network policy used by other public checks.
Every candidate address is validated before execution. Loopback, private, link-local, reserved, cloud
metadata, and other prohibited destinations produce an indeterminate result and are never passed to
the ping process.

The executor receives the validated IP addresses rather than resolving the hostname again. This
prevents a second uncontrolled DNS lookup and closes the DNS-rebinding gap between validation and
execution.

## Attempt outcome

One attempt produces `PASS`, `FAIL`, or `UNKNOWN`:

```text
PASS       A validated address returned an ICMP echo reply.
FAIL       The target did not reply before the deadline or was authoritatively unreachable.
UNKNOWN    Watchrail could not obtain trustworthy evidence because ICMP execution was unavailable
           or an internal probe failure occurred.
```

Stable classifications are:

| Outcome | Stage | Reason |
|---|---|---|
| `PASS` | `ICMP` | `PING_REPLIED` |
| `FAIL` | `ICMP` | `PING_TIMEOUT` |
| `FAIL` | `ICMP` | `PING_HOST_UNREACHABLE` |
| `FAIL` | `DNS` | `NAME_NOT_FOUND` |
| `UNKNOWN` | `DNS` | `PROHIBITED_DESTINATION` |
| `UNKNOWN` | `PROBE` | `ICMP_UNAVAILABLE` |
| `UNKNOWN` | `PROBE` | `INTERNAL_ERROR` |

`ICMP_UNAVAILABLE` never marks the target down. It means the probe image, host kernel, or container
runtime could not provide the capability needed to send an ICMP echo request.

## Deadline and evidence

The configured timeout is one wall-clock deadline covering DNS resolution and all address attempts.
Trying another resolved address does not reset the deadline.

Successful replies retain:

```text
response_time_ms     elapsed time for the successful echo request
attempt_duration_ms  total attempt time including resolution and preceding address attempts
checked_at           the attempt's authoritative timestamp
```

Failed and indeterminate attempts retain no fabricated response time.

## Local and remote execution

Local worker execution and remote probe execution use the same check engine and result contract.
Remote assignments require `watchrail-icmp-v1`; older agents cannot claim them. Multi-location
rounds use the existing regional confirmation and aggregate-health policy, so a replay or retry does
not become a new regional observation.

The probe-agent container installs `iputils`. A deployment must also allow the container to send
ICMP echo requests (commonly through the runtime's `NET_RAW` capability or an equivalent platform
policy). If the capability is absent, Watchrail reports `ICMP_UNAVAILABLE` rather than a target
failure.
