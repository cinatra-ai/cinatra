/**
 * Pure catalog snapshot read (cinatra#1364, lifecycle A4) — PURITY arm.
 *
 * Loads the REAL skills-store module (so the snapshot flows through the same
 * canonical normalizers the legacy read path applies) with only the host DB
 * layer faked, and pins:
 *   - the snapshot returns the normalized persisted catalog (level/scope
 *     derivation included) and drops malformed rows;
 *   - the snapshot performs NO side effects: exactly one catalog read per
 *     call, no catalog write, no metadata write (the legacy path's engine
 *     would rewrite the DB and enqueue prefill jobs).
 *
 * The rebuild/lease/single-flight/fencing arm lives in
 * catalog-rebuild-lock.test.ts (there the engine is a controllable spy; a
 * `vi.mock(..., importOriginal)` wrapper around skills-store is deliberately
 * avoided — it instantiates a second, unmocked module graph).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  meta: new Map<string, string>(),
  rows: { skillPackages: [] as Array<Record<string, unknown>>, skills: [] as Array<Record<string, unknown>> },
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/database", () => ({
  readSkillCatalogFromDatabase: vi.fn(() => state.rows),
  replaceSkillCatalogInDatabase: vi.fn(),
  readMetadataValueFromDatabase: vi.fn(<T,>(_key: string, fallback: T): T => fallback),
  writeMetadataValueToDatabase: vi.fn((key: string, value: unknown) => {
    state.meta.set(key, JSON.stringify(value));
  }),
  readRawMetadataStringFromDatabase: vi.fn((key: string) => state.meta.get(key) ?? null),
  compareAndSwapMetadataValueFromDatabase: vi.fn(() => true),
}));

import { readSkillsCatalogSnapshot } from "../skill-packages";
import { readSkillCatalogFromDatabase, replaceSkillCatalogInDatabase, writeMetadataValueToDatabase } from "@/lib/database";

const PKG = {
  id: "pkg-a",
  packageId: "pkg-a",
  slug: "pkg-a",
  name: "Package A",
  description: "a package",
};
const SKILL = {
  id: "pkg-a:one",
  slug: "one",
  name: "One",
  description: "a skill",
  content: "# one",
  packageId: "pkg-a",
  packageName: "Package A",
  packageSlug: "pkg-a",
  isCustomSkill: true,
  ownerUserId: "user-1",
  level: "personal",
};

beforeEach(() => {
  vi.clearAllMocks();
  state.meta.clear();
  state.rows = { skillPackages: [PKG], skills: [SKILL] };
});

describe("readSkillsCatalogSnapshot — purity (real normalizers)", () => {
  it("returns the normalized persisted catalog", async () => {
    const snapshot = await readSkillsCatalogSnapshot();
    expect(snapshot.skillPackages.map((p) => p.id)).toEqual(["pkg-a"]);
    expect(snapshot.skills.map((s) => s.id)).toEqual(["pkg-a:one"]);
    // Canonical normalization applied: personal rows derive scope from owner.
    expect(snapshot.skills[0]!.level).toBe("personal");
    expect(snapshot.skills[0]!.scope).toBe("user-1");
    expect(snapshot.skills[0]!.isCustomSkill).toBe(true);
  });

  it("drops malformed rows instead of surfacing garbage", async () => {
    state.rows = {
      skillPackages: [PKG, { id: 42 } as unknown as Record<string, unknown>],
      skills: [SKILL, { name: "no-id" }],
    };
    const snapshot = await readSkillsCatalogSnapshot();
    expect(snapshot.skillPackages).toHaveLength(1);
    expect(snapshot.skills).toHaveLength(1);
  });

  it("performs exactly ONE catalog read and NO writes (legacy engine would rewrite + enqueue)", async () => {
    await readSkillsCatalogSnapshot();
    expect(readSkillCatalogFromDatabase).toHaveBeenCalledTimes(1);
    expect(replaceSkillCatalogInDatabase).not.toHaveBeenCalled();
    expect(writeMetadataValueToDatabase).not.toHaveBeenCalled();
    expect(state.meta.size).toBe(0);
  });
});
