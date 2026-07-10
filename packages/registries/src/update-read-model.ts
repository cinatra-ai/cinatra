// Cached "update read model" for installed extensions.
//
// WHY THIS EXISTS (#1041 outcome 3):
//   The installed-extensions screen wants to show a per-extension
//   "update available" state. On dev/hub instances the app enumerates
//   registry versions live (listExtensionPackages / getPublishedExtensionSummary).
//   On GATEKEPT deployments the app process cannot reach the registry to
//   enumerate versions at render time — only the server-side hourly
//   catalog-sync loop (packages/marketplace-sync) can. This module is the
//   cached bridge: the sync loop WRITES a small per-package entry
//   ({ latestVersion, latestSdkAbiRange, refreshedAt }) as it sweeps, and the
//   installed-screen path READS those cached entries — no live enumeration.
//
// STORAGE-AGNOSTIC BY DESIGN:
//   This file defines the read-model TYPE, a storage PORT, pure builders, and
//   an in-memory reference store. The persistent (DB-backed) adapter and the
//   UI chip are #1041's own port — deliberately NOT here, so this unit is a
//   clean, non-UI, DB-migration-free mergeable slice testable without a DB.
//
// This package (@cinatra-ai/registries) is the registry READ path and already
// owns version semantics (version-compare.ts), so registry-derived update
// metadata belongs here. The sync worker stays decoupled: it receives a
// STRUCTURAL writer port (recordUpdateEntry) and never imports this module.

/**
 * One cached update-state row per installed extension package.
 *
 * `latestVersion` is the latest COMPARABLE (semver) version the sync loop last
 * observed in the registry, or `null` when the package has no resolvable semver
 * latest. A `null` here means "no update verdict is possible" — callers must
 * NOT feed it into `comparePluginVersions`; it is distinct from a `null` ENTRY
 * (see `InstalledUpdateReadout.entry`), which means "this package has never been
 * synced into the read model."
 *
 * `latestSdkAbiRange` is the raw `cinatra.sdkAbiRange` string declared by that
 * latest version, or `null` when the manifest declares none. It is stored
 * VERBATIM (no semver-range validation) so a malformed declared range still
 * surfaces to the ABI-compatibility check as incompatible rather than unknown.
 *
 * `refreshedAt` is the ISO-8601 timestamp of the sync sweep that last wrote
 * this entry. Staleness is derived from it at READ time (see
 * `readUpdateModelForInstalled`); the row itself carries no `stale` flag.
 */
export type ExtensionUpdateEntry = {
  packageName: string;
  latestVersion: string | null;
  latestSdkAbiRange: string | null;
  refreshedAt: string;
};

/**
 * Persistence PORT for the update read model. The host app supplies a
 * DB-backed implementation (out of scope for this unit); tests and non-DB
 * deployments use `InMemoryExtensionUpdateReadModelStore`.
 */
export interface ExtensionUpdateReadModelStore {
  /**
   * Read the cached entries for the given package names. Returns a map keyed
   * by `packageName`; names with no cached entry are simply absent from the
   * map (the caller treats an absent entry as "never synced" — see
   * `readUpdateModelForInstalled`).
   */
  read(packageNames: string[]): Promise<Map<string, ExtensionUpdateEntry>>;
  /** Insert-or-replace the given entries, keyed by `packageName`. */
  upsert(entries: ExtensionUpdateEntry[]): Promise<void>;
}

/**
 * Extract the raw `cinatra.sdkAbiRange` declared by a packument version /
 * package.json manifest. Pure extraction + trim ONLY — never validates the
 * range. Returns `null` when absent, non-string, or empty after trimming, so
 * an omitted range and a whitespace-only range both collapse to "none
 * declared" while a malformed-but-present range is preserved verbatim for the
 * ABI check to reject.
 */
