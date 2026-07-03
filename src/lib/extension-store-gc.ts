// Pure garbage-collection selector for the runtime extension package store.
// NO IO: it decides WHICH on-disk digest dirs are safe
// to delete; the reaper in `extension-snapshot-lease.ts` does the actual fs rm.
//
// Store layout (cinatra#791): `<dataRoot>/<kind>/<slug>/<digest>/` (digest-pinned).
// Updates land at a NEW <digest> path (never overwrite in place) and the loader
// imports per-digest `file://` URLs — so a new digest is naturally a fresh
// module graph. That IS the ESM-cache-safe update mechanism: the old digest dir
// keeps serving in-flight runs (its module instances stay live, cached under
// the old `file://` URL), while new runs import the new digest's distinct URL.
// GC's job is to reclaim a digest dir ONLY once it is neither the active digest
// nor under a live lease.
//
// A digest is keyed `pkg@digest` in the active/leased sets so two packages that
// happen to share a digest never alias each other.

export type OnDiskDigest = { packageName: string; digest: string };

export type SelectGcEligibleInput = {
  /** Every materialized digest dir currently on disk. */
  onDisk: readonly OnDiskDigest[];
  /** The currently-activated digest per package, keyed `pkg@digest`. */
  activeDigests: ReadonlySet<string>;
  /** Digests with a LIVE (unexpired) lease, keyed `pkg@digest`. */
  leasedDigests: ReadonlySet<string>;
};

/** Stable `pkg@digest` key used across the active/leased sets and the GC. */
export function digestKey(packageName: string, digest: string): string {
  return `${packageName}@${digest}`;
}

/**
 * The digest dirs safe to delete = onDisk MINUS active MINUS leased. Pure and
 * total: empty input → empty output; a digest that is both active and leased is
 * (redundantly) excluded. The returned array preserves `onDisk` order.
 */
export function selectGcEligibleDigests(input: SelectGcEligibleInput): OnDiskDigest[] {
  const { onDisk, activeDigests, leasedDigests } = input;
  const eligible: OnDiskDigest[] = [];
  for (const entry of onDisk) {
    const key = digestKey(entry.packageName, entry.digest);
    if (activeDigests.has(key)) continue; // never delete the live digest
    if (leasedDigests.has(key)) continue; // never delete under an in-flight run
    eligible.push({ packageName: entry.packageName, digest: entry.digest });
  }
  return eligible;
}

// ---------------------------------------------------------------------------
// V2 retention-aware GC PLANNER (cinatra#796) — pure, no IO.
//
// The maintenance reaper (`extension-store-reaper.ts`) composes this planner
// over the kind-segregated V2 layout (`<root>/<kind>/<slug>/<digest>/`). All
// deletion-relevant sets are re-keyed `{kind, packageName, digest}` — a bare
// `pkg@digest` key aliases across kinds (the same package name could hold the
// same digest under two kind dirs), so the ACTIVE set is kind-keyed. The LEASE
// table has no kind column, so a lease conservatively protects its
// `pkg@digest` under EVERY kind (over-protection is the safe direction).
//
// Retention: per `{kind, slug}` the ACTIVE digest(s) plus the
// `retainPerSlug` (default 2) NEWEST non-active digests — ordered by the
// sidecar's `materializedAt` — are kept, so a rollback (`current`/activeDigest
// re-point) always has a window to land in. A slug with NO active digest at
// all (no live canonical row anywhere — uninstalled/archived leftovers)
// retains nothing: its dirs are reclaimable garbage (still lease/age-guarded).
//
// FAIL-SAFE rules (each protects, never widens deletion):
//   - unknown `materializedAt` (missing/garbage sidecar) → never deleted (we
//     cannot order what we cannot date);
//   - younger than `minAgeMs` → never deleted (belt + braces for a
//     materialize racing its own journal finalize);
//   - a slug whose DB rows could not be safely bound to a digest
//     (`unsafeSlugs`, fail-closed selector / undigested live row) → untouched.
// ---------------------------------------------------------------------------

/** Stable `kind:pkg@digest` key for the kind-segregated V2 sets. */
export function storeGcDigestKey(kind: string, packageName: string, digest: string): string {
  return `${kind}:${packageName}@${digest}`;
}

/** Stable `kind:pkg` slug key (matches `unsafeSlugs` entries). */
export function storeGcSlugKey(kind: string, packageName: string): string {
  return `${kind}:${packageName}`;
}

export type StoreGcCandidate = {
  kind: string;
  packageName: string;
  digest: string;
  /** Sidecar `materializedAt` in epoch ms; null = unknown (protected). */
  materializedAtMs: number | null;
};

