// The RUNTIME asset registry for dynamically-loaded artifact-renderer client
// bundles (epic #1620 M1 Slice A — cinatra#1630, plan §2.4).
//
// This is the second membership table of the two-path predicate
// (`loadable = inBuildMap OR inRuntimeAssetRegistry`, §2.4). The first table is
// the build-time generated map `GENERATED_ARTIFACT_RENDERERS` (system/
// first-party bases, server SSR fast path). THIS table binds the EXACT admitted
// tuple of a marketplace-installed renderer that executes via the main-realm
// dynamic `import(digestPinnedUrl)` client seam.
//
// TWO CONSTRAINTS FROM CODEX R1 (plan §2.4):
//  1. It is a per-process CACHE, not the multi-process source of truth. The
//     durable SoT is the DB-authoritative ACTIVE tarball digest (cinatra#792).
//     Every serving process must INDEPENDENTLY reconstruct admission from the
//     DB — so `resolveActive` takes an injectable `authority` reconstruct hook
//     for the cache-miss / cross-process-convergence path, and activation is
//     durably atomic (materialize→verify→activate; the cache is only written on
//     FULL success, so resolution can never select a half-materialized asset).
//  2. Identity is the EXACT tuple (never "package installed", never "present in
//     the generated map"). Registration derives the (package, slot) KEY the same
//     way the build map + the two arbitration registries do (`::` separator via
//     the shared `generatedArtifactRendererKey`), so the two-path predicate is a
//     plain membership check over one keyspace.
//
// REVOCATION (owner ruling 8): there is NO separate kill-switch / signer-
// revocation registry / quarantine-beyond-lifecycle machinery. The EXISTING
// extension delete/archive lifecycle IS the revocation path — `retireByPackage`
// is called by that lifecycle teardown, and the fail-closed freshness preflight
// (`runtime-renderer-descriptor.ts`) re-checks "still installed/active" at load.
// The digest failure counter below is the SAME best-effort 3-strike containment
// the build-map loader already ships (`artifact-renderer-loader.ts`), made
// digest-specific — a persistently-broken bundle stops being mounted; it is a
// stability net, not a security boundary.
//
// PURE / process-global `Symbol.for` singleton (same cross-compilation anchor as
// the arbitration registries): no React / DB / server-only, so it is
// unit-testable and survives duplicated module instances across Next.js bundler
// compilations.

import { generatedArtifactRendererKey } from "@cinatra-ai/objects/artifact-renderer-registry";
import type { ArtifactUiSlot } from "@cinatra-ai/sdk-extensions/artifact-contract";
import {
  type AdmittedClientBundleTuple,
  clientBundleTupleEquals,
} from "@cinatra-ai/sdk-extensions/artifact-client-bundle";

/** A live activation binding in the per-process cache. */
export interface RuntimeRendererActivation {
  tuple: AdmittedClientBundleTuple;
  /**
   * Monotonic activation generation (ABA-safe, mirroring the representation-
   * provider registry's floor): a later activation with a strictly HIGHER
   * generation supersedes; a lower/equal one is ignored, so a slow straggler
   * from a torn-down epoch can never resurrect or downgrade the active binding.
   */
  generation: number;
}

/** A digest is quarantined after this many post-admission load/verify failures
 * — the same threshold the build-map loader uses, made digest-specific. */
export const RUNTIME_RENDERER_QUARANTINE_THRESHOLD = 3;

/** Result of an atomic materialize→verify→activate admission. */
export type AdmitAndActivateResult =
  | { ok: true; activation: RuntimeRendererActivation }
  | {
      ok: false;
      reason:
        | "quarantined"
        | "materialize-failed"
        | "verify-failed"
        | "stale-generation";
    };

class RuntimeAssetRegistryImpl {
  // generatedKey (`<package>::<slot>`) -> the active admitted binding.
  private byKey = new Map<string, RuntimeRendererActivation>();
  // MONOTONIC generation floor per key (never lowered, kept as a tombstone
  // after teardown so a delayed straggler cannot resurrect a torn-down epoch).
  private generationFloor = new Map<string, number>();
  // digest -> post-admission failure count (digest-specific quarantine).
  private digestFailures = new Map<string, number>();