export function extractLatestSdkAbiRange(manifest: unknown): string | null {
  if (manifest === null || typeof manifest !== "object") return null;
  const cinatra = (manifest as { cinatra?: unknown }).cinatra;
  if (cinatra === null || typeof cinatra !== "object") return null;
  const raw = (cinatra as { sdkAbiRange?: unknown }).sdkAbiRange;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Build a single read-model entry. `now` accepts a `Date` or an ISO string;
 * the stored `refreshedAt` is always normalised to an ISO-8601 string. A
 * non-string / empty `latestVersion` or `latestSdkAbiRange` collapses to
 * `null` so writers can pass raw manifest fields without pre-cleaning.
 */
export function buildUpdateEntry(input: {
  packageName: string;
  latestVersion: string | null | undefined;
  latestSdkAbiRange: string | null | undefined;
  now: Date | string;
}): ExtensionUpdateEntry {
  const refreshedAt =
    typeof input.now === "string" ? input.now : input.now.toISOString();
  const latestVersion =
    typeof input.latestVersion === "string" && input.latestVersion.trim() !== ""
      ? input.latestVersion
      : null;
  const latestSdkAbiRange =
    typeof input.latestSdkAbiRange === "string" &&
    input.latestSdkAbiRange.trim() !== ""
      ? input.latestSdkAbiRange
      : null;
  return { packageName: input.packageName, latestVersion, latestSdkAbiRange, refreshedAt };
}

/**
 * True when the entry is older than `ttlMs` relative to `now`, OR carries an
 * unparseable `refreshedAt`. An entry that cannot be dated is treated as stale
 * (fail-safe: an untrustworthy timestamp never reads as fresh). `ttlMs <= 0`
 * makes every entry stale.
 */
export function isUpdateEntryStale(
  entry: ExtensionUpdateEntry,
  now: Date | string,
  ttlMs: number,
): boolean {
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();
  const refreshedMs = Date.parse(entry.refreshedAt);
  if (!Number.isFinite(refreshedMs) || !Number.isFinite(nowMs)) return true;
  // A non-positive ttl means "never trust a cached entry" — force stale even
  // at the degenerate now === refreshedAt boundary.
  if (ttlMs <= 0) return true;
  return nowMs - refreshedMs > ttlMs;
}

/**
 * Read-model readout for one installed package: the cached `entry` (or `null`
 * when the package has never been synced) plus the derived `stale` flag.
 *
 * A missing entry is ALWAYS stale — "never synced" is an untrusted state, so
 * the caller can uniformly gate on `stale` without special-casing `null`.
 */
export type InstalledUpdateReadout = {
  packageName: string;
  entry: ExtensionUpdateEntry | null;
  stale: boolean;
};

/**
 * The gatekept installed-screen read path: for each installed package name,
 * return its cached update entry and whether it is stale. Staleness is
 * computed HERE (from `refreshedAt` vs `now`/`ttlMs`) rather than stored, so
 * the whole consumer contract (missing → stale, unparseable → stale, expired →
 * stale) lives in one place and every reader agrees.
 *
 * The returned array preserves the order of `installedPackageNames`.
 */
export async function readUpdateModelForInstalled(
  store: ExtensionUpdateReadModelStore,
  installedPackageNames: string[],
  opts: { now: Date | string; ttlMs: number },
): Promise<InstalledUpdateReadout[]> {
  const cached = await store.read(installedPackageNames);
  return installedPackageNames.map((packageName) => {
    const entry = cached.get(packageName) ?? null;
    const stale = entry === null || isUpdateEntryStale(entry, opts.now, opts.ttlMs);
    return { packageName, entry, stale };
  });
}

/**
 * In-memory reference store. Backs the test suite and any deployment that has
 * no persistent adapter wired. `read` returns only the requested names;
 * `upsert` is last-writer-wins keyed by `packageName`.
 */
export class InMemoryExtensionUpdateReadModelStore
  implements ExtensionUpdateReadModelStore
{
  private readonly rows = new Map<string, ExtensionUpdateEntry>();

  async read(packageNames: string[]): Promise<Map<string, ExtensionUpdateEntry>> {
    const out = new Map<string, ExtensionUpdateEntry>();
    for (const name of packageNames) {
      const row = this.rows.get(name);
      if (row) out.set(name, row);
    }
    return out;
  }

  async upsert(entries: ExtensionUpdateEntry[]): Promise<void> {
    for (const entry of entries) {
      this.rows.set(entry.packageName, entry);
    }
  }

  /** Test/introspection helper — total rows currently cached. */
  size(): number {
    return this.rows.size;
  }
}
