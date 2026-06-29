import "server-only";

// Hot-SWAP canonical-row reconcile (cinatra#670).
//
// Closes the half-swap gap for the extension kinds whose `update` re-materializes
// a NATIVE store (agent_templates / skills catalog) but never flips the canonical
// `installed_extension` source-of-truth row's version:
//
//   - connector → the real-integrity install PIPELINE owns the atomic swap
//     (hotUpdateWithDurableRollback + sourceSwitchExtension + generation bump).
//   - workflow  → the host-injected install SAGA rewrites the canonical row's
//     provenance itself.
//   - agent / skill (and any future non-pipeline, non-saga kind) → the native
//     handler.update upserts the native store + (agent) refreshes dep edges, but
//     the canonical `source.version` is NEVER flipped to the new version, and the
//     in-process activation generation is never bumped. That is a HALF-SWAPPED
//     surface: the native store is on the NEW version while the canonical source
//     of truth still reports the OLD version.
//
// `reconcileCanonicalVersionAfterNativeSwap` runs AFTER a successful native
// `handler.update`, under the SAME per-package install lock the dispatcher already
// holds, and flips ONLY the canonical row's `source.version` to the new version
// (then bumps the activation generation so generation-keyed caches invalidate).
//
// WHY ONLY `version`: agent/skill are NOT pipeline-driven, so their canonical row
// carries the dispatcher's placeholder `integrity:"dispatcher-install"` that never
// finalizes — there is no real SRI/contentHash to record (the pipeline path is the
// only one that materializes a verified store record with those values). So the
// reconcile preserves the EXISTING source block shape and replaces only the
// `version` field — the single fact the swap actually changed on a non-pipeline
// kind. `sourceSwitchExtension` re-validates source provenance and preserves the
// lifecycle status (a locked required-in-prod row stays locked across the swap).
//
// FAIL-LOUD, NEVER HALF-SWAP-SILENT: a reconcile failure does NOT roll back the
// native store (the new version is already materialized + integrity-verified and
// the prior row is still present), but it THROWS so the op surfaces a truthful
// "swap did not reconcile the source-of-truth row" failure instead of a silent
// half-swap success — mirroring the connector "finalized but not activated → throw"
// discipline in the dispatcher.

import type { ExtensionSource, InstalledExtension } from "./canonical-types";

/** Concrete-version guard. The MCP / action update surfaces always dispatch a
 *  registry-RESOLVED concrete version, but defend the canonical write here so a
 *  moving dist-tag (`latest`) or an add-from-chat placeholder can NEVER be flipped
 *  onto the source-of-truth row (it would fail `validateExtensionSource` anyway,
 *  but refuse early with a clear reason). */
const NON_CONCRETE_VERSIONS = new Set(["", "latest", "HEAD", "pending-resolution", "0.0.0"]);

export function isConcreteSwapVersion(version: string | undefined | null): version is string {
  return typeof version === "string" && version.length > 0 && !NON_CONCRETE_VERSIONS.has(version);
}

export type SwapReconcileOutcome =
  | { reconciled: true; from: string; to: string }
  | { reconciled: false; reason: string };

/**
 * Decide + apply the canonical version flip for a post-native-swap reconcile.
 *
 * PURE-DECISION core split out so the dispatcher seam stays a thin call and the
 * decision is unit-testable without a DB. Returns the NEW source block to write
 * (or a no-op reason). Only a `verdaccio`-sourced row whose recorded version
 * actually DIFFERS from the concrete new version is flipped:
 *   - a non-verdaccio source (github skill) → no-op (the handler resolved + owns
 *     its own source identity; there is no registry version to flip);
 *   - a non-concrete new version → no-op (refuse to taint the row with a moving
 *     tag / placeholder);
 *   - same version → no-op (idempotent re-swap to the same version).
 */
