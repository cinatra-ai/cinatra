import "server-only";

// Wires the host-injected hot-activate hook (the in-process activator the
// dispatcher fires after a verdaccio-source NEW install / UPDATE commits, so the
// running process picks the package up WITHOUT a restart).
//
// Kept SEPARATE from `@/lib/extensions` (which eagerly registers all five kind
// handlers and pulls the heavy host handler graph) so it can be loaded cheaply
// on every path that can install/update an extension — including the UI Server
// Actions in `@cinatra-ai/extensions`, which must NOT pull the full handler
// graph but DO drive `extensionRegistry.install` / `.update`.
//
// Without this wiring, a Server Action worker that never transitively imports
// `@/lib/extensions` (the MCP boot path) would leave the activate hook UNWIRED:
// `fireExtensionActivate` returns `{ activated:false, reason:"no-host-hook" }`
// with `finalized:undefined`, which the dispatcher treats as a fail-closed
// hot-activation failure. So the connector install/update UI path MUST wire
// this hook to actually hot-activate.
//
// This module only touches `@cinatra-ai/extensions` (the hook setter) and a
// LAZY dynamic import of the activator body (`@/lib/extension-runtime-activate`),
// so importing it is cheap — the heavy install-pipeline graph is only pulled on
// the FIRST install/update, inside the hook closure.
//
// Loaded at web-process boot via `src/instrumentation.node.ts`, re-imported as a
// side effect from `@/lib/extensions` (the MCP path), AND side-effect-imported by
// `@cinatra-ai/extensions/handler-bootstrap` (the Server Action path) — all
// idempotent (last set wins).

import {
  setExtensionActivateHook,
  setExtensionInstallOpPhaseReader,
} from "@cinatra-ai/extensions";

/**
 * Install the in-process hot-activate hook. Idempotent by NATURE — it always
 * (re)sets the same closure, so calling it twice is harmless. No `wired`
 * short-circuit guard: the setter is cheap, and a guard would wrongly skip
 * re-installing the hook if something cleared it (e.g. a test calling
 * `setExtensionActivateHook(null)`).
 */
export function wireExtensionActivateHook(): void {
  setExtensionActivateHook(async (packageName, orgId, version) => {
    const { runHostExtensionInstallAndActivate } = await import("@/lib/extension-runtime-activate");
    // Forward the REQUESTED install/target version (the dispatcher passes
    // `ref.version`) so an UPDATE installs the NEW version, not the stale version
    // still recorded on the canonical row. `runHostExtensionInstallAndActivate`
    // falls back to the row's version when this is undefined; forward it ONLY when
    // defined so a legacy 2-arg invocation stays a 2-arg downstream call.
    return version === undefined
      ? runHostExtensionInstallAndActivate(packageName, orgId ?? null)
      : runHostExtensionInstallAndActivate(packageName, orgId ?? null, version);
  });

  // Wire the install-op JOURNAL-phase reader so the dispatcher's rollback + re-run
  // decisions are journal-aware (catch the provenance-before-finalize window where
  // a row has REAL integrity but the journal is not yet finalized). Reads the
  // host's `extension_install_ops` store — which `@cinatra-ai/extensions` cannot
  // import directly. Returns the phase string, or null (no journal row / read
  // failure → the dispatcher falls back to the integrity check).
  //
  // cinatra#158: use the NON-FINALIZED-WINDOW reader (`readLatestInstallOpPhase`),
  // NOT the anchor reader. With the append-only journal, a healthy install keeps
  // its `finalized` op while a newer FAILED attempt is terminalized
  // (`superseded`/`failed`/`rolled_back`); the window reader returns `finalized`
  // whenever a finalized op exists (so the retained anchor never looks broken) and
  // otherwise the latest attempt's phase (so a mid-flight or only-ever-terminal
  // half-install is still flagged non-finalized → rollbackable).
  setExtensionInstallOpPhaseReader(async (packageName, orgId) => {
    const { readLatestInstallOpPhase } = await import("@/lib/extension-install-ops");
    return (await readLatestInstallOpPhase(packageName, orgId)) ?? null;
  });
}

// Wire on import — a side-effect import is enough to install the hooks.
wireExtensionActivateHook();
