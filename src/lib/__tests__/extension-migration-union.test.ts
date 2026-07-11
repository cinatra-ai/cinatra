import { describe, it, expect, vi } from "vitest";
import {
  applyMigrationUnionForTrustedRecords,
  compareMigrationUnionVersionAsc,
  type TrustedMigrationRecord,
} from "@/lib/extension-migration-host";

// cinatra#1040 S5 — the CROSS-VERSION migration UNION (DI-unit; no fs, no pg).
// Proves the ordered (semver asc, filename) union across a package's side-by-side
// versions, the PACKAGE-WIDE preflight before any DDL, and the whole-package
// fail-closed refusal on a preflight OR an apply failure. Injected
// preflightOne/applyOne stand in for the real fs/runner.

const PKG = "@cinatra-ai/notes-connector";
const OTHER = "@cinatra-ai/other";

function rec(version: string | null | undefined, storeDir: string): TrustedMigrationRecord {
  return { packageName: PKG, storeDir, version, migrationsDir: "cinatra/migrations" };
}

/** applyOne recorder — returns `applied` derived from the storeDir so order is observable. */
function makeApply(perDir: Record<string, string[]> = {}) {
  const calls: { storeDir: string; version?: string | null }[] = [];
  const applyOne = vi.fn(async (i: { storeDir: string; packageVersion?: string }) => {
    calls.push({ storeDir: i.storeDir, version: i.packageVersion });
    return { applied: perDir[i.storeDir] ?? [] };
  });
  return { applyOne, calls };
}

const okPreflight = vi.fn(async () => null);

describe("compareMigrationUnionVersionAsc", () => {
  it("sorts unversioned/legacy FIRST, then semver ascending (as production sorts version-bearing records)", () => {
    // Production sorts RECORD OBJECTS by `.version`; sorting objects always
    // invokes the comparator (unlike a raw array with a literal `undefined`,
    // which JS's Array.sort special-cases to the end without comparing).
    const sorted = [
      { version: "0.2.0" as string | null | undefined },
      { version: null },
      { version: "0.1.4" },
      { version: "0.10.0" },
      { version: undefined },
      { version: "0.1.10" },
    ]
      .sort((a, b) => compareMigrationUnionVersionAsc(a.version, b.version))
      .map((r) => r.version);
    // null/undefined float to the front; the rest are true semver asc.
    expect(sorted.slice(2)).toEqual(["0.1.4", "0.1.10", "0.2.0", "0.10.0"]);
    expect(sorted.slice(0, 2).every((v) => v == null)).toBe(true);
  });

  it("breaks a semver-equal build-metadata tie deterministically by raw string", () => {
    expect(compareMigrationUnionVersionAsc("1.0.0+a", "1.0.0+b")).toBeLessThan(0);
    expect(compareMigrationUnionVersionAsc("1.0.0+b", "1.0.0+a")).toBeGreaterThan(0);
    expect(compareMigrationUnionVersionAsc("1.0.0", "1.0.0")).toBe(0);
  });
});

describe("applyMigrationUnionForTrustedRecords", () => {
  it("applies a package's versions in semver-ASC order and aggregates the applied ledger names", async () => {
    const { applyOne, calls } = makeApply({
      "/store/0.1.4": ["ext__0001_a"],
      "/store/0.2.0": ["ext__0002_b", "ext__0003_c"],
    });
    // Supplied OUT of order — the union must reorder low→high.
    const out = await applyMigrationUnionForTrustedRecords(
      [rec("0.2.0", "/store/0.2.0"), rec("0.1.4", "/store/0.1.4")],
      { applyOne, preflightOne: okPreflight as never },
    );
    expect(calls.map((c) => c.storeDir)).toEqual(["/store/0.1.4", "/store/0.2.0"]);
    expect(out.refused).toEqual([]);
    expect(out.applied).toHaveLength(1);
    expect(out.applied[0]).toMatchObject({
      packageName: PKG,
      result: { applied: ["ext__0001_a", "ext__0002_b", "ext__0003_c"] },
    });
  });

  it("PACKAGE-WIDE preflight before ANY DDL: one version's preflight failure refuses the WHOLE package with zero applyOne calls", async () => {
    const { applyOne, calls } = makeApply();
    const preflightOne = vi.fn(async (i: { storeDir: string }) => {
      if (i.storeDir === "/store/0.2.0") throw new Error("bad migrationsDir containment");
      return null;
    });
    const out = await applyMigrationUnionForTrustedRecords(
      [rec("0.1.4", "/store/0.1.4"), rec("0.2.0", "/store/0.2.0")],
      { applyOne, preflightOne: preflightOne as never },
    );
    expect(calls).toEqual([]); // NO DDL applied for any version
    expect(out.applied).toEqual([]);
    expect(out.refused).toHaveLength(1);
    expect(out.refused[0].packageName).toBe(PKG);
    expect(out.refused[0].error).toContain("preflight failed");
  });

  it("STOPS the group on the first apply failure and refuses the whole package (name-keyed)", async () => {
    const applyOne = vi.fn(async (i: { storeDir: string }) => {
      if (i.storeDir === "/store/0.1.4") return { applied: ["ext__0001_a"] };
      throw new Error("DDL failed on 0.2.0");
    });
    const out = await applyMigrationUnionForTrustedRecords(
      [rec("0.1.4", "/store/0.1.4"), rec("0.2.0", "/store/0.2.0")],
      { applyOne, preflightOne: okPreflight as never },
    );
    expect(out.applied).toEqual([]);
    expect(out.refused).toHaveLength(1);
    expect(out.refused[0]).toMatchObject({ packageName: PKG });
    expect(out.refused[0].error).toContain("0.2.0");
  });

  it("skips records that declare no migrations, and keeps distinct packages independent", async () => {
    const { applyOne, calls } = makeApply({ "/store/pkg": ["ext__0001"] });
    const out = await applyMigrationUnionForTrustedRecords(
      [
        { packageName: PKG, storeDir: "/store/pkg", version: "1.0.0", migrationsDir: "cinatra/migrations" },
        { packageName: OTHER, storeDir: "/store/other", version: "1.0.0" }, // no migrationsDir → skipped
      ],
      { applyOne, preflightOne: okPreflight as never },
    );
    expect(calls.map((c) => c.storeDir)).toEqual(["/store/pkg"]);
    expect(out.applied.map((a) => a.packageName)).toEqual([PKG]);
    expect(out.refused).toEqual([]);
  });
});
