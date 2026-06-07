# drizzle-cube adapter

**This directory is the ONLY place in the entire Cinatra repository allowed to import `drizzle-cube/*`.**

Enforced by ESLint `no-restricted-imports` with regression tests in `../../__tests__/eslint-boundary.test.ts`. See ADR 0044 for the rationale.

If you find yourself wanting to import `drizzle-cube/server` (or anything else from drizzle-cube) outside this directory:

- **You probably want a Cinatra DTO instead.** All sdk-dashboard public types (`CubeDescriptor`, `QuerySpec`, `QueryResult`, `SecurityContext`) live in `../../types/`. Use those.
- **If the DTO is missing what you need**, extend the DTO — don't bypass the boundary.
- **If you absolutely need drizzle-cube-specific behavior**, expose it through a new adapter function here, not by importing drizzle-cube directly elsewhere.

The whole point of this boundary is that if drizzle-cube stalls, is replaced, or breaks at a major version bump, the cost is "rewrite this directory" — not "rewrite the analytics product."
