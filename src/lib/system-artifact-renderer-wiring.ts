import "server-only";

// Boot wiring for the SYSTEM artifact-renderer registrar (epic #1620 M1 Slice B —
// cinatra#1630, plan §5.1). Mirror of the S11a lifecycle-hook wiring modules
// (`extension-dashboard-lifecycle-wiring`): a lightweight side-effect import that
// the core-boot phase runs so the system-base representation-provider registrar
// is READY on every worker.
//
// WHAT IS WIRED (and what is NOT):
//   - The representation providers for the four build-bundled bases are bound
//     PER-ORG, generation-safe + self-healing, by
//     `reconcileSystemRepresentationProviders(orgId)` — called at resolve time on
//     the detail route (`renderer-resolution.ts`). Org identities are dynamic, so
//     the bind is org-scoped and lazy; the never-blank floor covers the transient
//     gap before the first reconcile for an org (plan §5.3.4). This is the
//     canonical mechanism; it needs no boot step.
//   - The capability-teardown guard that makes the system bases REJECT uninstall
//     is a static import in `extension-artifact-renderers-teardown.ts` — active
//     wherever teardown runs, no boot step needed.
//
// So this boot module is a READINESS wiring: it asserts (and logs) that the build
// map genuinely carries the system bases the registrar will bind, so a
// misgenerated/empty map surfaces at boot rather than silently leaving the four
// MIME families on the removed legacy floor. It never touches per-org state.

import {
  systemArtifactRendererPackages,
  systemRepresentationProviderSpecs,
} from "@/lib/artifacts/system-artifact-renderer-registrar";

let wired = false;

/** Idempotently confirm the system artifact-renderer registrar is ready — the
 * generated build map carries the system bases the per-org reconcile binds. */
export function wireSystemArtifactRenderers(): void {
  if (wired) return;
  wired = true;
  const packages = systemArtifactRendererPackages();
  const specCount = systemRepresentationProviderSpecs().length;
  if (packages.size === 0 || specCount === 0) {
    console.warn(
      "[system-artifact-renderers] the generated renderer build map carries NO system base " +
        "representation providers — the four MIME families will fall to the generic floor. " +
        "Regenerate `src/lib/generated/artifact-renderers.ts`.",
    );
    return;
  }
  console.info(
    `[system-artifact-renderers] registrar ready — ${packages.size} system base(s), ` +
      `${specCount} representation binding(s) reconcile per-org on first resolve.`,
  );
}

// Wire on import — a side-effect import installs the readiness check.
wireSystemArtifactRenderers();
