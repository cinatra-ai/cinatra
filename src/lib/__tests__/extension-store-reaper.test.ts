import { describe, it, expect } from "vitest";
import {
  reapExtensionStore,
  type ExtensionStoreReapDeps,
} from "@/lib/extension-store-reaper";
import { digestKey } from "@/lib/extension-store-gc";

// ===========================================================================
// The composed maintenance reaper (cinatra#796), exercised fs/DB-free through
// its injected deps: set derivation from canonical rows + the FINALIZED-only
// journal, retention, dryRun, the per-entry TOCTOU re-checks (fresh lease +
// fresh active binding), fail-closed rows, and idempotence.
// ===========================================================================

const PKG = "@cinatra-ai/foo-connector";
const BAR = "bar-skill";
const NOW_ISO = "2026-07-03T12:00:00.000Z";
const NOW = Date.parse(NOW_ISO);
const HOUR = 60 * 60 * 1000;

type Row = {
  packageName: string;
  organizationId: string | null;
  status: string;
  kind: string;
  source: { activeDigest?: string } | null;
};

type DiskDir = {
  kind: string;
  packageName: string;
  digest: string;
  /** hours before NOW the sidecar says it materialized (null = no sidecar). */
  ageHours: number | null;
};

function harness(input: {
  disk: DiskDir[];
  rows?: Row[];
  /** finalized journal digest per `${pkg}::${org ?? ""}` scope. */
  journal?: Record<string, string | null>;
  leases?: { packageName: string; digest: string }[];
  /** overrides applied on top of the fake deps (e.g. failure injection). */
  overrides?: Partial<ExtensionStoreReapDeps>;
}) {
  const removed: string[] = [];
  const rows = input.rows ?? [];
  const journal = input.journal ?? {};
  const leaseKeys = new Set((input.leases ?? []).map((l) => digestKey(l.packageName, l.digest)));
  const dirFor = (d: DiskDir) => `/root/${d.kind}/${d.packageName}/${d.digest}`;
  const byDir = new Map(input.disk.map((d) => [dirFor(d), d] as const));
  const deps: ExtensionStoreReapDeps = {
    dataRoot: "/root",
    discover: async () =>
      input.disk.map((d) => ({
        kind: d.kind,
        packageName: d.packageName,
        declaredDigest: d.digest,
        storeDir: dirFor(d),
      })),
    readMaterializedAtMs: async (storeDir) => {
      const d = byDir.get(storeDir);
      return d && d.ageHours !== null ? NOW - d.ageHours * HOUR : null;
    },
    listRows: async () => rows,
    listRowsForPackage: async (pkg) => rows.filter((r) => r.packageName === pkg),
    readJournalDigest: async (pkg, orgId) => journal[`${pkg}::${orgId ?? ""}`] ?? null,
    listLeasedDigests: async () => new Set(leaseKeys),
    hasLiveLease: async (pkg, digest) => leaseKeys.has(digestKey(pkg, digest)),
    rmDigestDir: async (storeDir) => {
      removed.push(storeDir);
    },
    nowMs: NOW,
    ...input.overrides,
  };
  return { deps, removed, dirFor };
}

/** A live connector row whose activeDigest the finalized journal confirms. */
function liveRow(pkg: string, kind: string, digest: string): { row: Row; journal: Record<string, string> } {
  return {
    row: { packageName: pkg, organizationId: null, status: "active", kind, source: { activeDigest: digest } },
    journal: { [`${pkg}::`]: digest },
  };
}

