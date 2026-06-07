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

let wired = false;

/** Idempotently install the durable data-teardown hook. */
export function wireExtensionDataTeardownHook(): void {
  if (wired) return;
  wired = true;
  setExtensionDataTeardownHook((packageName: string) => {
    // Physically delete the package's org-scoped settings + secrets + dev-fixture
    // provenance across all orgs. These prefixes map 1:1 to the keys the host
    // writes: `ext:<pkg>:<orgId>:<key>` (settings) /
    // `ext-secret:<pkg>:<orgId>:<key>` (secrets) /
    // `ext-fixture-prov:<pkg>:<orgId>:<key>` (dev-fixture provenance sidecars).
    // The prefix delete escapes LIKE wildcards, so a literal package name can
    // never widen the match. (Reaping fixture-owned `ctx.objects` rows lands
    // with the object-fixture seeder — see dev-fixture-seeder.ts.)
    deleteConnectorConfigByPrefix(`ext:${packageName}:`);
    deleteConnectorConfigByPrefix(`ext-secret:${packageName}:`);
    deleteConnectorConfigByPrefix(`ext-fixture-prov:${packageName}:`);
  });
}

// Wire on import — a side-effect import (`import "@/lib/extension-data-teardown-wiring"`)
// is enough to install the hook.
wireExtensionDataTeardownHook();
