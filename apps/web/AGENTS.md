<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Watchrail Frontend Design Standards

### Technology

- Use Next.js 16 App Router, React 19, TypeScript, and Tailwind CSS v4.
- Reuse the existing Tailwind design tokens and CSS-first configuration.
- Never introduce new vanilla CSS feature stylesheets or CSS Modules.
- Reuse established components and accessibility patterns before introducing new dependencies.

### Design direction

- Build a polished, distinctive developer-tools interface.
- Prefer a restrained dark theme, strong typography, thoughtful spacing, clear hierarchy, and
  subtle interactive details.
- Watchrail should feel like a professional observability platform, not a generic AI-generated SaaS
  template.
- Avoid excessive gradients, decorative charts, glassmorphism, unnecessary animations, and visual
  clutter.
- Preserve and progressively refine the established Watchrail visual identity.

### Product semantics

- Monitoring status must always be truthful.
- Distinguish `UP`, `DOWN`, `DEGRADED`, `UNKNOWN`, and `PAUSED` correctly.
- A paused monitor must never look operational because of an old successful check.
- Prioritize incidents, availability, regional evidence, response times, monitor management, and
  actionable diagnostics.
- Never invent monitoring metrics or simulate production data as real.

### Design workflow

1. Review the relevant existing UI before proposing changes.
2. Use UI UX Pro Max and Frontend Design to establish one consistent design direction.
3. Briefly explain significant visual and interaction decisions.
4. Implement using the existing Watchrail architecture and Tailwind.
5. Audit the completed interface using Impeccable.
6. Test responsive layouts, keyboard interactions, accessibility, and key user workflows.
7. Verify that monitoring logic, API contracts, authentication, and tenant isolation remain
   unchanged.

### Engineering constraints

- Maintain existing frontend functionality and test coverage.
- Do not change backend APIs or security boundaries for cosmetic improvements.
- Keep changes incremental and PR-scoped.
- Never merge directly into `dev` or `main`.
- Preserve existing repository standards and formatting.
