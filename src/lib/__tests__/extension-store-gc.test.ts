import { describe, it, expect } from "vitest";
import {
  digestKey,
  planStoreGc,
  selectGcEligibleDigests,
  storeGcDigestKey,
  storeGcSlugKey,
  type OnDiskDigest,
  type StoreGcCandidate,
} from "@/lib/extension-store-gc";

const PKG = "@cinatra-ai/foo-connector";
const BAR = "@cinatra-ai/bar-connector";

function onDisk(...entries: [string, string][]): OnDiskDigest[] {
  return entries.map(([packageName, digest]) => ({ packageName, digest }));
}

describe("digestKey", () => {
  it("joins package + digest with @", () => {
    expect(digestKey(PKG, "abc")).toBe(`${PKG}@abc`);
  });
});

describe("selectGcEligibleDigests", () => {
  it("returns [] for empty input (pure + total)", () => {
    expect(
      selectGcEligibleDigests({
        onDisk: [],
        activeDigests: new Set(),
        leasedDigests: new Set(),
      }),
    ).toEqual([]);
  });

  it("deletes orphans (neither active nor leased)", () => {
    const eligible = selectGcEligibleDigests({
      onDisk: onDisk([PKG, "old"], [PKG, "older"]),
      activeDigests: new Set(),
      leasedDigests: new Set(),
    });
    expect(eligible).toEqual(onDisk([PKG, "old"], [PKG, "older"]));
  });

  it("protects the active digest", () => {
    const eligible = selectGcEligibleDigests({
      onDisk: onDisk([PKG, "new"], [PKG, "old"]),
      activeDigests: new Set([digestKey(PKG, "new")]),
      leasedDigests: new Set(),
    });
    expect(eligible).toEqual(onDisk([PKG, "old"]));
  });

  it("protects a leased digest (in-flight run)", () => {
    const eligible = selectGcEligibleDigests({
      onDisk: onDisk([PKG, "new"], [PKG, "old"]),
      activeDigests: new Set([digestKey(PKG, "new")]),
      leasedDigests: new Set([digestKey(PKG, "old")]),
    });
    expect(eligible).toEqual([]);
  });

  it("excludes a digest that is both active AND leased", () => {
    const eligible = selectGcEligibleDigests({
      onDisk: onDisk([PKG, "x"]),
      activeDigests: new Set([digestKey(PKG, "x")]),
      leasedDigests: new Set([digestKey(PKG, "x")]),
    });
    expect(eligible).toEqual([]);
  });

  it("keys by pkg@digest so a shared digest across packages does not alias", () => {
    // BAR's "shared" is active; PKG's "shared" is an orphan and must be deletable.
    const eligible = selectGcEligibleDigests({
      onDisk: onDisk([PKG, "shared"], [BAR, "shared"]),
      activeDigests: new Set([digestKey(BAR, "shared")]),
      leasedDigests: new Set(),
    });
    expect(eligible).toEqual(onDisk([PKG, "shared"]));
  });

  it("preserves onDisk order in the result", () => {
    const eligible = selectGcEligibleDigests({
      onDisk: onDisk([PKG, "a"], [PKG, "b"], [PKG, "c"]),
      activeDigests: new Set([digestKey(PKG, "b")]),
      leasedDigests: new Set(),
    });
    expect(eligible).toEqual(onDisk([PKG, "a"], [PKG, "c"]));
  });

  it("does not mutate the input onDisk array", () => {
    const input = onDisk([PKG, "a"], [PKG, "b"]);
    const snapshot = JSON.parse(JSON.stringify(input));
    selectGcEligibleDigests({
      onDisk: input,
      activeDigests: new Set([digestKey(PKG, "a")]),
      leasedDigests: new Set(),
    });
    expect(input).toEqual(snapshot);
  });
});

// ===========================================================================
// planStoreGc — the V2 retention-aware planner (cinatra#796)
// ===========================================================================