export function planCanonicalVersionFlip(
  currentSource: ExtensionSource,
  newVersion: string | undefined,
): { flip: true; newSource: ExtensionSource; from: string; to: string } | { flip: false; reason: string } {
  if (currentSource.type !== "verdaccio") {
    return { flip: false, reason: `non-verdaccio-source:${currentSource.type}` };
  }
  if (!isConcreteSwapVersion(newVersion)) {
    return { flip: false, reason: `non-concrete-version:${newVersion ?? "(undefined)"}` };
  }
  const from = currentSource.version;
  if (from === newVersion) {
    return { flip: false, reason: "same-version" };
  }
  // Flip ONLY the version; preserve every other source field (registryUrl,
  // packageName, integrity:"dispatcher-install", any optional attestation).
  return {
    flip: true,
    newSource: { ...currentSource, version: newVersion },
    from,
    to: newVersion,
  };
}

/**
 * Reconcile the canonical row's `source.version` after a successful native
 * `handler.update` swap, then bump the activation generation. Throws on a
 * reconcile WRITE failure (never a silent half-swap).
 *
 * The host injects the generation bumper (the activation-generation singleton
 * lives in the host `@/lib`, which this package cannot import) — the SAME IoC
 * pattern as the activate / capability-teardown hooks. When no bumper is wired
 * (a worker that never loaded the host module) the version flip still lands; only
 * the in-process cache-invalidation signal is skipped (the boot loader is the
 * durable path).
 */
export async function reconcileCanonicalVersionAfterNativeSwap(input: {
  row: InstalledExtension;
  newVersion: string | undefined;
  actorSource: string;
}): Promise<SwapReconcileOutcome> {
  const plan = planCanonicalVersionFlip(input.row.source, input.newVersion);
  if (!plan.flip) {
    return { reconciled: false, reason: plan.reason };
  }
  const { sourceSwitchExtension } = await import("./lifecycle-primitive");
  // sourceSwitchExtension re-validates provenance + preserves the lifecycle status
  // (locked stays locked). A WRITE failure THROWS → propagated to the dispatcher,
  // which surfaces the truthful "swap did not reconcile" op failure.
  await sourceSwitchExtension(input.row.id, plan.newSource, {
    actor: { source: input.actorSource },
    reason: `hot-swap canonical version reconcile ${plan.from} → ${plan.to}`,
  });
  fireSwapActivationGenerationBump(input.row.packageName);
  return { reconciled: true, from: plan.from, to: plan.to };
}

// ---------------------------------------------------------------------------
// Host-injected activation-generation bump (IoC, mirrors activate-hook.ts).
// ---------------------------------------------------------------------------

/** Bumps the host control-plane activation generation for a hot-swap (reason
 *  "hot-update"). Returns the new generation, or void when unavailable. */
export type SwapGenerationBumpHook = (packageName: string) => void;

const SWAP_GEN_HOOK_SLOT = Symbol.for("cinatra.extensions.swapGenerationBumpHook.v1");
type HookHolder = { hook: SwapGenerationBumpHook | null };
function hookHolder(): HookHolder {
  const g = globalThis as unknown as Record<symbol, HookHolder | undefined>;
  return (g[SWAP_GEN_HOOK_SLOT] ??= { hook: null });
}

/** Host wiring entry: inject the activation-generation bumper. Pass `null` to clear (tests). */
export function setSwapGenerationBumpHook(hook: SwapGenerationBumpHook | null): void {
  hookHolder().hook = hook;
}

/** Fire the injected generation bump. No-op (best-effort) when no host hook is
 *  wired — the canonical version flip already committed; the bump is only the
 *  in-process cache-invalidation signal. A throwing hook is logged + swallowed. */
function fireSwapActivationGenerationBump(packageName: string): void {
  const { hook } = hookHolder();
  if (!hook) return;
  try {
    hook(packageName);
  } catch (err) {
    console.warn(
      '[cinatra:extensions] swap generation-bump hook threw for "%s" ' +
        "(canonical version flip already committed; in-process cache invalidation only):",
      packageName,
      err instanceof Error ? err.message : err,
    );
  }
}
