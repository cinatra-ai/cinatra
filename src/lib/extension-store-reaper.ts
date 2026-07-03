import "server-only";

// Explicit content-addressed store GC reaper (cinatra#796 — epic #790 stage 6).
//
// A MAINTENANCE job (scheduled worker + admin-triggered; NEVER boot — boot only
// does its cheap integrity re-verify and, elsewhere, SEEDS the delayed loop
// job). It enforces the epic's retention contract over the V2 store
// (`<CINATRA_EXTENSION_DATA_ROOT>/<kind>/<slug>/<digest>/`):
//
//     keep the ACTIVE digest + the `retainPerSlug` (default 2) newest prior
//     digests per {kind, slug}; delete the rest — never anything active,
//     leased, undatable, too young, or belonging to a fail-closed slug.
//
// Set derivation is FAIL-CLOSED end to end:
//   - ACTIVE = for every LIVE (active|locked) canonical row with a store kind,
//     the SHARED journal-gated selector (`selectActiveDigest`, cinatra#792 —
//     the SAME rule the loader's trust anchor and the boot rematerialize sweep
//     apply): row `source.activeDigest` honored only when the FINALIZED
//     install-op journal digest confirms it, else the journal digest alone.
//     A row the selector refuses — or a live row with NO bindable digest
//     (mid-install placeholder, legacy, bundled-without-digest) — marks its
//     whole {kind, slug} UNSAFE: untouchable this run.
//   - A canonical-rows or lease-list read failure ABORTS the run (never
//     "empty set = everything eligible").
//   - Keys are `{kind, packageName, digest}` (a bare pkg@digest aliases across
//     kinds); the kind-less lease table conservatively protects its
//     pkg@digest under EVERY kind.
//
// TOCTOU (mirrors `reapStore`/cinatra#850, extended per the plan convergence):
// immediately before each delete the reaper re-verifies BOTH liveness axes
// against FRESH reads — the lease (`hasLiveSnapshotLease`) AND the DB/journal
// active binding for the entry's package — so a lease acquired, or a rollback
// re-point landed, after the planning snapshot can never lose its digest dir.
//
// SCOPE: extension-store only. Artifact USER-DATA blobs live under the
// separate `CINATRA_ARTIFACT_DATA_ROOT` (cinatra#926) with DB-reachability GC
// — this reaper never touches them. The `artifact` EXTENSION KIND's store
// payloads are swept like every other kind. The reaper never touches
// `.staging`, quarantine subtrees, or `current` files (discovery walks only
// digest dirs under known kind dirs), never writes the DB, and is never a
// trust input.

import {
  digestKey,
  planStoreGc,
  storeGcDigestKey,
  storeGcSlugKey,
  type StoreGcCandidate,
  type StoreGcPlan,
} from "@/lib/extension-store-gc";
import {
  isExtensionStoreKind,
  STORE_SIDECAR_FILENAME,
} from "@/lib/extension-package-store-core";
import { selectActiveDigest } from "@/lib/extension-install-anchor";
import type { SnapshotLeaseDeps } from "@/lib/extension-snapshot-lease";

/** Default: keep the active digest + the 2 newest priors per {kind, slug}. */
export const STORE_GC_DEFAULT_RETAIN_PER_SLUG = 2;
/** Default: never delete a digest dir materialized less than 1h ago. */
export const STORE_GC_DEFAULT_MIN_AGE_MS = 60 * 60 * 1000;

type ReaperRow = {
  packageName: string;
  organizationId: string | null;
  status: string;
  kind: string;
  source: { activeDigest?: string } | null;
};

type DiscoveredEntry = StoreGcCandidate & { storeDir: string };

export type ExtensionStoreReapOptions = {
  /** Plan only — delete nothing, return the full plan in the report. */
  dryRun?: boolean;
  /** Non-active digests to retain per {kind, slug} (default 2). */
  retainPerSlug?: number;
  /** Never delete a digest younger than this (default 1h). */
  minAgeMs?: number;
  /** Override "now" (ISO) for the lease reads + age math (tests). */
  now?: string;
};