const NOW = Date.parse("2026-07-03T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const MIN_AGE = HOUR;

/** A candidate `ageHours` hours old (null = unknown age). */
function cand(
  kind: string,
  packageName: string,
  digest: string,
  ageHours: number | null,
): StoreGcCandidate {
  return {
    kind,
    packageName,
    digest,
    materializedAtMs: ageHours === null ? null : NOW - ageHours * HOUR,
  };
}

function plan(input: {
  onDisk: StoreGcCandidate[];
  activeKeys?: string[];
  leasedPkgDigests?: string[];
  unsafeSlugs?: string[];
  retainPerSlug?: number;
  minAgeMs?: number;
}) {
  return planStoreGc({
    onDisk: input.onDisk,
    activeKeys: new Set(input.activeKeys ?? []),
    leasedPkgDigests: new Set(input.leasedPkgDigests ?? []),
    unsafeSlugs: new Set(input.unsafeSlugs ?? []),
    ...(input.retainPerSlug !== undefined ? { retainPerSlug: input.retainPerSlug } : {}),
    nowMs: NOW,
    minAgeMs: input.minAgeMs ?? MIN_AGE,
  });
}

function digests(entries: StoreGcCandidate[]): string[] {
  return entries.map((e) => e.digest);
}

describe("storeGcDigestKey / storeGcSlugKey", () => {
  it("kind-prefixes the pkg@digest key (scoped names keep their @)", () => {
    expect(storeGcDigestKey("connector", PKG, "abc")).toBe(`connector:${PKG}@abc`);
    expect(storeGcSlugKey("connector", PKG)).toBe(`connector:${PKG}`);
  });
});

describe("planStoreGc — retention-aware V2 planner", () => {
  it("empty input → empty plan (pure + total)", () => {
    const p = plan({ onDisk: [] });
    expect(p.eligible).toEqual([]);
    expect(p.retained).toEqual([]);
    expect(p.protectedEntries).toEqual([]);
  });

  it("keeps the active digest + the 2 NEWEST priors per slug; deletes the older rest (current + 2)", () => {
    const p = plan({
      onDisk: [
        cand("connector", PKG, "d-active", 100),
        cand("connector", PKG, "d-newest", 10),
        cand("connector", PKG, "d-newer", 20),
        cand("connector", PKG, "d-old", 30),
        cand("connector", PKG, "d-oldest", 40),
      ],
      activeKeys: [storeGcDigestKey("connector", PKG, "d-active")],
    });
    expect(p.protectedEntries.map((x) => [x.entry.digest, x.reason])).toEqual([
      ["d-active", "active"],
    ]);
    expect(digests(p.retained).sort()).toEqual(["d-newer", "d-newest"]);
    expect(digests(p.eligible)).toEqual(["d-old", "d-oldest"]);
  });

  it("a slug with NO active digest (no live row — uninstalled leftovers) retains nothing", () => {
    const p = plan({
      onDisk: [cand("connector", PKG, "a", 10), cand("connector", PKG, "b", 20)],
    });
    expect(p.retained).toEqual([]);
    expect(digests(p.eligible)).toEqual(["a", "b"]);
  });

  it("kind-keyed ACTIVE set never aliases across kinds (same pkg@digest under two kinds)", () => {
    const p = plan({
      onDisk: [
        cand("connector", PKG, "shared", 100),
        cand("workflow", PKG, "shared", 100),
      ],
      activeKeys: [storeGcDigestKey("connector", PKG, "shared")],
      retainPerSlug: 0,
    });
    // connector's dir is active-protected; workflow's SAME pkg@digest has no
    // live row for its kind → eligible.
    expect(p.protectedEntries.map((x) => [x.entry.kind, x.reason])).toEqual([
      ["connector", "active"],
    ]);
    expect(p.eligible.map((e) => e.kind)).toEqual(["workflow"]);
  });

  it("a LEASE (kind-less pkg@digest) conservatively protects the digest under EVERY kind", () => {
    const p = plan({
      onDisk: [
        cand("connector", PKG, "leased", 100),
        cand("workflow", PKG, "leased", 100),
      ],
      leasedPkgDigests: [digestKey(PKG, "leased")],
    });
    expect(p.eligible).toEqual([]);
    expect(p.protectedEntries.map((x) => x.reason)).toEqual(["leased", "leased"]);
  });

  it("an UNSAFE slug (fail-closed row binding) protects every digest of that {kind, slug}", () => {
    const p = plan({
      onDisk: [
        cand("connector", PKG, "a", 100),
        cand("connector", PKG, "b", 200),
        cand("connector", BAR, "c", 100),
      ],
      unsafeSlugs: [storeGcSlugKey("connector", PKG)],
    });
    expect(p.protectedEntries.map((x) => [x.entry.digest, x.reason])).toEqual([
      ["a", "unsafe-package"],
      ["b", "unsafe-package"],
    ]);
    expect(digests(p.eligible)).toEqual(["c"]);
  });

  it("unknown materializedAt (missing/garbage sidecar) is NEVER deleted", () => {
    const p = plan({
      onDisk: [cand("connector", PKG, "undated", null), cand("connector", PKG, "dated", 100)],
    });
    expect(p.protectedEntries.map((x) => [x.entry.digest, x.reason])).toEqual([
      ["undated", "unknown-age"],
    ]);
    expect(digests(p.eligible)).toEqual(["dated"]);
  });

  it("a digest younger than minAgeMs is protected (in-flight materialize guard)", () => {
    const p = plan({
      onDisk: [cand("connector", PKG, "young", 0.5), cand("connector", PKG, "aged", 100)],
      minAgeMs: MIN_AGE,
    });
    expect(p.protectedEntries.map((x) => [x.entry.digest, x.reason])).toEqual([
      ["young", "min-age"],
    ]);
    expect(digests(p.eligible)).toEqual(["aged"]);
  });

  it("retention windows are independent per {kind, slug}", () => {
    const p = plan({
      onDisk: [
        cand("connector", PKG, "p-active", 100),
        cand("connector", PKG, "p-prior", 10),
        cand("skill", BAR, "b-active", 100),
        cand("skill", BAR, "b-prior1", 10),
        cand("skill", BAR, "b-prior2", 20),
        cand("skill", BAR, "b-prior3", 30),
      ],
      activeKeys: [
        storeGcDigestKey("connector", PKG, "p-active"),
        storeGcDigestKey("skill", BAR, "b-active"),
      ],
    });
    expect(digests(p.retained).sort()).toEqual(["b-prior1", "b-prior2", "p-prior"]);
    expect(digests(p.eligible)).toEqual(["b-prior3"]);
  });

  it("preserves onDisk order in eligible and does not mutate the input", () => {
    const input = [
      cand("connector", PKG, "z", 50),
      cand("connector", PKG, "a", 40),
      cand("connector", PKG, "m", 30),
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    const p = plan({ onDisk: input, retainPerSlug: 0 });
    expect(digests(p.eligible)).toEqual(["z", "a", "m"]);
    expect(input).toEqual(snapshot);
  });

  it("retainPerSlug: 0 with an active digest deletes every datable non-active prior", () => {
    const p = plan({
      onDisk: [cand("connector", PKG, "active", 100), cand("connector", PKG, "prior", 50)],
      activeKeys: [storeGcDigestKey("connector", PKG, "active")],
      retainPerSlug: 0,
    });
    expect(p.retained).toEqual([]);
    expect(digests(p.eligible)).toEqual(["prior"]);
  });
});
