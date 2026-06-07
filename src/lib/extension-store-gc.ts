// Pure garbage-collection selector for the runtime extension package store.
// NO IO: it decides WHICH on-disk digest dirs are safe
// to delete; the reaper in `extension-snapshot-lease.ts` does the actual fs rm.
//
// Store layout: /data/extensions/packages/<pkg@ver>/<digest>/ (digest-pinned).
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