describe("reapExtensionStore", () => {
  it("enforces current + 2: deletes only the datable priors beyond the retention window (dir + report)", async () => {
    const { row, journal } = liveRow(PKG, "connector", "d-active");
    const { deps, removed, dirFor } = harness({
      disk: [
        { kind: "connector", packageName: PKG, digest: "d-active", ageHours: 100 },
        { kind: "connector", packageName: PKG, digest: "d-p1", ageHours: 10 },
        { kind: "connector", packageName: PKG, digest: "d-p2", ageHours: 20 },
        { kind: "connector", packageName: PKG, digest: "d-p3", ageHours: 30 },
      ],
      rows: [row],
      journal,
    });
    const report = await reapExtensionStore({ now: NOW_ISO }, deps);
    expect(report.deleted.map((d) => d.digest)).toEqual(["d-p3"]);
    expect(removed).toEqual([dirFor({ kind: "connector", packageName: PKG, digest: "d-p3", ageHours: 30 })]);
    expect(report.retained.map((d) => d.digest).sort()).toEqual(["d-p1", "d-p2"]);
    expect(report.protectedEntries.map((p) => [p.digest, p.reason])).toEqual([["d-active", "active"]]);
    expect(report.scannedDigests).toBe(4);
    expect(report.activeDigests).toBe(1);
    expect(report.dryRun).toBe(false);
  });

  it("is idempotent: a second run over the post-reap disk deletes nothing", async () => {
    const { row, journal } = liveRow(PKG, "connector", "d-active");
    const disk: DiskDir[] = [
      { kind: "connector", packageName: PKG, digest: "d-active", ageHours: 100 },
      { kind: "connector", packageName: PKG, digest: "d-p1", ageHours: 10 },
      { kind: "connector", packageName: PKG, digest: "d-p2", ageHours: 20 },
    ];
    const { deps } = harness({ disk, rows: [row], journal });
    const report = await reapExtensionStore({ now: NOW_ISO }, deps);
    expect(report.deleted).toEqual([]);
    expect(report.retained.map((d) => d.digest).sort()).toEqual(["d-p1", "d-p2"]);
  });

  it("dryRun reports the would-be delete set and touches nothing", async () => {
    const { row, journal } = liveRow(PKG, "connector", "d-active");
    const { deps, removed } = harness({
      disk: [
        { kind: "connector", packageName: PKG, digest: "d-active", ageHours: 100 },
        { kind: "connector", packageName: PKG, digest: "d-p1", ageHours: 10 },
        { kind: "connector", packageName: PKG, digest: "d-p2", ageHours: 20 },
        { kind: "connector", packageName: PKG, digest: "d-p3", ageHours: 30 },
      ],
      rows: [row],
      journal,
    });
    const report = await reapExtensionStore({ now: NOW_ISO, dryRun: true }, deps);
    expect(report.dryRun).toBe(true);
    expect(report.deleted.map((d) => d.digest)).toEqual(["d-p3"]);
    expect(removed).toEqual([]);
  });

  it("FAIL-CLOSED rows poison their slug: a live row whose activeDigest the journal does NOT confirm protects every digest of that {kind, slug}", async () => {
    const { deps, removed } = harness({
      disk: [
        { kind: "connector", packageName: PKG, digest: "a", ageHours: 100 },
        { kind: "connector", packageName: PKG, digest: "b", ageHours: 200 },
      ],
      rows: [
        { packageName: PKG, organizationId: null, status: "active", kind: "connector", source: { activeDigest: "a" } },
      ],
      journal: { [`${PKG}::`]: "DIFFERENT" }, // row digest contradicts the journal
    });
    const report = await reapExtensionStore({ now: NOW_ISO }, deps);
    expect(removed).toEqual([]);
    expect(report.unsafeSlugs).toEqual([`connector:${PKG}`]);
    expect(report.protectedEntries.map((p) => p.reason)).toEqual(["unsafe-package", "unsafe-package"]);
  });

  it("a live row with NO bindable digest (mid-install placeholder: no activeDigest, no finalized journal) also poisons its slug", async () => {
    const { deps, removed } = harness({
      disk: [{ kind: "skill", packageName: BAR, digest: "x", ageHours: 100 }],
      rows: [{ packageName: BAR, organizationId: null, status: "active", kind: "skill", source: {} }],
      journal: {}, // nothing finalized
    });
    const report = await reapExtensionStore({ now: NOW_ISO }, deps);
    expect(removed).toEqual([]);
    expect(report.unsafeSlugs).toEqual([`skill:${BAR}`]);
  });

  it("a package with NO live row (uninstalled/archived leftovers) is fully reclaimable", async () => {
    const { deps, removed } = harness({
      disk: [
        { kind: "connector", packageName: PKG, digest: "a", ageHours: 100 },
        { kind: "connector", packageName: PKG, digest: "b", ageHours: 200 },
      ],
      rows: [
        { packageName: PKG, organizationId: null, status: "archived", kind: "connector", source: { activeDigest: "a" } },
      ],
    });
    const report = await reapExtensionStore({ now: NOW_ISO }, deps);
    expect(report.deleted.map((d) => d.digest)).toEqual(["a", "b"]);
    expect(removed).toHaveLength(2);
  });

  it("a leased digest is never deleted (snapshot) and a lease racing in AFTER the snapshot is caught by the fresh per-entry probe", async () => {
    const { row, journal } = liveRow(PKG, "connector", "d-active");
    // Snapshot sees no lease; the fresh probe says the eligible digest is leased.
    const { deps, removed } = harness({
      disk: [
        { kind: "connector", packageName: PKG, digest: "d-active", ageHours: 100 },
        { kind: "connector", packageName: PKG, digest: "d-p1", ageHours: 10 },
        { kind: "connector", packageName: PKG, digest: "d-p2", ageHours: 20 },
        { kind: "connector", packageName: PKG, digest: "d-p3", ageHours: 30 },
      ],
      rows: [row],
      journal,
      overrides: {
        listLeasedDigests: async () => new Set<string>(), // stale snapshot
        hasLiveLease: async (pkg, digest) => digest === "d-p3", // raced lease
      },
    });
    const report = await reapExtensionStore({ now: NOW_ISO }, deps);
    expect(removed).toEqual([]);
    expect(report.skippedForRacedLease.map((d) => d.digest)).toEqual(["d-p3"]);
    expect(report.deleted).toEqual([]);
  });

  it("an active binding racing in AFTER the snapshot (rollback re-point) is caught by the fresh per-entry row re-read", async () => {
    const { row } = liveRow(PKG, "connector", "d-active");
    // Planning sees the OLD state (row d-active, journal d-active); the
    // per-entry re-read sees a rollback that re-pointed the active digest AT
    // the reap candidate d-p3 (row + journal both agree on d-p3 by then).
    let journalReads = 0;
    const { deps, removed } = harness({
      disk: [
        { kind: "connector", packageName: PKG, digest: "d-active", ageHours: 100 },
        { kind: "connector", packageName: PKG, digest: "d-p1", ageHours: 10 },
        { kind: "connector", packageName: PKG, digest: "d-p2", ageHours: 20 },
        { kind: "connector", packageName: PKG, digest: "d-p3", ageHours: 30 },
      ],
      rows: [row],
      overrides: {
        readJournalDigest: async () => {
          journalReads += 1;
          return journalReads === 1 ? "d-active" : "d-p3"; // planning, then re-check
        },
        listRowsForPackage: async () => [
          {
            packageName: PKG,
            organizationId: null,
            status: "active",
            kind: "connector",
            source: { activeDigest: "d-p3" },
          },
        ],
      },
    });
    const report = await reapExtensionStore({ now: NOW_ISO }, deps);
    expect(removed).toEqual([]);
    expect(report.skippedForRacedActive.map((d) => d.digest)).toEqual(["d-p3"]);
  });

  it("an unreadable per-entry row re-read fails closed (skip, not delete)", async () => {
    const { row, journal } = liveRow(PKG, "connector", "d-active");
    const { deps, removed } = harness({
      disk: [
        { kind: "connector", packageName: PKG, digest: "d-active", ageHours: 100 },
        { kind: "connector", packageName: PKG, digest: "d-p1", ageHours: 10 },
        { kind: "connector", packageName: PKG, digest: "d-p2", ageHours: 20 },
        { kind: "connector", packageName: PKG, digest: "d-p3", ageHours: 30 },
      ],
      rows: [row],
      journal,
      overrides: {
        listRowsForPackage: async () => {
          throw new Error("db down");
        },
      },
    });
    const report = await reapExtensionStore({ now: NOW_ISO }, deps);
    expect(removed).toEqual([]);
    expect(report.skippedForRacedActive.map((d) => d.digest)).toEqual(["d-p3"]);
  });

  it("a planning-input read failure ABORTS the run (throws) — never 'empty set = everything eligible'", async () => {
    const { deps } = harness({
      disk: [{ kind: "connector", packageName: PKG, digest: "a", ageHours: 100 }],
      overrides: {
        listRows: async () => {
          throw new Error("canonical store unreachable");
        },
      },
    });
    await expect(reapExtensionStore({ now: NOW_ISO }, deps)).rejects.toThrow(
      "canonical store unreachable",
    );
  });

  it("a missing sidecar (unknown age) is reported protected, never deleted", async () => {
    const { deps, removed } = harness({
      disk: [{ kind: "connector", packageName: PKG, digest: "undated", ageHours: null }],
    });
    const report = await reapExtensionStore({ now: NOW_ISO }, deps);
    expect(removed).toEqual([]);
    expect(report.protectedEntries).toEqual([
      { kind: "connector", packageName: PKG, digest: "undated", reason: "unknown-age" },
    ]);
  });

  it("a failed rm is collected in failedDeletes (non-fatal; the rest of the sweep continues)", async () => {
    const { deps } = harness({
      disk: [
        { kind: "connector", packageName: PKG, digest: "a", ageHours: 100 },
        { kind: "connector", packageName: PKG, digest: "b", ageHours: 200 },
      ],
      overrides: {
        rmDigestDir: async (storeDir) => {
          if (storeDir.endsWith("/a")) throw new Error("EACCES");
        },
      },
    });
    const report = await reapExtensionStore({ now: NOW_ISO }, deps);
    expect(report.failedDeletes).toEqual([
      { kind: "connector", packageName: PKG, digest: "a", error: "EACCES" },
    ]);
    expect(report.deleted.map((d) => d.digest)).toEqual(["b"]);
  });

  it("an ARCHIVED row ordered BEFORE a live row never shadows the live row's active binding (no row de-dup)", async () => {
    const { deps, removed } = harness({
      disk: [
        { kind: "connector", packageName: PKG, digest: "d-live", ageHours: 100 },
        { kind: "connector", packageName: PKG, digest: "d-old", ageHours: 200 },
      ],
      rows: [
        // Same (package, org) scope: archived first, live second — reads have
        // no ordering guarantee, so the derivation must process BOTH.
        { packageName: PKG, organizationId: null, status: "archived", kind: "connector", source: { activeDigest: "d-old" } },
        { packageName: PKG, organizationId: null, status: "active", kind: "connector", source: { activeDigest: "d-live" } },
      ],
      journal: { [`${PKG}::`]: "d-live" },
    });
    const report = await reapExtensionStore({ now: NOW_ISO, retainPerSlug: 0 }, deps);
    expect(report.protectedEntries.map((p) => [p.digest, p.reason])).toEqual([["d-live", "active"]]);
    expect(report.deleted.map((d) => d.digest)).toEqual(["d-old"]);
    expect(removed).toHaveLength(1);
  });

  it("multiple OWNER rows in one (package, org) scope: both live rows' confirmed digests are unioned into the active set", async () => {
    const { deps, removed } = harness({
      disk: [
        { kind: "connector", packageName: PKG, digest: "d-a", ageHours: 100 },
        { kind: "connector", packageName: PKG, digest: "d-old", ageHours: 200 },
      ],
      rows: [
        // Two live rows, same scope (different owners) — both journal-confirmed.
        { packageName: PKG, organizationId: null, status: "active", kind: "connector", source: { activeDigest: "d-a" } },
        { packageName: PKG, organizationId: null, status: "locked", kind: "connector", source: { activeDigest: "d-a" } },
      ],
      journal: { [`${PKG}::`]: "d-a" },
    });
    const report = await reapExtensionStore({ now: NOW_ISO, retainPerSlug: 0 }, deps);
    expect(report.protectedEntries.map((p) => [p.digest, p.reason])).toEqual([["d-a", "active"]]);
    expect(report.deleted.map((d) => d.digest)).toEqual(["d-old"]);
    expect(removed).toHaveLength(1);
  });

  it("one journal-confirmed live row + one fail-closed live row → the slug is UNSAFE (everything protected)", async () => {
    const { deps, removed } = harness({
      disk: [
        { kind: "connector", packageName: PKG, digest: "d-a", ageHours: 100 },
        { kind: "connector", packageName: PKG, digest: "d-old", ageHours: 200 },
      ],
      rows: [
        { packageName: PKG, organizationId: null, status: "active", kind: "connector", source: { activeDigest: "d-a" } },
        // Second live row (another owner) contradicts the finalized journal.
        { packageName: PKG, organizationId: null, status: "active", kind: "connector", source: { activeDigest: "d-other" } },
      ],
      journal: { [`${PKG}::`]: "d-a" },
    });
    const report = await reapExtensionStore({ now: NOW_ISO, retainPerSlug: 0 }, deps);
    expect(removed).toEqual([]);
    expect(report.unsafeSlugs).toEqual([`connector:${PKG}`]);
    // The confirmed row's digest is still in the active set (protected first);
    // everything else in the slug is unsafe-protected.
    expect(report.protectedEntries.map((p) => [p.digest, p.reason])).toEqual([
      ["d-a", "active"],
      ["d-old", "unsafe-package"],
    ]);
  });

  it("multi-org rows: EVERY live row's confirmed digest is active (multi-digest active set per slug)", async () => {
    const { deps, removed } = harness({
      disk: [
        { kind: "connector", packageName: PKG, digest: "d-global", ageHours: 100 },
        { kind: "connector", packageName: PKG, digest: "d-org", ageHours: 100 },
        { kind: "connector", packageName: PKG, digest: "d-old", ageHours: 100 },
      ],
      rows: [
        { packageName: PKG, organizationId: null, status: "active", kind: "connector", source: { activeDigest: "d-global" } },
        { packageName: PKG, organizationId: "org-1", status: "locked", kind: "connector", source: { activeDigest: "d-org" } },
      ],
      journal: { [`${PKG}::`]: "d-global", [`${PKG}::org-1`]: "d-org" },
      overrides: {},
    });
    const report = await reapExtensionStore({ now: NOW_ISO, retainPerSlug: 0 }, deps);
    expect(report.protectedEntries.map((p) => [p.digest, p.reason]).sort()).toEqual([
      ["d-global", "active"],
      ["d-org", "active"],
    ]);
    expect(report.deleted.map((d) => d.digest)).toEqual(["d-old"]);
    expect(removed).toHaveLength(1);
  });
});
