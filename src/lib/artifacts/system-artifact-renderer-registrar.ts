import "server-only";

// ---------------------------------------------------------------------------
// The boot-time SYSTEM artifact-renderer registrar (epic #1620 M1 Slice B —
// cinatra#1630, plan §5.1 "the four system `-artifact` bases", §5.3 guardrail 4).
//
// The four build-bundled system bases (image/pdf/audio/video-artifact) ship in
// the host build map `GENERATED_ARTIFACT_RENDERERS`. But the representation-
// provider arbitration registry is ORG-SCOPED (`registerProvider(orgId, …)`) —
// so a build-map entry alone does NOT make `resolveRepresentationDispatch` return
// tier "extension"; nothing binds the bases into the registry, so the legacy
// first-party host handlers keep rendering (the "no boot registrar" dormancy
// gap). This module closes it: it derives the canonical per-org provider bindings
// straight FROM the generated map and binds them under the generation-safe
// lifecycle contract, so after reconciliation the dispatch spine routes the four
// MIME families to the build-map fast path.
//
// GENERATION-SAFE LIFECYCLE (plan §5.3.4):
//   - per-org `registerProvider` binding (the existing arbitration API — this
//     module changes NEITHER arbitration registry);
//   - generation-ordered rebind: system bases carry a fixed monotonic generation
//     (they are build-bundled — a "system upgrade" is a host redeploy, i.e. a new
//     process that rebinds fresh at boot); a re-reconcile is an idempotent
//     replace-by-(pattern, slot);
//   - reconcile MISSING bindings: reconciliation is self-healing — it (re)binds
//     any spec the org is missing, so a fresh worker / a new org / a torn-down
//     epoch converges to the full system set;
//   - system extensions REJECT uninstall: the capability-teardown path skips the
//     system packages (see `extension-artifact-renderers-teardown.ts`), so their
//     bindings + generation floor are never retired — reconcile at the fixed
//     generation therefore always remains valid (never tombstoned);
//   - the floor covers transient gaps: before the first reconcile for an org (or
//     in a stale worker) the row falls to the never-blank generic floor, never a
//     blank.
//
// DERIVED, NOT HARDCODED: the bound provider set is a projection of
// `GENERATED_ARTIFACT_RENDERERS` — every build-map entry that declares
// `representations` binds one representation provider per (representation, slot).
// The generated map only ever carries the build-bundled system bases (a runtime/
// marketplace renderer is admitted through the runtime asset registry, never the
// generated map), so "every generated-map entry is a system provider" is exactly
// the set of platform bases — a new base appears purely by regenerating the map.
// ---------------------------------------------------------------------------

import { representationProviderRegistry } from "@cinatra-ai/objects/artifact-renderer-registry";
import type { ArtifactUiSlot } from "@cinatra-ai/sdk-extensions/artifact-contract";

import { GENERATED_ARTIFACT_RENDERERS } from "@/lib/generated/artifact-renderers";

/**
 * The fixed activation generation the system bases bind under. They are build-
 * bundled — effectively always at generation 1 within a process; a genuine
 * "upgrade" is a host redeploy (a new process that rebinds fresh). Because the
 * teardown path never retires a system package, this generation is never
 * tombstoned, so a self-healing reconcile at generation 1 always stays valid.
 */
export const SYSTEM_ARTIFACT_RENDERER_GENERATION = 1;

/** One canonical per-org representation-provider binding for a system base. */
export interface SystemRepresentationProviderSpec {
  packageName: string;
  /** A representation pattern (an exact MIME / a type-wildcard / catch-all). */
  pattern: string;
  slot: ArtifactUiSlot;
}

/**
 * The set of package names the generated build map ships — the system artifact-
 * renderer packages. THESE are the "system extensions" the teardown path must
 * refuse to uninstall (they are part of the host release, not marketplace
 * installs). Derived from the map so it can never drift from what is built.
 */
export function systemArtifactRendererPackages(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const entry of Object.values(GENERATED_ARTIFACT_RENDERERS)) {
    names.add(entry.packageName);
  }
  return names;
}

/** True iff `packageName` is a build-bundled system artifact-renderer base. */
export function isSystemArtifactRendererPackage(packageName: string): boolean {
  return systemArtifactRendererPackages().has(packageName);
}

/**
 * The canonical system representation-provider bindings, projected from the
 * generated build map: one (packageName, representation, slot) spec per declared
 * representation of every build-map entry. An entry with no `representations`
 * (a pure semantic-type renderer with no MIME representation) contributes none.
 */
export function systemRepresentationProviderSpecs(): SystemRepresentationProviderSpec[] {
  const specs: SystemRepresentationProviderSpec[] = [];
  for (const entry of Object.values(GENERATED_ARTIFACT_RENDERERS)) {
    for (const pattern of entry.representations ?? []) {
      specs.push({ packageName: entry.packageName, pattern, slot: entry.slot });
    }
  }
  return specs;
}

/**
 * Bind (idempotently, self-healing) every system base representation provider
 * for `orgId` into the arbitration registry under the fixed system generation.
 * Cheap in-memory registry writes; safe to call on every resolve — a spec the
 * org already carries is an idempotent replace, and a missing spec (fresh worker
 * / new org / post-`_clearForTests`) is re-bound. Returns the number of specs
 * (re)bound this call.
 *
 * SELF-HEALING over a memo: reconciliation reads the LIVE registry snapshot
 * rather than a per-process "already reconciled" flag, so it converges after a
 * test-reset or any transient gap without stale-cache coupling. When the org
 * already carries every system spec, this is a no-op fast path.
 */
export function reconcileSystemRepresentationProviders(orgId: string): number {
  const specs = systemRepresentationProviderSpecs();
  if (specs.length === 0) return 0;

  // Fast path: skip the writes when the org already carries every system spec
  // (the steady state on a warm worker).
  const present = representationProviderRegistry._snapshotOrgProviders(orgId);
  const has = (s: SystemRepresentationProviderSpec): boolean =>
    present.some(
      (d) => d.packageName === s.packageName && d.pattern === s.pattern && d.slot === s.slot,
    );
  if (specs.every(has)) return 0;

  for (const spec of specs) {
    representationProviderRegistry.registerProvider(orgId, {
      packageName: spec.packageName,
      pattern: spec.pattern,
      slot: spec.slot,
      generation: SYSTEM_ARTIFACT_RENDERER_GENERATION,
    });
  }
  return specs.length;
}
