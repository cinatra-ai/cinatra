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

import {
  representationProviderRegistry,
  representationMatchSpecificity,
} from "@cinatra-ai/objects/artifact-renderer-registry";
import type { ArtifactUiSlot } from "@cinatra-ai/sdk-extensions/artifact-contract";

import {
  GENERATED_ARTIFACT_RENDERERS,
  type GeneratedArtifactRendererEntry,
} from "@/lib/generated/artifact-renderers";
import { PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS } from "@/lib/artifacts/artifact-read";

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
 * The generated build-map entries that are SYSTEM bases. `resolution: "required"`
 * is EXACTLY membership in `cinatra.systemExtensions`: the generator classifies
 * every entry `resolutionOf(pkg) = systemExtensions.has(pkg) ? "required" :
 * "guardedOptional"` (scripts/extensions/generate-extension-manifest.mjs). The map
 * carries an entry for EVERY bundled `kind:"artifact"` extension that declares
 * `cinatra.artifact.ui.renderers` — NOT only system ones — so a bundled NON-system
 * (`guardedOptional`) artifact could otherwise leak into the "system" set. That
 * would auto-bind it for every org AND exempt it from capability teardown — an
 * isolation break (activate-without-install + survive-uninstall). Filtering to
 * `required` here ENFORCES the "system = host-release-locked" boundary instead of
 * assuming the map only ever carries system bases (Codex convergence, cinatra#1630).
 */
function requiredSystemRendererEntries(): GeneratedArtifactRendererEntry[] {
  return Object.values(GENERATED_ARTIFACT_RENDERERS).filter(
    (entry) => entry.resolution === "required",
  );
}

/**
 * The set of package names the generated build map ships AS SYSTEM BASES — the
 * `resolution: "required"` (== `systemExtensions`) artifact-renderer packages.
 * THESE are the "system extensions" the teardown path must refuse to uninstall
 * (they are part of the host release, not marketplace installs). Derived from the
 * map (filtered to `required`) so it can never drift from what is built.
 */
export function systemArtifactRendererPackages(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const entry of requiredSystemRendererEntries()) {
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
 * generated build map AND GATED BY THE PREVIEW-INLINE ALLOWLIST. Each declared
 * representation (a wildcard like `image/*` or an exact MIME) is EXPANDED to the
 * set of allowlisted MIMEs it matches, and a spec is bound per EXACT allowlisted
 * MIME — never the raw wildcard.
 *
 * WHY (Codex): a system base renders inline by pointing at the host preview route
 * (`urls.preview`), which serves ONLY the allowlisted MIMEs and 415s the rest. A
 * raw `image/*` / `audio/*` / `video/*` provider would therefore claim rows the
 * byte route refuses (e.g. `image/bmp`, `audio/midi`, `video/quicktime`) and
 * mount a broken player instead of the never-blank fallback. Binding at the
 * allowlist granularity preserves the pre-cutover invariant exactly: the detail
 * page inline-renders precisely the MIMEs the preview route serves; everything
 * else falls to the generic floor. An entry with no `representations` contributes
 * none. Only `resolution: "required"` (== `systemExtensions`) entries are
 * projected — a bundled `guardedOptional` artifact renderer is NEVER auto-bound as
 * a system provider (Codex convergence, cinatra#1630).
 */
export function systemRepresentationProviderSpecs(): SystemRepresentationProviderSpec[] {
  const specs: SystemRepresentationProviderSpec[] = [];
  const seen = new Set<string>();
  for (const entry of requiredSystemRendererEntries()) {
    for (const pattern of entry.representations ?? []) {
      for (const mime of PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS) {
        // Bind an EXACT allowlisted MIME whenever the declared representation
        // matches it (exact / type-wildcard / catch-all).
        if (representationMatchSpecificity(pattern, mime) < 0) continue;
        const key = `${entry.packageName}\u0000${mime}\u0000${entry.slot}`;
        if (seen.has(key)) continue;
        seen.add(key);
        specs.push({ packageName: entry.packageName, pattern: mime, slot: entry.slot });
      }
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
