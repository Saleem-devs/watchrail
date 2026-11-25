# Watchrail

An open-source, self-hostable uptime-monitoring and incident-communication platform for developers and software teams. It periodically checks HTTP services, records their availability and response time, detects outages and recoveries, notifies operators, and publishes service health through status pages.

In development

## Status-page email subscriptions

Published pages offer verified, page-wide email subscriptions. Apply database migration
`0065` before restarting the updated API and worker. Subscriber emails use the existing
SMTP configuration and `AUTH_EMAIL_*` encryption keyring; retain retired keys while stored
subscriber records or deliveries still reference them. Set `FRONTEND_URL` to the public
frontend origin (required by the worker in production).

Subscribers receive future public incident openings, updates and resolutions, plus maintenance
schedule announcements, edits, cancellations and publication withdrawals. This release does
not send reminders at each maintenance occurrence's start or end. Events snapshot public
content in the source transaction; operator notification silence does not silence public
communications. Monitor health and measured uptime are unchanged.

Confirmation links expire after 24 hours. Verification and unsubscribe require an explicit
action; following an email link alone does not mutate state. Addresses and email-link tokens
are encrypted at rest, with hashed lookup tokens. Pending deliveries are checked again before
dispatch, and old subscription generations cannot resume sending after resubscription.
Delivery is at-least-once: SMTP ambiguity can still cause duplicates, and already-accepted
messages cannot be recalled. Unpublishing suppresses queued messages without replaying them
when the page is republished.

Public subscription requests use shared database limits: 30 requests per IP/hour, five per
address/hour, 100 per page/hour, and a 60-second resend cooldown. No existing-subscriber lookup
is exposed. Configure reverse-proxy IP handling deliberately; forwarded IP headers are not
trusted by this feature. Subscriber records and delivery evidence currently remain until
the status page is deleted; automated retention and subscriber administration are follow-up work.
