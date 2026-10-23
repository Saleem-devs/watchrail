# Frontend Design and Architecture

## Product intent

Watchrail is an open-source monitoring control plane. The interface should make it easy to
answer three questions immediately: **What is being monitored? What needs attention? What
evidence explains the last check?** Monitoring configuration and diagnostics remain available
without requiring an artificial marketing-style landing page.

## Information architecture

The authenticated operator workspace has a shared `AppShell`:
- **Overview** (`/`): status summary computed from the current organization's monitors.
- **Monitors** (`/#monitor-inventory`): monitor inventory, current health, diagnostics and history.
- **New monitor** (`/#create-monitor`): monitor creation, preserving the existing API contract.
- **Organization** (`/settings/organization`): workspace membership, invitations, API
  credentials and ownership controls.

The overview and monitor deep links intentionally share a route until the existing monitor
component can be split into dedicated feature screens. Do not add navigation to routes that
do not exist yet.

Public status pages (`/status/[slug]`) and authentication routes use their separate
layouts and must not inherit the authenticated workspace shell.

## Visual system

- Dark neutral surfaces with a clear hierarchy; use mint-green sparingly as the primary
  interactive accent and for operational health. Amber means caution, red means unavailable.
- Sidebar and compact workspace header on desktop; on smaller screens use a horizontal,
  scrollable section navigation without hiding core actions.
- Summary metrics are derived from **actual API responses**. Missing checks are pending,
  not healthy. Degraded or down aggregate checks require attention even if one location passed.
- Typography uses system fonts. No external fonts or icons are needed to render the shell.
- Controls must have visible keyboard focus, semantic labels, responsive touch targets and
  reduced-motion behavior.

## Implementation ownership

| Concern | Ownership |
| --- | --- |
| Shared workspace navigation and brand | `components/app-shell.tsx` and its CSS module |
| Summary derivation | Pure `lib/monitor-summary.ts` with unit tests |
| Overview visualization | `components/monitor-overview.tsx` and its CSS module |
| Monitor workflows (temporarily) | `app/dashboard.tsx`, preserving current API calls |
| Organization settings | Existing settings page, wrapped by its route layout |
| Authentication/session | `lib/auth-client.ts`, `components/org-switcher.tsx` |
| Public status pages | Their existing route, components and scoped CSS module |

## Migration plan

1. **Foundation (this PR):** workspace shell, navigation, overview, scoped styles,
   accessibility and unit coverage. Keep existing behavioral flows stable.
2. **Feature extraction:** split monitor settings, diagnostics, history and incidents into
   feature-owned components; introduce a typed transport client preserving the existing
   `{ data }`, pagination and error shapes.
3. **Operational screens:** dedicated monitors, incident detail, probe locations and public
   status-page administration using actual supported backend APIs.
4. **Polish:** loading/empty/error states, responsive interaction, keyboard and screen-reader
   testing, and page-level visual regression coverage.

Do not conflate a UI foundation with completion of all frontend functionality. Preserve
server-derived tenant isolation, existing authentication redirects, monitor status semantics,
manual check polling, feature-gated multi-location controls and accessible error handling.

## Verification gate

Run formatting, lint, typecheck, web unit tests and production build. Then run the repository
unit suite and exact root integration gate to ensure changes do not affect existing behavior.
Keep the PR draft until verification and visual review at desktop and mobile viewport widths.