  /** The (package, slot) key, derived — NEVER caller-supplied — exactly as the
   * build map + arbitration registries derive it. */
  keyFor(packageName: string, slot: ArtifactUiSlot): string {
    return generatedArtifactRendererKey(packageName, slot);
  }

  /** Two-path membership: is an admitted runtime binding present for this key? */
  inRuntimeAssetRegistry(generatedKey: string): boolean {
    return this.byKey.has(generatedKey);
  }

  /**
   * The active admitted tuple for a key, or null. On a cache MISS an injectable
   * `authority` reconstruct hook (the DB-authoritative active digest → tuple)
   * is consulted so every serving process converges to the SAME durable SoT
   * without a warm cache. A reconstructed binding is
   * warmed into the cache under its own generation.
   */
  resolveActive(
    generatedKey: string,
    authority?: (key: string) => RuntimeRendererActivation | null,
  ): AdmittedClientBundleTuple | null {
    const hit = this.byKey.get(generatedKey);
    if (hit) return hit.tuple;
    if (!authority) return null;
    const reconstructed = authority(generatedKey);
    if (!reconstructed) return null;
    // Warm the cache only if the reconstructed generation is STRICTLY newer than
    // the key's monotonic floor and the digest is not quarantined — reconstruct
    // must obey the SAME admission rule as `admitAndActivate`. After a
    // `retireByPackage` teardown keeps the floor as a tombstone at N, a stale
    // authority view at generation N (== floor) must NOT resurrect the retired
    // epoch, so equality is rejected (`<= floor`), not only `< floor`.
    if (this.isDigestQuarantined(reconstructed.tuple.digest)) return null;
    const floor = this.generationFloor.get(generatedKey) ?? 0;
    if (reconstructed.generation <= floor) return null;
    this.byKey.set(generatedKey, reconstructed);
    this.generationFloor.set(generatedKey, reconstructed.generation);
    return reconstructed.tuple;
  }

  /**
   * Atomic materialize → verify → activate (plan §2.4 "atomicity"): the cache
   * binding is written ONLY after BOTH the (host-side) `materialize` thunk and
   * the `verify` predicate succeed, so resolution can never observe a
   * half-materialized or unverified asset. Rejects fail-closed:
   *   - a quarantined digest (never re-materialized);
   *   - a materialize throw (→ `materialize-failed`, digest failure recorded);
   *   - a false `verify` verdict (→ `verify-failed`, digest failure recorded —
   *     a bad digest that keeps failing verification is quarantined);
   *   - a stale/equal generation (→ `stale-generation`, ABA-safe).
   * The generation must be STRICTLY greater than the key's monotonic floor.
   */
  async admitAndActivate(args: {
    tuple: AdmittedClientBundleTuple;
    generation: number;
    /** Host-side materialize of the verified bytes into the content-addressed
     * store (idempotent; already-materialized is a fast no-op). */
    materialize: () => Promise<void>;
    /** The admission verdict: digest + signature + peer/ABI checks, ALL true. */
    verify: () => Promise<boolean>;
  }): Promise<AdmitAndActivateResult> {
    const { tuple, generation } = args;
    const key = this.keyFor(tuple.packageName, tuple.slot);

    if (this.isDigestQuarantined(tuple.digest)) {
      return { ok: false, reason: "quarantined" };
    }
    const floor = this.generationFloor.get(key) ?? 0;
    // A (re)activation must carry a generation STRICTLY GREATER than the key's
    // monotonic floor. The floor is kept as a tombstone across teardown, so a
    // delayed straggler at the torn-down epoch's generation (== floor) cannot
    // resurrect the binding; only a genuine reinstall at a higher generation
    // opens a new epoch. The first-ever activation clears this (floor defaults
    // to 0; an activation generation is ≥ 1).
    if (generation <= floor) {
      return { ok: false, reason: "stale-generation" };
    }

    try {
      await args.materialize();
    } catch {
      this.recordDigestFailure(tuple.digest);
      return { ok: false, reason: "materialize-failed" };
    }

    let verdict: boolean;
    try {
      verdict = await args.verify();
    } catch {
      verdict = false;
    }
    if (!verdict) {
      this.recordDigestFailure(tuple.digest);
      return { ok: false, reason: "verify-failed" };
    }

    // RE-CHECK the gate AFTER the async materialize/verify, immediately before
    // the synchronous commit: the floor could have advanced while we
    // awaited (a concurrent HIGHER-generation admission committed), and a digest
    // could have been quarantined. Committing unconditionally here would let a
    // SLOW lower-generation admission overwrite a newer one and LOWER the floor.
    // Re-reading the floor + quarantine and refusing a now-stale generation
    // closes that concurrent-overwrite window (the commit itself is synchronous,
    // so no interleave is possible once we pass this guard).
    if (this.isDigestQuarantined(tuple.digest)) {
      return { ok: false, reason: "quarantined" };
    }
    if (generation <= (this.generationFloor.get(key) ?? 0)) {
      return { ok: false, reason: "stale-generation" };
    }

    // Commit atomically: the key's whole prior binding is replaced and the
    // floor advances. Nothing observes an intermediate state.
    const activation: RuntimeRendererActivation = { tuple, generation };
    this.byKey.set(key, activation);
    this.generationFloor.set(key, generation);
    return { ok: true, activation };
  }

