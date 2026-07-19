import "server-only";

// Wires the host-injected DURABLE data-teardown hook (the cross-process
// settings/secrets cleanup fired on HARD removal — uninstall hard-delete branch,
// forceDelete, connector purge). Kept SEPARATE from `@/lib/extensions` (which
// eagerly registers all five kind handlers and pulls the heavy host handler
// graph) so it can be loaded cheaply on every path that can hard-remove an
// extension — including the UI Server Actions in `@cinatra-ai/extensions`,
// which must NOT pull the full handler graph.
//
// This module only touches `@cinatra-ai/extensions` (the hook setter) and
// `@/lib/database` (the real prefix delete), so importing it is cheap. The
// cleanup IMPLEMENTATION must live host-side because `deleteConnectorConfigByPrefix`
// is a `@/lib` function the extensions package cannot import.
//
// Loaded at web-process boot via `src/instrumentation.node.ts` (so a UI Server
// Action's hard-removal always finds the hook wired) and re-imported as a side
// effect from `@/lib/extensions` (the MCP path) — both idempotent (last set wins).

import { setExtensionDataTeardownHook } from "@cinatra-ai/extensions";
import { deleteConnectorConfigByPrefix } from "@/lib/database";
// TYPE-ERASED, LIGHTWEIGHT slot accessor (globalThis-backed; no heavy
// execution-plane graph). Reaching the environment-teardown participant here
// keeps this module cheap on every hard-remove path (incl. UI Server Actions).
import { getEnvironmentTeardownParticipant } from "@/lib/execution/register-execution-environment-service";

let wired = false;

/** Idempotently install the durable data-teardown hook. */
export function wireExtensionDataTeardownHook(): void {
  if (wired) return;
  wired = true;
  // ASYNC with PER-HALF failure isolation (exec-plane S3 A3, cinatra#1708 §2.2 /
  // Codex finding 4): the DB deletes are AWAITED (were fire-and-forget) and each
  // half is ISOLATED so a throwing delete never short-circuits the env-layer
  // reference drop (both idempotent). Fires ONLY on HARD removal (the hook
  // contract guarantees this — never archive); best-effort (a throw is logged,
  // the committed removal never aborts).
  setExtensionDataTeardownHook(async (packageName: string) => {
    const isolate = (label: string, p: () => Promise<unknown> | unknown): Promise<void> =>
      Promise.resolve()
        .then(p)
        .then(() => undefined)
        .catch((e) =>
          console.warn(
            `[teardown] ${label} failed for ${packageName} (idempotent; retried next fire):`,
            e,
          ),
        );
    await Promise.all([
      // Physically delete the package's org-scoped settings + secrets + dev-
      // fixture provenance across all orgs. These prefixes map 1:1 to the keys
      // the host writes: `ext:<pkg>:<orgId>:<key>` (settings) /
      // `ext-secret:<pkg>:<orgId>:<key>` (secrets) /
      // `ext-fixture-prov:<pkg>:<orgId>:<key>` (dev-fixture provenance sidecars).
      // The prefix delete escapes LIKE wildcards, so a literal package name can
      // never widen the match.
      isolate("connector-config", () => deleteConnectorConfigByPrefix(`ext:${packageName}:`)),
      isolate("connector-secret", () =>
        deleteConnectorConfigByPrefix(`ext-secret:${packageName}:`),
      ),
      isolate("fixture-prov", () =>
        deleteConnectorConfigByPrefix(`ext-fixture-prov:${packageName}:`),
      ),
      // Drop the package's L1 environment-layer references (all orgs); the
      // layers are left to the retention GC. Reached lazily via the A2 DI slot;
      // a no-op when the execution-environment service is not `ready`.
      isolate("env-layer-refs", async () => {
        const participant = getEnvironmentTeardownParticipant();
        if (participant) await participant(packageName);
      }),
    ]);
  });
}

// Wire on import — a side-effect import (`import "@/lib/extension-data-teardown-wiring"`)
// is enough to install the hook.
wireExtensionDataTeardownHook();
