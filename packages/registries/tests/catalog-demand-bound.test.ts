// cinatra#2539 (residual) — the packument fan-out must be bounded by DEMAND,
// not by registry size.
//
// The wall-clock budget in catalog-hydration-budget.test.ts bounds a PAGE
// RENDER, but it is lossy: it turns a slow packument into a dropped row. That
// is why `extensions_search` — which must never silently omit a matching
// package — could not opt into it and stayed unbounded, reading one full
// packument for EVERY package in the registry to return `limit` rows.
//
// The bound under test here is NOT lossy. The answer is
// `visible.slice(offset, offset + limit)` over the SORTED candidate list, so
// only the first `offset + limit` VISIBLE packages can ever appear in it.
// Hydrating in sorted chunks and stopping once that many exist must yield the
// IDENTICAL answer for strictly less work.
//
// Every test below pins BOTH halves: the answer is unchanged, AND the number of
// packument reads is bounded. Asserting only the read count would let a
// regression "optimize" by dropping rows.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("pacote", () => ({ packument: vi.fn() }));

import * as pacote from "pacote";
import { listExtensionPackages } from "../src/verdaccio/client";
import type { VerdaccioConfig } from "../src/types";

const CONFIG: VerdaccioConfig = {
  registryUrl: "https://registry.example.test",
  packageScope: "@acme",
  token: "tok",
  uiUrl: null,
};

type Visibility = "public" | "private";

/** Package `i` of `size`, named so that alphabetical order === index order. */
const nameAt = (i: number) => `@acme/pkg-${String(i).padStart(4, "0")}`;

interface Registry {
  /** Packages the registry enumerates, in index order. */
  names: string[];
  /** Every package name whose packument was actually READ. */
  read: string[];
}

/**
 * Stand up a fake registry of `size` packages.
 *
 * `visibilityAt` decides each package's `cinatra.origin`; `failAt` makes a
 * package's packument reject (the pre-existing per-package failure mode) and
 * `hangAt` makes it never settle (the slow-registry mode the budget exists for).
 */
function makeRegistry(
  size: number,
  opts: {
    visibilityAt?: (i: number) => Visibility;
    scopeAt?: (i: number) => string;
    failAt?: (i: number) => boolean;
    hangAt?: (i: number) => boolean;
  } = {},
): Registry {
  const names = Array.from({ length: size }, (_, i) => nameAt(i));
  const registry: Registry = { names, read: [] };

  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(Object.fromEntries(names.map((n) => [n, {}]))), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );

  vi.mocked(pacote.packument).mockImplementation(((spec: string) => {
    const i = names.indexOf(spec);
    registry.read.push(spec);
    if (opts.hangAt?.(i)) return new Promise(() => {});
    if (opts.failAt?.(i)) return Promise.reject(new Error(`registry read failed for ${spec}`));
    return Promise.resolve({
      "dist-tags": { latest: "1.0.0" },
      versions: {
        "1.0.0": {
          name: spec,
          title: `Title ${spec}`,
          description: "desc",
          cinatra: {
            kind: "skill",
            origin: {
              visibility: opts.visibilityAt?.(i) ?? "public",
              scope: opts.scopeAt?.(i) ?? "@acme",
            },
          },
        },
      },
    });
  }) as never);

  return registry;
}

