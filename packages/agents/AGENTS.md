# @cinatra-ai/agents

Subtree-specific guidance for the agents package.

## WayFlow hot-reload

Three exports gate WayFlow runtime sync after publish/install:

- `triggerWayflowReload()` — POSTs to `{WAYFLOW_BASE_URL}/.internal/reload-agents` with `X-Cinatra-Bridge-Token`. Never throws. Returns `ReloadResult`. 10s `AbortController` timeout. Trailing slashes stripped from base URL. Response shape validated.
- `materializeAgentPackageToDisk(input)` — atomically writes the extracted tarball's runtime files (`cinatra/oas.json`, `skills/`, `package.json`, `README.md`) to `<agentInstallDir>/<vendor>/<slug>/`. Path-traversal hardened: strict `@vendor/slug` regex + `resolve().startsWith(agentsRoot)` containment. Symlinks in the extracted tree are rejected via an `lstat` walk before `fs.cp`. Returns `{ materialized: true, targetDir, priorDirBackup, wasReinstall }` or `{ materialized: false, reason }`.
- `withInstallLock(packageName, fn)` — per-package re-entrant async lock. Tracked via `node:async_hooks` AsyncLocalStorage. Callers in different files (e.g. `extension-handler.ts`) can hold an outer lock spanning install + skill-registration + compensation; nested `withInstallLock` calls from `install-from-package.ts` detect the held key and run inline without re-acquiring.

`triggerWayflowReload` is fanned out across four ordered sites — install/publish at the top, then uninstall, then preflight auto-recovery at the bottom of the request lifecycle. **`installAgentFromPackage` itself does NOT reload** (avoids N reloads for an N-dep tree).

- `installAgentPackageWithDependencies` — once at the end of the full dep tree install.
- `agent_source_publish` MCP handler — once after publish + DB sync + origin freeze. Gated on install success.
- `extension-handler.ts::uninstall` — once after DB delete + disk-dir removal. Reaches both `extensions_uninstall` and `extensions_force_delete`.
- `preflightWayflowAgent` — auto-recovery: on 404 it triggers a reload + re-probes once before surfacing the error.

Reload failure is non-fatal at every site: durable side-effects (Verdaccio, DB, on-disk tarball, DB delete) stay committed. Failure surfaces as `installedPendingReload: true` + `wayflowReload: { ok: false, reason }` on the publish/install handler responses, or as a `WAYFLOW_AGENT_NOT_REGISTERED` result with diagnostic reason from preflight.

Preflight success after recovery returns `{ code: "OK", recoveredViaReload: true }`. Preflight failure after recovery names the three likely root causes (WayFlow image without hot-reload support, tarball missing `cinatra/oas.json`, parse failure).

