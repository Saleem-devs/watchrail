# Webhook delivery contract

Watchrail webhook delivery is at least once. A receiver may see the same logical delivery more than
once when provider acceptance is ambiguous or an acknowledgement is lost.

## Identity and deduplication

Every request includes these identity headers:

- `x-watchrail-event-id`: the originating incident event.
- `x-watchrail-delivery-sequence`: `0` for the opening or resolution notification, then `1`, `2`, or
  `3` for configured reminders of an opening event.
- `x-watchrail-delivery-id`: the stable endpoint-specific delivery record.

Use `(x-watchrail-event-id, x-watchrail-delivery-sequence)` as the logical notification key. This
keeps intentional reminders distinct from the opening notification. Use `x-watchrail-delivery-id` to
deduplicate retry attempts for that logical notification. Watchrail keeps all three values stable
across retries.

## V2 signature verification

`x-watchrail-signature` now contains a V2 HMAC-SHA256 signature in the form `v2=<hex digest>`. The
signature authenticates the identity headers and the exact request body.

Build the signed bytes without normalizing or reparsing the body:

```text
watchrail:webhook-delivery:v2<LF>
<x-watchrail-timestamp><LF>
<lowercase x-watchrail-event-id><LF>
<lowercase x-watchrail-delivery-id><LF>
<x-watchrail-delivery-sequence><LF>
<exact request body bytes>
```

Compute `HMAC-SHA256(signing_secret, signed_bytes)`, encode the digest as lowercase hexadecimal, and
compare `v2=<digest>` to `x-watchrail-signature` with a constant-time comparison. Reject requests
whose timestamp is outside the receiver's replay window. Verify the signature before using any
identity header for deduplication.

Changing the event ID, delivery ID, sequence, timestamp, or body invalidates the signature.

## Compatibility

The older V1 signature authenticated only the timestamp and body. It can verify historical requests,
but it does not authenticate reminder identity and must not be used to distinguish reminders from
retries. Receivers must support V2 before reminder-producing workers are enabled. During a coordinated
deployment, stop old workers and external V1-only consumers before enabling reminder production.