export type ExtensionStoreReapDeps = {
  /** Override the data root (default: resolveExtensionDataRoot()). */
  dataRoot?: string;
  /** Discover materialized digest dirs (default: discoverStoreRecordsV2). */
  discover?: (dataRoot: string) => Promise<
    { kind: string; packageName: string; declaredDigest?: string; storeDir: string }[]
  >;
  /** Read a digest dir's sidecar materializedAt in epoch ms (null = unknown). */
  readMaterializedAtMs?: (storeDir: string) => Promise<number | null>;
  /** ALL canonical rows across orgs (default: canonical store). THROWS abort the run. */
  listRows?: () => Promise<ReaperRow[]>;
  /** Rows for ONE package (fresh pre-delete re-check). THROWS = skip the entry. */
  listRowsForPackage?: (packageName: string) => Promise<ReaperRow[]>;
  /** FINALIZED-only journal digest for a (package, org) scope (else null). */
  readJournalDigest?: (packageName: string, orgId: string | null) => Promise<string | null>;
  /** Live-lease snapshot keys `digestKey(pkg, digest)`. THROWS abort the run. */
  listLeasedDigests?: (now?: string) => Promise<Set<string>>;
  /** FRESH per-entry live-lease probe (TOCTOU re-check). */
  hasLiveLease?: (packageName: string, digest: string, now?: string) => Promise<boolean>;
  /** Delete a digest dir + its sibling `<digest>.tgz`. */
  rmDigestDir?: (storeDir: string) => Promise<void>;
  /** Lease DB deps (schema/query injection for the defaults above). */
  leaseDeps?: SnapshotLeaseDeps;
  /** "Now" in epoch ms for the age math (default Date.now / opts.now). */
  nowMs?: number;
};

export type ExtensionStoreReapReport = {
  dryRun: boolean;
  dataRoot: string;
  scannedDigests: number;
  activeDigests: number;
  unsafeSlugs: string[];
  deleted: { kind: string; packageName: string; digest: string }[];
  retained: { kind: string; packageName: string; digest: string }[];
  protectedEntries: { kind: string; packageName: string; digest: string; reason: string }[];
  /** Eligible at plan time but skipped by the fresh pre-delete re-check. */
  skippedForRacedLease: { kind: string; packageName: string; digest: string }[];
  skippedForRacedActive: { kind: string; packageName: string; digest: string }[];
  /** Eligible entries whose rm failed (logged, non-fatal). */
  failedDeletes: { kind: string; packageName: string; digest: string; error: string }[];
};

function toRef(e: StoreGcCandidate): { kind: string; packageName: string; digest: string } {
  return { kind: e.kind, packageName: e.packageName, digest: e.digest };
}

async function defaultReadMaterializedAtMs(storeDir: string): Promise<number | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const raw = await readFile(path.join(storeDir, STORE_SIDECAR_FILENAME), "utf8");
    const sidecar = JSON.parse(raw) as { materializedAt?: unknown };
    if (typeof sidecar.materializedAt !== "string") return null;
    const ms = Date.parse(sidecar.materializedAt);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null; // missing/garbage sidecar → unknown age → protected
  }
}

/**
 * Derive the (activeKeys, unsafeSlugs) sets from canonical rows through the
 * shared journal-gated selector. EVERY live (active|locked) store-kind row is
 * processed — canonical identity includes the OWNER scope, so multiple live
 * rows per (package, org) are legal and their confirmed digests are UNIONED;
 * no row may shadow another (an archived/stale row ordered first must never
 * hide a live row's binding). Fail-closed per row: a selector refusal, an
 * unreadable journal, or a live row with no bindable digest poisons its
 * {kind, slug} for this run.
 */