export type StoreGcProtectedReason =
  | "active"
  | "leased"
  | "unsafe-package"
  | "unknown-age"
  | "min-age";

export type PlanStoreGcInput = {
  /** Every materialized digest dir currently on disk (V2 discovery). */
  onDisk: readonly StoreGcCandidate[];
  /** DB-anchored active digests, keyed `storeGcDigestKey(kind, pkg, digest)`. */
  activeKeys: ReadonlySet<string>;
  /** Live-leased digests keyed `digestKey(pkg, digest)` (leases carry no kind). */
  leasedPkgDigests: ReadonlySet<string>;
  /** Slugs (`storeGcSlugKey`) whose rows could not be safely digest-bound. */
  unsafeSlugs: ReadonlySet<string>;
  /** Non-active digests to retain per `{kind, slug}` (default 2 = "current + 2"). */
  retainPerSlug?: number;
  /** "Now" in epoch ms (injected for determinism). */
  nowMs: number;
  /** Never delete a digest younger than this (ms). */
  minAgeMs: number;
};

export type StoreGcPlan = {
  /** Safe to delete, preserving `onDisk` order. */
  eligible: StoreGcCandidate[];
  /** Kept by the per-slug retention window. */
  retained: StoreGcCandidate[];
  /** Everything else kept, with the (first) reason it was protected. */
  protectedEntries: { entry: StoreGcCandidate; reason: StoreGcProtectedReason }[];
};

/**
 * Pure retention-aware GC plan over the V2 store: eligible = onDisk MINUS
 * active MINUS leased MINUS unsafe-slug MINUS undatable MINUS too-young MINUS
 * the per-slug retention window. Total: empty input → empty plan.
 */
export function planStoreGc(input: PlanStoreGcInput): StoreGcPlan {
  const retainPerSlug = Math.max(0, Math.floor(input.retainPerSlug ?? 2));
  const eligible: StoreGcCandidate[] = [];
  const retained: StoreGcCandidate[] = [];
  const protectedEntries: StoreGcPlan["protectedEntries"] = [];

  // Slugs that have at least one ACTIVE digest (live install) — only those get
  // a retention window; a slug with no active digest is reclaimable garbage.
  const slugsWithActive = new Set<string>();
  for (const key of input.activeKeys) {
    const at = key.lastIndexOf("@");
    if (at > 0) slugsWithActive.add(key.slice(0, at));
  }

  // First pass: hard protections, in fail-safe order.
  const retentionCandidates = new Map<string, StoreGcCandidate[]>();
  for (const entry of input.onDisk) {
    const kindKey = storeGcDigestKey(entry.kind, entry.packageName, entry.digest);
    const slugKey = storeGcSlugKey(entry.kind, entry.packageName);
    if (input.activeKeys.has(kindKey)) {
      protectedEntries.push({ entry, reason: "active" });
      continue;
    }
    if (input.leasedPkgDigests.has(digestKey(entry.packageName, entry.digest))) {
      protectedEntries.push({ entry, reason: "leased" });
      continue;
    }
    if (input.unsafeSlugs.has(slugKey)) {
      protectedEntries.push({ entry, reason: "unsafe-package" });
      continue;
    }
    if (entry.materializedAtMs === null || !Number.isFinite(entry.materializedAtMs)) {
      protectedEntries.push({ entry, reason: "unknown-age" });
      continue;
    }
    if (input.nowMs - entry.materializedAtMs < input.minAgeMs) {
      protectedEntries.push({ entry, reason: "min-age" });
      continue;
    }
    const bucket = retentionCandidates.get(slugKey);
    if (bucket) bucket.push(entry);
    else retentionCandidates.set(slugKey, [entry]);
  }

  // Second pass: per-slug retention window over the datable non-active rest.
  const retainedSet = new Set<StoreGcCandidate>();
  for (const [slugKey, entries] of retentionCandidates) {
    if (!slugsWithActive.has(slugKey) || retainPerSlug === 0) continue;
    const newestFirst = [...entries].sort(
      (a, b) => (b.materializedAtMs ?? 0) - (a.materializedAtMs ?? 0),
    );
    for (const kept of newestFirst.slice(0, retainPerSlug)) retainedSet.add(kept);
  }
  for (const entry of input.onDisk) {
    if (retainedSet.has(entry)) {
      retained.push(entry);
      continue;
    }
    // Eligible = survived pass 1 into a retention bucket and NOT retained.
    const bucket = retentionCandidates.get(storeGcSlugKey(entry.kind, entry.packageName));
    if (bucket && bucket.includes(entry)) eligible.push(entry);
  }
  return { eligible, retained, protectedEntries };
}
