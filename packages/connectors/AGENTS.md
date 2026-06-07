# packages/connectors — subtree guidance

Scope: the `/connectors` surface — the connector index grid + per-connector
detail pages. Read this before adding or moving a connector card.

## Connector page pattern: dedicated sub-page, NOT a `?modal=` overlay

Each connector is a dedicated route at `src/app/connectors/<slug>/page.tsx`,
rendered full-page inside the standard `Main` / `PageHeader` / `PageContent`
shell (shadcn-admin requirement — see root CLAUDE.md). The proven reference is
`src/app/connectors/apollo/page.tsx`; `openai`, `gemini`, `anthropic` follow it
and live under `/connectors/<slug>`.

- The grid lives in `packages/connectors/src/connectors-client.tsx`
  (cards) + `pages.tsx` (wiring) + `index.ts` (surface).
- Reuse the already-shipped connect/save logic (e.g. `SaveGeminiForm`,
  `saveOpenAIConnectionAction`) inside the sub-page. Do NOT re-architect or
  fork the form components.
- Do NOT add a new card to the legacy `?modal=<slug>` overlay host in
  `src/app/configuration/llm/apis-page.tsx` (re-exported by `src/app/configuration/llm/page.tsx`).
  That page is kept ALIVE but unadvertised purely for deep-link / bookmark /
  onboarding continuity (`/configuration/llm?modal=openai|gemini|anthropic`
  still resolves). New work goes to `/connectors/<slug>`.
- `/configuration/llm` deliberately still hosts `DefaultProvidersCard`
  (model defaults) + non-connector LLM admin — it was NOT redirected away.

## TDZ landmine: leaf constants must not live in heavy barrels

`src/lib/logging.ts` reads `OPENAI/GEMINI/APOLLO/ANTHROPIC_API_LOG_DIRECTORY`
at **module-init** (top-level `const LOG_DIRECTORIES = [...]`). These constants
are owned by **dependency-free leaf modules**:

- `extensions/cinatra-ai/<x>-connector/src/log-directory.ts`
- `packages/llm/src/anthropic-log-directory.ts`
- `packages/llm/src/anthropic-logging-state.ts` (the mutable
  Anthropic-logging flag + `setAnthropicLoggingEnabled`)

The connector `index.ts` barrels `import { X } from "./log-directory"` and
re-export it for back-compat. **Never move these constants back inline into a
barrel** that also imports `@/lib/database` / `@/lib/nango` / `export *`. Doing
so reintroduces an ESM module-init cycle: a barrel entered as an SSR entrypoint
evaluates those imports, which transitively re-enter `logging.ts` before the
barrel's `export const` line runs → `ReferenceError: Cannot access
'<X>_API_LOG_DIRECTORY' before initialization`. The same rule applies to any
future connector that adds a constant `logging.ts` (or any other module-init
reader) consumes.

`pnpm typecheck` does NOT catch this — it is a runtime module-init order bug.
After any change that reshapes connector barrel imports/re-exports, the gate is
`rm -rf .next && pnpm dev` then SSR-render an authenticated page that imports
`@/lib/logging` (e.g. `/configuration/telemetry`) and confirm no TDZ in the
dev log. tsgo segfaults intermittently — use `pnpm typecheck:slow` (tsc) for
the trustworthy type gate.