async function deriveActiveSets(
  rows: readonly ReaperRow[],
  readJournalDigest: (pkg: string, orgId: string | null) => Promise<string | null>,
): Promise<{ activeKeys: Set<string>; unsafeSlugs: Set<string> }> {
  const activeKeys = new Set<string>();
  const unsafeSlugs = new Set<string>();
  // Journal reads are per (package, org) scope; cache them so multiple owner
  // rows in one scope don't re-read (a cache, NEVER a row de-dup — every live
  // row still runs the selector below).
  const journalCache = new Map<string, Promise<string | null>>();
  for (const row of rows) {
    if (row.status !== "active" && row.status !== "locked") continue; // not live
    if (!isExtensionStoreKind(row.kind)) continue; // no store dir can share this kind
    const slugKey = storeGcSlugKey(row.kind, row.packageName);
    const scopeKey = `${row.packageName}::${row.organizationId ?? ""}`;
    let journalDigest: string | null;
    try {
      let cached = journalCache.get(scopeKey);
      if (!cached) {
        cached = readJournalDigest(row.packageName, row.organizationId);
        journalCache.set(scopeKey, cached);
      }
      journalDigest = await cached;
    } catch {
      unsafeSlugs.add(slugKey); // unreadable journal → fail closed for the slug
      continue;
    }
    const selection = selectActiveDigest({
      activeDigest: row.source?.activeDigest ?? null,
      journalDigest,
    });
    if (!selection.ok || !selection.digest) {
      // Selector refusal OR a live row with no bindable digest (mid-install
      // placeholder / legacy / bundled-without-digest): we cannot know which
      // on-disk digest this install uses — never reap the slug this run.
      unsafeSlugs.add(slugKey);
      continue;
    }
    activeKeys.add(storeGcDigestKey(row.kind, row.packageName, selection.digest));
  }
  return { activeKeys, unsafeSlugs };
}

/**
 * Run the retention-aware store reap. Read-failures on the planning inputs
 * ABORT (throw); per-entry delete failures are collected, never thrown.
 */
