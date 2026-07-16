"use server";

// The fail-closed freshness PREFLIGHT server action (epic #1620 M1 Slice A/B —
// cinatra#1630, plan §2.5, owner ruling 8). The main-realm client loader
// (`DynamicRendererLoader`) calls this — a BOUND server action passed from the
// server component (`ExtensionRendererMount`) — immediately before it `import()`s
// a (possibly browser-cached) renderer bundle, so an admitted-then-archived
// descriptor cannot be mounted from cache.
//
// It re-derives the racy admission subset from the in-process runtime asset
// registry + the EXISTING extension archive/delete lifecycle (ruling 8: the
// lifecycle IS the revocation path — there is no separate kill-switch/registry):
//   - installedActive     ← `isArtifactExtensionWriteAllowed` (a live active/locked
//                            install row; a torn-down extension denies).
//   - currentActiveDigest  ← the runtime registry's active binding digest (a
//                            superseded/retired binding no longer matches).
//   - digestQuarantined    ← the runtime registry's best-effort 3-strike counter.
//   - signatureVerified    ← the ACTIVE admitted binding's digest matching the
//                            descriptor's: that binding's Ed25519 signature was
//                            verified at admission (`admitAndActivate.verify`) and
//                            re-verified on every re-admission/upgrade, so an
//                            active-digest match IS a verified-signature witness in
//                            this process. (A from-cold re-verification against the
//                            stored signed metadata rides the same publish-metadata
//                            ingestion the admit-at-install path needs — HONEST GAP,
//                            documented on the issue; the lifecycle signals above
//                            are the primary freshness guarantee ruling 8 asks for.)
//
// HONEST TOCTOU LIMIT (plan §2.5): this rejects a stale/already-archived
// descriptor but cannot close the final window (an archive landing after a green
// verdict and immediately before the cached `import()`); the generation-change
// unmount + telemetry are the compensating guarantees, and already-executed
// top-level effects are not reversible.

import type { AdmittedClientBundleTuple } from "@cinatra-ai/sdk-extensions/artifact-client-bundle";

import { runtimeAssetRegistry } from "@/lib/artifacts/runtime-renderer-registry";
import {
  evaluateFreshnessPreflight,
  type FreshnessPreflightVerdict,
} from "@/lib/artifacts/runtime-renderer-descriptor";
import { isArtifactExtensionWriteAllowed } from "@/lib/artifacts/artifact-extension-access";

/**
 * Re-confirm a serialized runtime-renderer descriptor is STILL admitted. Bound
 * to the descriptor's exact tuple on the server (`.bind(null, tuple)`) and passed
 * to the client loader as its `preflight` prop. Never throws — any internal error
 * fails closed to the `archived` floor (the safe, never-blank degrade).
 */
export async function runRuntimeRendererFreshnessPreflight(
  tuple: AdmittedClientBundleTuple,
): Promise<FreshnessPreflightVerdict> {
  try {
    const key = runtimeAssetRegistry.keyFor(tuple.packageName, tuple.slot);
    const active = runtimeAssetRegistry.resolveActive(key);
    const installedActive = await isArtifactExtensionWriteAllowed(tuple.packageName);
    const currentActiveDigest = active?.digest ?? null;
    return evaluateFreshnessPreflight(tuple, {
      installedActive,
      currentActiveDigest,
      signatureVerified: currentActiveDigest === tuple.digest,
      digestQuarantined: runtimeAssetRegistry.isDigestQuarantined(tuple.digest),
    });
  } catch {
    // Fail closed: an unresolvable freshness state is treated as revoked, never
    // permitted to import. `archived` is the lifecycle-revocation floor reason.
    return { ok: false, reason: "archived" };
  }
}
