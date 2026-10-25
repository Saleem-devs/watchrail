# Frontend Design and Architecture

## Decisions

Watchrail uses Next.js 16, React 19, TypeScript and Tailwind CSS v4.3.3. New UI uses
Tailwind utilities and CSS-first `@theme` tokens in `apps/web/app/tailwind.css`. Do not
introduce CSS Modules or new vanilla CSS feature stylesheets. The existing `styles.css`
is temporarily retained to avoid breaking sign-in, dashboard, organization settings and
public status pages. Tailwind Preflight is deliberately omitted until those screens have
been migrated and visually regression-tested.

## Information architecture

The authenticated workspace uses `components/app-shell.tsx` for responsive navigation.
Overview (`/`) displays genuine active-organization monitoring data, including explicit
unknown states. Monitors (`/#monitor-inventory`) and New monitor (`/#create-monitor`)
point to implemented sections of the existing dashboard, not speculative routes.
Organization (`/settings/organization`) retains its current settings route. Sign-in
and public status pages remain outside the authenticated shell.

## Architecture and safety

`lib/monitor-summary.ts` remains a pure tested summary function.
`components/monitor-overview.tsx` renders those derived values.
`app/dashboard.tsx` still owns monitor network operations until feature extraction.
The frontend never authorizes memberships or tenant access; enforce permissions, tenant
boundaries, data projection and credential scope at the NestJS API.
Keep original API paths, versioned response shapes, error codes, manual check polling,
feature-gated multiple locations, and the Better Auth session flow.

Next: extract feature-based monitor components and a typed HTTP boundary, migrate every
screen to Tailwind, enable a deliberate global reset, remove legacy CSS, and add robust
responsive and accessibility coverage. Maintain the existing visual palette provisionally,
subject to UI/UX design review.

## Visual system

Watchrail uses a restrained operational-console direction. Dense monitoring surfaces prioritize
incidents, evidence and actions over decorative presentation. The recurring signal-rail pattern may
connect genuine execution stages, regions or incident transitions, but must not become decorative
circuitry or imply monitoring evidence that does not exist.

The interface follows the operating system color preference. Light mode uses a true white canvas.
Dark mode uses a neutral charcoal workspace with a slightly lighter sidebar and raised surfaces.
Neutral surfaces create hierarchy without tinting the entire workspace, while monitoring state
colors retain consistent meaning and sufficient contrast in both modes. Browser chrome receives
matching light and dark theme colors through Next.js viewport metadata.

`apps/web/app/tailwind.css` is the visual source of truth. Its semantic tokens cover canvas and
surface elevation, borders, text hierarchy, the mint interaction accent and explicit monitoring
states. Legacy custom properties in `styles.css` are compatibility aliases to those tokens while
existing screens migrate. Product accent and monitoring health are separate concepts even when
their colors are related.

The shared `components/ui` primitives establish interaction and status semantics. Monitoring status
must use visible text and an icon in addition to color, and callers must pass an authoritative
`UP`, `DOWN`, `DEGRADED`, `UNKNOWN` or `PAUSED` state. Technical values may use the mono font token;
ordinary interface labels and prose use the sans token.

Use sentence case, a four-pixel spacing rhythm, restrained radii and visible keyboard focus. Avoid
eyebrow labels, decorative section numbering, Unicode glyphs as icons, nested cards and motion that
does not explain a state change. Honor `prefers-reduced-motion` and keep primary interaction targets
at least 44 CSS pixels high.

## Verification

Run `pnpm install --frozen-lockfile`, `pnpm format:check`, `pnpm lint`,
`pnpm typecheck`, `pnpm test`, `pnpm --filter @watchrail/web build` and the
integration suite. Confirm mobile/desktop rendering, auth, organization switches and
public status pages before marking this PR ready.