export async function reapExtensionStore(
  opts: ExtensionStoreReapOptions = {},
  deps: ExtensionStoreReapDeps = {},
): Promise<ExtensionStoreReapReport> {
  const dataRoot =
    deps.dataRoot ?? (await import("@/lib/extension-data-root")).resolveExtensionDataRoot();
  const discover =
    deps.discover ??
    (async (root: string) => {
      const { discoverStoreRecordsV2, realStoreFs } = await import("@/lib/extension-store-io");
      return discoverStoreRecordsV2(root, realStoreFs);
    });
  const readMaterializedAtMs = deps.readMaterializedAtMs ?? defaultReadMaterializedAtMs;
  const listRows =
    deps.listRows ??
    (async () => {
      const { listInstalledExtensions } = await import("@cinatra-ai/extensions/canonical-store");
      const rows = await listInstalledExtensions({});
      return rows.map((r) => ({
        packageName: r.packageName,
        organizationId: r.organizationId ?? null,
        status: r.status,
        kind: r.kind,
        source: (r.source ?? null) as ReaperRow["source"],
      }));
    });
  const listRowsForPackage =
    deps.listRowsForPackage ??
    (async (packageName: string) => {
      const { readInstalledExtensionsByPackageName } = await import(
        "@cinatra-ai/extensions/canonical-store"
      );
      const rows = await readInstalledExtensionsByPackageName(packageName);
      return rows.map((r) => ({
        packageName: r.packageName,
        organizationId: r.organizationId ?? null,
        status: r.status,
        kind: r.kind,
        source: (r.source ?? null) as ReaperRow["source"],
      }));
    });
  const readJournalDigest =
    deps.readJournalDigest ??
    (async (packageName: string, orgId: string | null) => {
      const { readInstallOp } = await import("@/lib/extension-install-ops");
      const op = await readInstallOp(packageName, orgId);
      // FINALIZED-only: a non-finalized latest attempt must never look like a
      // confirmed binding (the same filter the boot rematerialize sweep applies).
      return op && op.phase === "finalized" ? (op.digest ?? null) : null;
    });
  const listLeasedDigests =
    deps.listLeasedDigests ??
    (async (now?: string) => {
      const { listActiveLeases } = await import("@/lib/extension-snapshot-lease");
      const leases = await listActiveLeases(now !== undefined ? { now } : {}, deps.leaseDeps);
      return new Set(leases.map((l) => digestKey(l.packageName, l.digest)));
    });
  const hasLiveLease =
    deps.hasLiveLease ??
    (async (packageName: string, digest: string, now?: string) => {
      const { hasLiveSnapshotLease } = await import("@/lib/extension-snapshot-lease");
      return hasLiveSnapshotLease(packageName, digest, now, deps.leaseDeps);
    });
  const rmDigestDir =
    deps.rmDigestDir ??
    (async (storeDir: string) => {
      const { rm } = await import("node:fs/promises");
      await rm(storeDir, { recursive: true, force: true });
      await rm(`${storeDir}.tgz`, { force: true }).catch(() => undefined);
    });

  // ---- planning snapshot (any read failure here throws → run aborted) ----
  const discovered = await discover(dataRoot);
  const entries: DiscoveredEntry[] = [];
  for (const rec of discovered) {
    if (!rec.declaredDigest) continue; // defensive: V2 discovery is digest-pinned
    entries.push({
      kind: rec.kind,
      packageName: rec.packageName,
      digest: rec.declaredDigest,
      materializedAtMs: await readMaterializedAtMs(rec.storeDir),
      storeDir: rec.storeDir,
    });
  }
  const rows = await listRows();
  const { activeKeys, unsafeSlugs } = await deriveActiveSets(rows, readJournalDigest);
  const leasedPkgDigests = await listLeasedDigests(opts.now);

  const nowMs = deps.nowMs ?? (opts.now !== undefined ? Date.parse(opts.now) : Date.now());
  const plan: StoreGcPlan = planStoreGc({
    onDisk: entries,
    activeKeys,
    leasedPkgDigests,
    unsafeSlugs,
    retainPerSlug: opts.retainPerSlug ?? STORE_GC_DEFAULT_RETAIN_PER_SLUG,
    nowMs: Number.isFinite(nowMs) ? nowMs : Date.now(),
    minAgeMs: opts.minAgeMs ?? STORE_GC_DEFAULT_MIN_AGE_MS,
  });

  const report: ExtensionStoreReapReport = {
    dryRun: opts.dryRun === true,
    dataRoot,
    scannedDigests: entries.length,
    activeDigests: activeKeys.size,
    unsafeSlugs: [...unsafeSlugs],
    deleted: [],
    retained: plan.retained.map(toRef),
    protectedEntries: plan.protectedEntries.map((p) => ({ ...toRef(p.entry), reason: p.reason })),
    skippedForRacedLease: [],
    skippedForRacedActive: [],
    failedDeletes: [],
  };

  if (opts.dryRun) {
    // dryRun reports the plan's eligible set as `deleted` (with dryRun:true)
    // so operators preview exactly the delete set; nothing is touched.
    report.deleted = plan.eligible.map(toRef);
    return report;
  }

  // ---- delete loop with FRESH per-entry re-checks (TOCTOU, cinatra#850) ----
  for (const entry of plan.eligible as DiscoveredEntry[]) {
    // (1) lease re-check: a lease raced in after the snapshot?
    if (await hasLiveLease(entry.packageName, entry.digest, opts.now)) {
      report.skippedForRacedLease.push(toRef(entry));
      continue;
    }
    // (2) active-binding re-check: a rollback/re-point (or a fresh install
    // finalize) raced in after the snapshot? Re-read THIS package's rows and
    // re-derive its binding; any refusal/unknown → skip (fail closed).
    try {
      const pkgRows = await listRowsForPackage(entry.packageName);
      const fresh = await deriveActiveSets(pkgRows, readJournalDigest);
      // Conservative: every key in `fresh.activeKeys` is already THIS package
      // (single-package read), so a live row binding this digest under ANY
      // kind protects the dir.
      const nowActive = [...fresh.activeKeys].some((k) => k.endsWith(`@${entry.digest}`));
      if (nowActive || fresh.unsafeSlugs.has(storeGcSlugKey(entry.kind, entry.packageName))) {
        report.skippedForRacedActive.push(toRef(entry));
        continue;
      }
    } catch {
      report.skippedForRacedActive.push(toRef(entry)); // unreadable → fail closed
      continue;
    }
    try {
      await rmDigestDir(entry.storeDir);
      report.deleted.push(toRef(entry));
    } catch (err) {
      report.failedDeletes.push({
        ...toRef(entry),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return report;
}