Full design: [wayflow-runtime-reload](https://docs.cinatra.ai/references/platform/wayflow-runtime-reload/).

---

## WayFlow timeout policy

All blocking `sendTask` calls to WayFlow share a 24h ceiling end-to-end. The constants and helpers live in `packages/agents/src/wayflow-url.ts`:

- `WAYFLOW_A2A_TIMEOUT_MS = 86_400_000` — AbortSignal ceiling. Pass as `createExternalA2AClient({ timeoutMs: WAYFLOW_A2A_TIMEOUT_MS })`.
- `WAYFLOW_UNDICI_TIMEOUT_MS = 86_400_000` — undici `headersTimeout` + `bodyTimeout` for the long-lived dispatcher.
- `AGENT_RUN_TIMEOUT_MAX_SECONDS = 86_400` — max value accepted by `agent_run.timeoutSeconds` (Zod schema + runtime validation in `mcp/handlers.ts`).
- `createWayflowFetch()` — builds a `fetch` whose underlying undici Agent has long `headersTimeout`/`bodyTimeout`. **Required** at every `createExternalA2AClient` call targeting a local WayFlow endpoint — `globalThis.fetch` uses undici's 300s default which silently kills 24h AbortSignal calls.

Canonical call pattern:

```ts
import {
  WAYFLOW_A2A_TIMEOUT_MS,
  createWayflowFetch,
  resolveWayflowUrl,
} from "@cinatra-ai/agents/wayflow-url";

const client = await createExternalA2AClient({
  agentUrl: resolveWayflowUrl(packageName),
  timeoutMs: WAYFLOW_A2A_TIMEOUT_MS,
  fetchImpl: createWayflowFetch(),
});
```

The Python side (`docker/wayflow/agent_loader.py`) mirrors the 24h ceiling on `ApiCallStep._execute_request`, `_BLOCKING_REQUESTS_MAX_TIME_SECONDS`, and the pyagentspec `A2ASessionParameters` / `A2AConnectionConfig` timeout defaults (mutated via `model_fields[].default = X` + `model_rebuild(force=True)`).

**Operator escape hatch:** Cinatra does NOT configure an explicit BullMQ job timeout. The 24h ceiling IS the practical upper bound for a single in-flight call. Tighter caps go via `agent_run.timeoutSeconds` (1..86400) or explicit `timeout` on individual ApiNodes in OAS.

---

## Removed features (do not reintroduce)

These orphaned, fully-unreferenced source clusters are intentionally absent from `src/`. Do not recreate these — if a future need arises, design fresh against current patterns rather than resurrecting the deleted files:

- **Pipeline Composition UI** — `pipeline-composition-panel.tsx`, `pipeline-edge.tsx`, `pipeline-node.tsx`, `pipeline-composition-derive.ts`, `object-category-icon.tsx` (+ their `__tests__`). A read-only orchestrator-template pipeline-flow visualization that was never wired into any screen or entry point. There is no `agentDetail`/`screens.tsx` consumer; it was dead from introduction.
- **Stale agent-detail UI bits** — `review-workspace.tsx`, `run-again-button.tsx`, `run-history-list.tsx`, `export-button.tsx`, plus the unreferenced helpers `agentic-messages.ts`, `audit-projections.ts`, `presentation-parser.ts`, `ref-resolver.ts`, `contact-scope-renderer.tsx`, `source-package-layout.ts` (+ relevant `__tests__`). Superseded by the current agent run/detail screens; `source-package-layout.ts`'s canonical-path responsibility lives in `resolveAgentInstallDir()` + inline `"cinatra-ai"` joins.

`verdaccio/vendor-types.d.ts` was deliberately KEPT — it is a load-bearing ambient `declare module "pacote"` (and `libnpmpublish`) that `pnpm typecheck` requires because `verdaccio/client.ts` imports `pacote`, which ships no types. Do not delete it as "unreferenced"; ambient `.d.ts` modules are consumed by the type system, not by `import`.

---

## Integration tests

Files that require a real isolated Postgres schema MUST end in `.integration.test.ts`.

- The default `pnpm test` (alias for `vitest run`) excludes them via `test.exclude` in `vitest.config.ts`.
- Run them locally with:
  ```bash
  CINATRA_TEST_DB_URL=<url> pnpm test:integration
  ```
  after `cinatra setup branch` has provisioned an isolated `cinatra_<slug>` schema. The script forwards `CINATRA_TEST_DB_URL` into `SUPABASE_DB_URL` for the vitest run and exits with a clear error if the variable is unset.
- CI runs `pnpm test:integration` after `cinatra setup branch` in `.github/workflows/`.
- When in doubt — if the test inserts into `cinatra.*` tables with FK constraints — name it `.integration.test.ts`.

## Vitest pool: forks and cross-file mock leaks

`packages/agents/vitest.config.ts` sets `pool: "forks"`. This is required, not optional.

### Why forks (not threads)

Several tests in this package `vi.mock(...)` modules that other test files import without mocking — most often shared infrastructure like `../mcp/schemas`, `@/lib/auth`, or `@cinatra-ai/skills` subpaths. Under the default `pool: "threads"`, vitest worker threads share a Node module cache. A `vi.mock` factory installed by file A leaks into file B's import graph when both run in the same worker, producing failures that look like "the mocked module returned undefined" or "mockResolvedValueOnce isn't taking effect" — but only when the suite is run together. The hallmark symptom is **"passes in isolation, fails in the suite"**.

`pool: "forks"` runs each test file in a dedicated child process, so the module cache is rebuilt from scratch per file. Slower, but the only correct choice here.

### Diagnosing a suspected leak

If a test passes via `pnpm exec vitest run path/to/single.test.ts` but fails as part of `pnpm test`:

1. Re-run the full suite with `--pool=threads` to confirm the failure is leak-shaped (it usually disappears under forks).
2. Identify which earlier file mocks the same module — the `__mocks__/` index plus a quick `grep -r "vi.mock(\"<module>\"" src/__tests__` is the fastest path.
3. Either narrow the offending `vi.mock` to that file's `beforeEach` + `vi.unmock` in `afterAll`, or move the shared stub into `src/__tests__/__mocks__/` and wire it via a `resolve.alias` entry in `vitest.config.ts`.

Never `vi.mock` a module that other files import without mocking unless you scope the mock to the test's own `beforeEach`/`afterAll` lifecycle.

### The `__mocks__/` stub pattern

Test-only stubs live in `src/__tests__/__mocks__/` and are wired via `resolve.alias` in `vitest.config.ts`. Existing examples:

- `__mocks__/modelcontextprotocol-server.ts` — vendored, workspace-private; tsconfig path-mapped, so vitest needs an explicit alias.
- `__mocks__/auth.ts`, `__mocks__/mcp-server.ts`, `__mocks__/primitive-handlers.ts`, `__mocks__/mcp-instructions.ts` — break heavy host-app import chains that pull in `better-auth`, the full connector tree, or React UI from server code.
- `__mocks__/toast.ts` — `sonner` resolves as a CJS shim under vitest where the named `toast` export is `undefined`; the real `@/lib/toast` does `_toast.promise.bind(_toast)` at load time and crashes. The stub returns inert no-op functions.
- `__mocks__/server-only.ts` — replaces the `server-only` import-time guard.
- `__mocks__/verdaccio-config.ts` — re-exports the lower-layer registries function so test mocks of `@cinatra-ai/registries` cascade naturally.

### Adding a new mock when a third-party package import-time-explodes

When a new package added under `dependencies` or `peerDependencies` crashes vitest at module-load with `Cannot read properties of undefined (...)` or `... is not a function`, the symptom is a CJS/ESM interop mismatch — usually a CJS shim where a named export resolves `undefined` (sonner, lucide-react), or a vendored package mapped only via `tsconfig.json` paths (`@modelcontextprotocol/server`). Steps:

1. Add `src/__tests__/__mocks__/<package-name>.ts` exporting the minimal shape that the production code uses at module load (typically inert no-op functions, default Proxy for icon libraries, plain objects for runtime singletons).
2. Wire the alias in `packages/agents/vitest.config.ts` under `resolve.alias`. Place subpath aliases (`@cinatra/foo/bar`) BEFORE the bare alias (`@cinatra/foo`) so vite's prefix matcher prefers the more specific match.
3. Add a comment explaining the failure mode.
4. Confirm: stubs are test-only — they MUST NOT leak into the production runtime. Never import from `src/__tests__/__mocks__/` in `src/**` non-test code.

### Host-app config consistency

The repo-root `vitest.config.ts` (host app) currently runs on the default threads pool. If new cross-file mock-leak failures surface in the host-app suite, mirror the package config (`pool: "forks"`).

## Project Scoping integration

`agent_runs.project_id text NULL` has partial indexes `(project_id, created_at DESC)` and `(project_id, status, created_at DESC)`. `ActorRoleHints.projectGrants` is part of the role-hint shape, and `ActorContext.projectGrants` is part of the resolved kernel context.

- **Run-start propagation** — `createAgentRun` accepts `projectId?: string|null` and writes `agent_runs.project_id` at INSERT. The BullMQ run worker (`runAgentBuilderExecutionJob`) reads `run.projectId` and wraps the inner execution body in `mcpRequestContextStorage.run({...prev, projectContext: {projectId}}, ...)` — frame is ALWAYS set (even when NULL) to defend against stale BullMQ-pool frames.
- **A2A carrier round-trip** — `packages/agents/src/mcp/registry.ts` forwards `a2a.projectGrants` into the actor envelope; `buildActorContextFromPrimitive` reads carrier-forwarded grants gated on `actor.actorType === "a2a"` (security: never reads arbitrary primitive input).
- **Move** — `agent_run_update` accepts `project_id` change with active-run protection: movable set `queued/completed/failed/stopped`; reject `running/pending_approval/pending_input/armed/pending_trigger/waiting_trigger`. New `agent_run_move_with_outputs` primitive moves run + objects linked via `objects.created_by_run_id` in one audited tx; cross-tenant rejected.
- **Background-job actor snapshot** — `ActorContext` (including `projectGrants`) is serialized onto BullMQ jobs at enqueue and rehydrated at execution. Mid-flight access revocations are NOT seen by in-flight jobs (point-in-time snapshot accepted behavior).
