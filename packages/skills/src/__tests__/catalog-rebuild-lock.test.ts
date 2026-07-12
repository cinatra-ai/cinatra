/**
 * Explicit catalog rebuild (cinatra#1364, lifecycle A4) — LOCKING + FENCING arm.
 *
 * skills-store is FULLY mocked here (the rebuild engine is a controllable spy;
 * the normalizers are structural passthroughs adequate for the fixtures — the
 * real-normalizer contract is pinned by catalog-snapshot-pure.test.ts). A
 * `vi.mock(..., importOriginal)` wrapper is deliberately avoided: it loads a
 * second, unmocked module graph and the SUT's dynamic imports then observe a
 * different DB instance.
 *
 * Pins:
 *   - rebuild runs the engine under the cross-process metadata lease
 *     (acquire → engine → completeness fence → release, sentinel round-trip);
 *   - engine failure releases the lease and skips the fence;
 *   - in-process single-flight coalesces concurrent callers onto the running
 *     rebuild plus exactly ONE queued follow-up run;
 *   - a HELD un-expired foreign lease blocks (bounded wait → loud throw,
 *     engine never runs, foreign lease untouched); an EXPIRED lease is stolen;
 *   - FENCING: snapshots taken during a rebuild observe the catalog fully-old
 *     or fully-new, never a mixed/partial state (the engine mock swaps the
 *     persisted state in ONE atomic assignment, mirroring the real engine's
 *     single-transaction replace + generation-token bump — the transactional
 *     arm of the fence is pinned by src/lib/__tests__/
 *     skill-catalog-generation-fence.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  meta: new Map<string, string>(),
  rows: { skillPackages: [] as Array<Record<string, unknown>>, skills: [] as Array<Record<string, unknown>> },
}));
const engineMock = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));

vi.mock("@/lib/database", () => ({
  readSkillCatalogFromDatabase: vi.fn(() => state.rows),
  replaceSkillCatalogInDatabase: vi.fn(),
  readMetadataValueFromDatabase: vi.fn(<T,>(key: string, fallback: T): T => {
    const raw = state.meta.get(key);
    if (raw === undefined) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }),
  writeMetadataValueToDatabase: vi.fn((key: string, value: unknown) => {
    state.meta.set(key, JSON.stringify(value));
  }),
  writeMetadataValueIfAbsentToDatabase: vi.fn((key: string, value: unknown) => {
    if (!state.meta.has(key)) state.meta.set(key, JSON.stringify(value));
  }),
  // Faithful in-memory model of the statement-atomic guarded fence upsert:
  // write ONLY when the guard row's JSON `token` equals guardToken.
  writeMetadataValueIfGuardTokenHeldToDatabase: vi.fn(
    (writeKey: string, value: unknown, guardKey: string, guardToken: string) => {
      const raw = state.meta.get(guardKey);
      if (raw === undefined) return false;
      try {
        if ((JSON.parse(raw) as { token?: unknown })?.token !== guardToken) return false;
      } catch {
        return false;
      }
      state.meta.set(writeKey, JSON.stringify(value));
      return true;
    },
  ),
  readRawMetadataStringFromDatabase: vi.fn((key: string) => state.meta.get(key) ?? null),
  compareAndSwapMetadataValueFromDatabase: vi.fn(
    (key: string, value: unknown, expectedRaw: string) => {
      if (state.meta.get(key) !== expectedRaw) return false;
      state.meta.set(key, JSON.stringify(value));
      return true;
    },
  ),
}));

// FULL mock — only the members skill-packages' rebuild/snapshot paths touch.
vi.mock("../skills-store", () => ({
  syncInstalledSkillsToDatabase: engineMock,
  // Structural passthrough normalizers: valid fixtures normalize to
  // themselves; rows missing a string id are dropped (null).
  normalizeStoredSkillPackage: (record: Record<string, unknown>) =>
    typeof record.id === "string" ? record : null,
  normalizeStoredSkill: (record: Record<string, unknown>) =>
    typeof record.id === "string" ? record : null,
}));

import {
  readSkillsCatalogSnapshot,
  readSkillsCatalogRebuildState,
  rebuildSkillsCatalog,
  SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY,
  SKILLS_CATALOG_REBUILD_STATE_METADATA_KEY,
} from "../skill-packages";

const PKG_A = { id: "pkg-a", packageId: "pkg-a" };
const SKILL_A = { id: "pkg-a:one", packageId: "pkg-a" };
const PKG_B = { id: "pkg-b", packageId: "pkg-b" };
const SKILLS_B = [
  { id: "pkg-b:one", packageId: "pkg-b" },
  { id: "pkg-b:two", packageId: "pkg-b" },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  vi.clearAllMocks();
  state.meta.clear();
  state.rows = { skillPackages: [PKG_A], skills: [SKILL_A] };
  // Default engine behavior: atomic no-op "rebuild" returning current rows.
  engineMock.mockImplementation(async () => state.rows);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("rebuildSkillsCatalog — explicit locked rebuild", () => {
  it("runs the engine once, records the completeness fence, and releases the lease", async () => {
    const result = await rebuildSkillsCatalog({ reason: "unit-test" });
    expect(engineMock).toHaveBeenCalledTimes(1);
    expect(result).toBe(state.rows);

    // The engine received the catalog-write lease guard, and the guard token
    // is EXACTLY the token the lease row carried while the engine ran.
    const options = engineMock.mock.calls[0]![0] as {
      catalogWriteGuard?: { guardKey: string; guardToken: string };
    };
    expect(options?.catalogWriteGuard?.guardKey).toBe(SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY);
    expect(typeof options?.catalogWriteGuard?.guardToken).toBe("string");

    const fence = await readSkillsCatalogRebuildState();
    expect(fence).not.toBeNull();
    expect(fence!.reason).toBe("unit-test");
    expect(Number.isNaN(Date.parse(fence!.completedAt))).toBe(false);

    // Lease released back to the sentinel.
    const leaseRaw = state.meta.get(SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY);
    expect(leaseRaw).toBeDefined();
    expect(JSON.parse(leaseRaw!)).toEqual({ token: null, expiresAt: null });
  });

  it("reports null fence state before any explicit rebuild completed", async () => {
    expect(await readSkillsCatalogRebuildState()).toBeNull();
  });

  it("releases the lease and skips the fence when the engine throws", async () => {
    engineMock.mockRejectedValueOnce(new Error("scan exploded"));
    await expect(rebuildSkillsCatalog({ reason: "boom" })).rejects.toThrow("scan exploded");
    expect(state.meta.get(SKILLS_CATALOG_REBUILD_STATE_METADATA_KEY)).toBeUndefined();
    expect(JSON.parse(state.meta.get(SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY)!)).toEqual({
      token: null,
      expiresAt: null,
    });
  });

  it("coalesces concurrent callers into the in-flight run plus exactly ONE queued rerun", async () => {
    let releaseEngine!: () => void;
    engineMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseEngine = () => resolve(state.rows);
        }),
    );

    const first = rebuildSkillsCatalog({ reason: "first" });
    await sleep(0); // let the first run acquire the lease + enter the engine
    engineMock.mockImplementation(async () => state.rows); // queued run completes immediately
    const second = rebuildSkillsCatalog({ reason: "second" });
    const third = rebuildSkillsCatalog({ reason: "third" });

    releaseEngine();
    await Promise.all([first, second, third]);

    // first run + ONE queued rerun shared by the second and third callers.
    expect(engineMock).toHaveBeenCalledTimes(2);
  });

  it("waits on a HELD lease and fails loudly at the deadline without running the engine", async () => {
    state.meta.set(
      SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY,
      JSON.stringify({ token: "other-process", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    );
    await expect(
      rebuildSkillsCatalog({ reason: "blocked", leaseWaitMs: 40, leasePollIntervalMs: 10 }),
    ).rejects.toThrow(/rebuild lease wait timed out/);
    expect(engineMock).not.toHaveBeenCalled();
    // The foreign lease is untouched.
    expect(JSON.parse(state.meta.get(SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY)!).token).toBe(
      "other-process",
    );
  });

  it("steals an EXPIRED lease (crashed holder) and proceeds", async () => {
    state.meta.set(
      SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY,
      JSON.stringify({ token: "crashed-holder", expiresAt: new Date(Date.now() - 1_000).toISOString() }),
    );
    await rebuildSkillsCatalog({ reason: "steal" });
    expect(engineMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(state.meta.get(SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY)!)).toEqual({
      token: null,
      expiresAt: null,
    });
  });

  it("bootstraps the lease row with INSERT-IF-ABSENT, never an unconditional write", async () => {
    const db = await import("@/lib/database");
    await rebuildSkillsCatalog({ reason: "bootstrap" });
    // The absent-row seed went through the if-absent primitive; the
    // unconditional writer touched ONLY the completeness-fence key (a delayed
    // bootstrapper must never clobber a lease another process CAS-acquired).
    expect(db.writeMetadataValueIfAbsentToDatabase).toHaveBeenCalledWith(
      SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY,
      expect.anything(),
    );
    const unconditionalKeys = vi
      .mocked(db.writeMetadataValueToDatabase)
      .mock.calls.map(([key]) => key);
    expect(unconditionalKeys).not.toContain(SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY);
  });

  it("throws loudly (never deadlocks) on a re-entrant call from inside the engine", async () => {
    engineMock.mockImplementation(async () => {
      await rebuildSkillsCatalog({ reason: "re-entrant" }); // must throw
      return state.rows;
    });
    await expect(rebuildSkillsCatalog({ reason: "outer" })).rejects.toThrow(
      /called from INSIDE the rebuild engine/,
    );
  });

  it("skips the completeness fence when the lease was stolen mid-run (outlived TTL)", async () => {
    engineMock.mockImplementation(async () => {
      // Simulate another process stealing the lease while the engine runs.
      state.meta.set(
        SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY,
        JSON.stringify({ token: "stealer", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      );
      return state.rows;
    });
    await rebuildSkillsCatalog({ reason: "stolen" });
    // No fence stamp over the stealer's run…
    expect(state.meta.get(SKILLS_CATALOG_REBUILD_STATE_METADATA_KEY)).toBeUndefined();
    // …and the stealer's lease is left untouched by the release.
    expect(JSON.parse(state.meta.get(SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY)!).token).toBe(
      "stealer",
    );
  });

  it("hands the engine a write guard whose token matches the HELD lease row", async () => {
    let tokenInLeaseRowDuringRun: unknown;
    engineMock.mockImplementation(async (options?: { catalogWriteGuard?: { guardToken: string } }) => {
      tokenInLeaseRowDuringRun = JSON.parse(
        state.meta.get(SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY)!,
      ).token;
      expect(options?.catalogWriteGuard?.guardToken).toBe(tokenInLeaseRowDuringRun);
      return state.rows;
    });
    await rebuildSkillsCatalog({ reason: "guard-token" });
    expect(typeof tokenInLeaseRowDuringRun).toBe("string");
  });

  it("resolves with the stealer's persisted catalog when the GUARDED write aborts on a stolen lease", async () => {
    const stolenRows = { skillPackages: [PKG_B], skills: SKILLS_B };
    engineMock.mockImplementation(async () => {
      // The stealer took the lease AND committed its own (fresher) catalog;
      // our engine's guarded write transaction then rolled back — the real
      // guard raises Postgres's `division by zero` (1/count(*) over the
      // no-longer-held lease row).
      state.meta.set(
        SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY,
        JSON.stringify({ token: "stealer", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      );
      state.rows = stolenRows;
      throw new Error("division by zero");
    });

    // NOT a rejection: the caller gets the persisted (stealer's) catalog.
    const result = await rebuildSkillsCatalog({ reason: "steal-abort" });
    expect(result.skillPackages.map((p) => p.id)).toEqual(["pkg-b"]);
    expect(result.skills.map((s) => s.id).sort()).toEqual(["pkg-b:one", "pkg-b:two"]);
    // No fence stamp — the stolen run never completed a write.
    expect(state.meta.get(SKILLS_CATALOG_REBUILD_STATE_METADATA_KEY)).toBeUndefined();
    // The stealer's lease is untouched.
    expect(JSON.parse(state.meta.get(SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY)!).token).toBe(
      "stealer",
    );
  });

  it("rethrows a division-by-zero engine error when the lease is STILL ours (not a steal)", async () => {
    engineMock.mockRejectedValueOnce(new Error("division by zero"));
    await expect(rebuildSkillsCatalog({ reason: "not-a-steal" })).rejects.toThrow(
      "division by zero",
    );
    expect(state.meta.get(SKILLS_CATALOG_REBUILD_STATE_METADATA_KEY)).toBeUndefined();
  });
});

describe("fencing — no consumer observes a partially-rebuilt catalog", () => {
  it("snapshots taken during a rebuild are fully-old or fully-new, never mixed", async () => {
    // Engine mirrors the real transactional replace: ONE atomic swap of the
    // persisted state (rows flip in a single assignment), after a scan delay.
    engineMock.mockImplementation(async () => {
      await sleep(15);
      state.rows = { skillPackages: [PKG_B], skills: SKILLS_B };
      return state.rows;
    });

    const rebuild = rebuildSkillsCatalog({ reason: "fence-test" });

    let sawOld = false;
    let sawNew = false;
    for (let i = 0; i < 20; i++) {
      const snapshot = await readSkillsCatalogSnapshot();
      // Exactly one package per generation; every skill must belong to it.
      expect(snapshot.skillPackages).toHaveLength(1);
      const pkgId = snapshot.skillPackages[0]!.id;
      for (const skill of snapshot.skills) {
        expect(skill.packageId).toBe(pkgId);
      }
      if (pkgId === "pkg-a") {
        expect(snapshot.skills.map((s) => s.id)).toEqual(["pkg-a:one"]);
        sawOld = true;
      } else {
        expect(pkgId).toBe("pkg-b");
        expect(snapshot.skills.map((s) => s.id).sort()).toEqual(["pkg-b:one", "pkg-b:two"]);
        sawNew = true;
      }
      await sleep(2);
    }

    await rebuild;
    // The loop straddled the swap: both generations were observed, each
    // internally consistent (the per-iteration asserts above).
    expect(sawOld).toBe(true);
    expect(sawNew).toBe(true);

    const finalSnapshot = await readSkillsCatalogSnapshot();
    expect(finalSnapshot.skillPackages[0]!.id).toBe("pkg-b");
  });
});
