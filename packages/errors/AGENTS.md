# @cinatra-ai/errors

Subtree-specific guidance for the errors package. Wraps `@sentry/nextjs` for Next.js fixed-location config + instrumentation files.

## Two entry points

| Entry | File | `server-only`? | Imports |
|---|---|---|---|
| `@cinatra-ai/errors` | `src/index.ts` | no — **runtime-safe (browser/edge/node)** | Pure helpers: `shouldInitSentry`, `buildSentryClientOptions`, `beforeSendFilter`, `beforeBreadcrumbFilter` + types. Zero `@/` deps. |
| `@cinatra-ai/errors/server` | `src/server.ts` | yes (`import "server-only"`) | `getSentry`, `getSentrySync`, `captureBackgroundJobError`, `captureClientError`, `withSentryServerAction`. Dynamic-imports `@sentry/nextjs`. |

## Fixed-location Next.js files — CANNOT MOVE

Next.js resolves these by exact path; they stay as one-line re-export shims importing from this package (do not collapse them away):

- `sentry.client.config.ts` → imports from `@cinatra-ai/errors` (the runtime-safe main; **never `/server`**)
- `sentry.server.config.ts` → imports from `@cinatra-ai/errors`
- `sentry.edge.config.ts` → imports from `@cinatra-ai/errors` (**never `/server`** — edge runtime would break)
- `src/lib/sentry.ts` → `export * from "@cinatra-ai/errors/server"` shim
- `src/lib/sentry-shared.ts` → `export * from "@cinatra-ai/errors"` shim
- `instrumentation-client.ts` → unchanged (`import "./sentry.client.config"`)
- `src/instrumentation.node.ts` → unchanged (`import "../sentry.server.config"`)
- `src/instrumentation.ts` → unchanged (Sentry `onRequestError` hook via dynamic `import("@sentry/nextjs")`; no `@/lib/sentry` import here)
- `next.config.ts` → unchanged (`import { withSentryConfig } from "@sentry/nextjs"`; build-time wrapper)

## Boot-graph rules

`background-jobs.ts` MUST keep its `@cinatra-ai/errors/server` import DYNAMIC (`worker.on("failed")` hook does `void import("@cinatra-ai/errors/server").then(({ captureBackgroundJobError }) => …)`). No top-level static import.

Subpath import (`/server`) requires the `package.json` `exports` map entry — root tsconfig/vitest aliases mask the gap, but Next/pnpm native resolution fails `MODULE_NOT_FOUND` at runtime without it.

## @sentry/nextjs version

Match the existing root-`package.json` range exactly (currently `^10.53.1`). Do NOT introduce a different version — it's a transitive dependency; let upgrades flow from root.

## Test files stay under `src/`

Root vitest only globs `src/**`. Sentry tests stay at `src/lib/__tests__/sentry.test.ts` and `src/lib/__tests__/background-jobs-sentry.test.ts` — they import via `@cinatra-ai/errors/server`. Don't move them into the package.

## PII scrubbing

`beforeSendFilter` + `beforeBreadcrumbFilter` are the package-level scrubbing rules. If you tighten or relax scrubbing rules, do it here (single source of truth) — the three Next fixed-location configs all consume them via this package.