  /** True iff the SAME exact tuple is the active binding for its key (identity
   * is the tuple, not the package — the G1 regression asserts this). */
  isActiveTuple(tuple: AdmittedClientBundleTuple): boolean {
    const hit = this.byKey.get(this.keyFor(tuple.packageName, tuple.slot));
    return !!hit && clientBundleTupleEquals(hit.tuple, tuple);
  }

  // ---- digest-specific quarantine (best-effort 3-strike, per ruling 8) ------

  isDigestQuarantined(digest: string): boolean {
    return (this.digestFailures.get(digest) ?? 0) >= RUNTIME_RENDERER_QUARANTINE_THRESHOLD;
  }

  recordDigestFailure(digest: string): number {
    const next = (this.digestFailures.get(digest) ?? 0) + 1;
    this.digestFailures.set(digest, next);
    return next;
  }

  // ---- lifecycle teardown = the revocation path (owner ruling 8) ------------

  /**
   * Drop every active binding of a package (archive/delete lifecycle teardown).
   * The generation floor is KEPT as a tombstone so a delayed straggler from the
   * torn-down epoch cannot resurrect the provider; a genuine reinstall carries a
   * strictly higher generation. Returns the number of bindings removed. This IS
   * the revocation path — there is no separate kill-switch (ruling 8).
   */
  retireByPackage(packageName: string): number {
    let removed = 0;
    for (const [key, activation] of this.byKey) {
      if (activation.tuple.packageName === packageName) {
        this.byKey.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** @internal test/diagnostic snapshot of the active bindings. */
  _snapshot(): RuntimeRendererActivation[] {
    return Array.from(this.byKey.values()).map((a) => ({ ...a, tuple: { ...a.tuple } }));
  }

  /** @internal test-only reset (cache + floors + quarantine). */
  _clearForTests(): void {
    this.byKey.clear();
    this.generationFloor.clear();
    this.digestFailures.clear();
  }
}

// Cross-compilation singleton (same Symbol.for discipline as the arbitration
// registries + the build-map quarantine counter).
const RUNTIME_ASSET_REGISTRY_KEY = Symbol.for(
  "@cinatra-ai/host:artifact-runtime-asset-registry/v1",
);
type Holder = { [RUNTIME_ASSET_REGISTRY_KEY]?: RuntimeAssetRegistryImpl };
const holder = globalThis as unknown as Holder;

export const runtimeAssetRegistry: RuntimeAssetRegistryImpl =
  holder[RUNTIME_ASSET_REGISTRY_KEY] ??
  (holder[RUNTIME_ASSET_REGISTRY_KEY] = new RuntimeAssetRegistryImpl());

export type { RuntimeAssetRegistryImpl };