// Braced bodies on purpose: `mockReset()` RETURNS the mock, and vitest treats a
// function returned from a hook as that hook's teardown — so the concise-arrow
// form would call the mock again after the test, with whatever implementation
// the test installed (including one that never settles).
beforeEach(() => {
  vi.mocked(pacote.packument).mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listExtensionPackages: demand-bounded packument fan-out (cinatra#2539)", () => {
  it("reads packuments proportional to `limit`, not to registry size", async () => {
    const registry = makeRegistry(200);

    const out = await listExtensionPackages(
      { limit: 20, allowedScopes: undefined, viewerScope: "@acme" },
      CONFIG,
    );

    // The answer is exactly the first 20 packages in sorted order — the same
    // answer the unbounded fan-out produced.
    expect(out.map((p) => p.packageName)).toEqual(
      Array.from({ length: 20 }, (_, i) => nameAt(i)),
    );
    // And it cost 20 packument reads, not 200. This is the residual defect:
    // before the bound, this number equalled the registry size.
    expect(registry.read).toHaveLength(20);
  });

  it("scales with the registry only through the answer — 10x the packages, same reads", async () => {
    const small = makeRegistry(50);
    const a = await listExtensionPackages({ limit: 20, viewerScope: "@acme" }, CONFIG);
    const smallReads = small.read.length;

    vi.mocked(pacote.packument).mockReset();
    const big = makeRegistry(500);
    const b = await listExtensionPackages({ limit: 20, viewerScope: "@acme" }, CONFIG);

    expect(a.map((p) => p.packageName)).toEqual(b.map((p) => p.packageName));
    expect(smallReads).toBe(20);
    expect(big.read).toHaveLength(20);
  });

  it("honours `offset`: hydrates offset+limit and returns the same slice as a full read", async () => {
    const registry = makeRegistry(300);

    const out = await listExtensionPackages(
      { limit: 5, offset: 10, viewerScope: "@acme" },
      CONFIG,
    );

    expect(out.map((p) => p.packageName)).toEqual(
      Array.from({ length: 5 }, (_, i) => nameAt(10 + i)),
    );
    // offset+limit = 15, rounded up to the first-chunk floor (16).
    expect(registry.read.length).toBeGreaterThanOrEqual(15);
    expect(registry.read.length).toBeLessThan(300);
  });

  it("reads in SORTED order — the bound never reorders or skips candidates", async () => {
    const registry = makeRegistry(100);
    await listExtensionPackages({ limit: 20, viewerScope: "@acme" }, CONFIG);
    expect(registry.read).toEqual(Array.from({ length: 20 }, (_, i) => nameAt(i)));
  });

  it("keeps walking past packages this viewer cannot see, and still returns `limit` visible rows", async () => {
    // The correctness case the lossy bounds could not serve: the first 60
    // alphabetical packages are ANOTHER vendor's private packages. A bound that
    // stopped at `limit` CANDIDATES would return zero rows. The bound must
    // count VISIBLE packages.
    const registry = makeRegistry(300, {
      visibilityAt: (i) => (i < 60 ? "private" : "public"),
      scopeAt: (i) => (i < 60 ? "@other" : "@acme"),
    });

    const out = await listExtensionPackages(
      { limit: 20, viewerScope: "@acme" },
      CONFIG,
    );

    expect(out.map((p) => p.packageName)).toEqual(
      Array.from({ length: 20 }, (_, i) => nameAt(60 + i)),
    );
    // It had to read past the invisible prefix, but still nowhere near the
    // whole 300-package registry.
    expect(registry.read.length).toBeGreaterThanOrEqual(80);
    expect(registry.read.length).toBeLessThan(300);
  });

  it("does not let a failed packument shrink the answer below `limit`", async () => {
    // A per-package failure has always dropped that package. With demand
    // bounding, dropping one inside the first chunk must pull the NEXT
    // candidate in — not return 19 rows when 200 packages are available.
    const registry = makeRegistry(200, { failAt: (i) => i === 3 });

    const out = await listExtensionPackages({ limit: 20, viewerScope: "@acme" }, CONFIG);

    expect(out).toHaveLength(20);
    expect(out.map((p) => p.packageName)).not.toContain(nameAt(3));
    expect(out.map((p) => p.packageName)).toContain(nameAt(20));
    expect(registry.read.length).toBeLessThan(200);
  });

  it("returns everything visible when the registry holds fewer than `limit` packages", async () => {
    const registry = makeRegistry(7);
    const out = await listExtensionPackages({ limit: 20, viewerScope: "@acme" }, CONFIG);
    expect(out).toHaveLength(7);
    expect(registry.read).toHaveLength(7);
  });

  it("still hydrates the whole registry for a deliberate full sweep (limit 10_000)", async () => {
    // marketplace-sync asks for every package name. Demand bounding must not
    // silently truncate that: the demand IS the whole registry.
    const registry = makeRegistry(120);
    const out = await listExtensionPackages({ limit: 10_000, viewerScope: "@acme" }, CONFIG);
    expect(out).toHaveLength(120);
    expect(registry.read).toHaveLength(120);
  });

  it("drops foreign-private packages from the answer exactly as before", async () => {
    const registry = makeRegistry(40, {
      visibilityAt: (i) => (i % 2 === 0 ? "private" : "public"),
      scopeAt: () => "@other",
    });
    const out = await listExtensionPackages({ limit: 20, viewerScope: "@acme" }, CONFIG);
    // Every even package is @other-private → invisible; the 20 odd ones remain.
    expect(out.map((p) => p.packageName)).toEqual(
      Array.from({ length: 20 }, (_, i) => nameAt(i * 2 + 1)),
    );
    expect(registry.read).toHaveLength(40);
  });

  it("stops chunking once a caller's wall-clock budget is spent", async () => {
    // A budgeted caller (a page render) must not walk chunk after chunk of
    // already-doomed reads after its deadline has passed.
    const registry = makeRegistry(400, { hangAt: () => true });

    const startedAt = Date.now();
    const out = await listExtensionPackages(
      { limit: 20, viewerScope: "@acme", hydrationBudgetMs: 40 },
      CONFIG,
    );
    const elapsed = Date.now() - startedAt;

    expect(out).toEqual([]);
    expect(elapsed).toBeLessThan(2_000);
    // One chunk was attempted; the loop broke instead of grinding through the
    // remaining 380 packages against an expired budget.
    expect(registry.read.length).toBeLessThanOrEqual(64);
  });

  it("an UNBUDGETED caller (extensions_search) is still bounded by demand", async () => {
    // The search tool passes no budget on purpose — a dropped match is worse
    // than a slow answer. That stance must no longer cost a whole-registry read.
    const registry = makeRegistry(500);
    const out = await listExtensionPackages(
      { query: "pkg-", limit: 20, allowedScopes: undefined, viewerScope: "@acme" },
      CONFIG,
    );
    expect(out).toHaveLength(20);
    expect(registry.read).toHaveLength(20);
  });

  it("narrows candidates by query BEFORE hydrating any packument", async () => {
    const registry = makeRegistry(300);
    const out = await listExtensionPackages(
      { query: "pkg-0001", limit: 20, viewerScope: "@acme" },
      CONFIG,
    );
    expect(out.map((p) => p.packageName)).toEqual([nameAt(1)]);
    expect(registry.read).toEqual([nameAt(1)]);
  });
});
