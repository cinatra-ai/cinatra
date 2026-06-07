import { describe, expect, it } from "vitest";

import {
  extractCinatraDeps,
  extractCinatraManifestDepNames,
  selectExtensionDepsToProbe,
  isRangeSatisfied,
  probeDep,
  checkDependencyOrdering,
  assertDependencyOrdering,
  formatGateFailure,
} from "../extensions-dependency-gate.mjs";

// A fake fetch keyed by package name → { status, body }.
function makeFetch(table) {
  return async (url) => {
    // url ends with @cinatra-ai%2F<name>
    const m = /@cinatra-ai%2F([^/?#]+)/.exec(url);
    const name = m ? `@cinatra-ai/${decodeURIComponent(m[1])}` : url;
    const entry = table[name];
    if (!entry) return { status: 404, ok: false, json: async () => ({}) };
    return {
      status: entry.status ?? 200,
      ok: (entry.status ?? 200) >= 200 && (entry.status ?? 200) < 300,
      json: async () => entry.body ?? {},
    };
  };
}

describe("extractCinatraDeps", () => {
  it("pulls @cinatra-ai/* from dependencies + peerDependencies, dedups, ignores others", () => {
    const deps = extractCinatraDeps({
      dependencies: { "@cinatra-ai/sdk-extensions": "^2.0.0", lodash: "^4" },
      peerDependencies: { "@cinatra-ai/sdk-ui": "*", "@cinatra-ai/sdk-extensions": "^2.0.0" },
    });
    expect(deps.map((d) => d.name).sort()).toEqual(["@cinatra-ai/sdk-extensions", "@cinatra-ai/sdk-ui"]);
    expect(deps.find((d) => d.name === "@cinatra-ai/sdk-ui").field).toBe("peerDependencies");
  });
  it("returns [] for a 0-dep manifest", () => {
    expect(extractCinatraDeps({ dependencies: {}, peerDependencies: {} })).toEqual([]);
    expect(extractCinatraDeps({})).toEqual([]);
  });
});

describe("isRangeSatisfied", () => {
  it("'*' / '' / 'latest' satisfied by any published version", () => {
    expect(isRangeSatisfied("*", ["1.0.0"])).toBe(true);
    expect(isRangeSatisfied("", ["0.1.0"])).toBe(true);
    expect(isRangeSatisfied("latest", ["3.2.1"])).toBe(true);
    expect(isRangeSatisfied("*", [])).toBe(false);
  });
  it("semver range matched against published versions", () => {
    expect(isRangeSatisfied("^2.0.0", ["2.1.0", "1.0.0"])).toBe(true);
    expect(isRangeSatisfied("^2.0.0", ["1.9.0"])).toBe(false);
  });
  it("dist-tag reference satisfied when the tag exists", () => {
    expect(isRangeSatisfied("next", ["1.0.0"], { next: "1.0.0" })).toBe(true);
  });
});

describe("probeDep classification", () => {
  const opts = (table) => ({ registryUrl: "https://registry.cinatra.ai", fetchImpl: makeFetch(table) });

  it("satisfied when a published version matches the range", async () => {
    const r = await probeDep(
      { name: "@cinatra-ai/sdk-extensions", range: "^2.0.0", field: "peerDependencies" },
      opts({ "@cinatra-ai/sdk-extensions": { body: { versions: { "2.1.0": {} } } } }),
    );
    expect(r.state).toBe("satisfied");
  });
  it("missing on 404", async () => {
    const r = await probeDep(
      { name: "@cinatra-ai/nope", range: "*", field: "dependencies" },
      opts({}),
    );
    expect(r.state).toBe("missing");
    expect(r.status).toBe(404);
  });
  it("missing when published but no version satisfies the range", async () => {
    const r = await probeDep(
      { name: "@cinatra-ai/x", range: "^3.0.0", field: "dependencies" },
      opts({ "@cinatra-ai/x": { body: { versions: { "1.0.0": {}, "2.0.0": {} } } } }),
    );
    expect(r.state).toBe("unsatisfied");
  });
  it("UNREADABLE (distinct from missing) on 401", async () => {
    const r = await probeDep(
      { name: "@cinatra-ai/x", range: "*", field: "dependencies" },
      opts({ "@cinatra-ai/x": { status: 401 } }),
    );
    expect(r.state).toBe("unreadable");
    expect(r.status).toBe(401);
  });
  it("UNREADABLE on 403 too", async () => {
    const r = await probeDep(
      { name: "@cinatra-ai/x", range: "*", field: "dependencies" },
      opts({ "@cinatra-ai/x": { status: 403 } }),
    );
    expect(r.state).toBe("unreadable");
  });
  it("error on a network throw (no silent pass)", async () => {
    const r = await probeDep(
      { name: "@cinatra-ai/x", range: "*", field: "dependencies" },
      { registryUrl: "https://registry.cinatra.ai", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } },
    );
    expect(r.state).toBe("error");
    expect(r.detail).toContain("ECONNREFUSED");
  });
});

describe("extractCinatraManifestDepNames + selectExtensionDepsToProbe", () => {
  it("reads cinatra.dependencies in all three shapes", () => {
    expect(extractCinatraManifestDepNames({ cinatra: { dependencies: [{ packageName: "@cinatra-ai/a" }] } })).toEqual([
      "@cinatra-ai/a",
    ]);
    expect(extractCinatraManifestDepNames({ cinatra: { dependencies: ["@cinatra-ai/a", "b"] } }).sort()).toEqual([
      "@cinatra-ai/a",
      "@cinatra-ai/b",
    ]);
    expect(extractCinatraManifestDepNames({ cinatra: { dependencies: { "@cinatra-ai/a": "*" } } })).toEqual([
      "@cinatra-ai/a",
    ]);
    expect(extractCinatraManifestDepNames({})).toEqual([]);
  });
  it("probes only declared edges, skips host-internal, includes manifest-only edges", () => {
    const { toProbe, skippedNonManifestCinatraDeps } = selectExtensionDepsToProbe({
      dependencies: { "@cinatra-ai/nango-connector": "*", "@cinatra-ai/sdk-extensions": "*" },
      cinatra: {
        dependencies: [{ packageName: "@cinatra-ai/nango-connector" }, { packageName: "@cinatra-ai/social-media-connector" }],
      },
    });
    expect(toProbe.map((d) => d.name).sort()).toEqual([
      "@cinatra-ai/nango-connector",
      "@cinatra-ai/social-media-connector",
    ]);
    expect(toProbe.find((d) => d.name === "@cinatra-ai/social-media-connector").field).toBe("cinatra.dependencies");
    expect(skippedNonManifestCinatraDeps).toEqual(["@cinatra-ai/sdk-extensions"]);
  });
});

describe("checkDependencyOrdering + assert (probes canonical cinatra.dependencies edges only)", () => {
  it("ok=true for a 0-dep manifest, no probes", async () => {
    let calls = 0;
    const report = await checkDependencyOrdering({
      manifest: { dependencies: {}, peerDependencies: {} },
      fetchImpl: async () => { calls++; return { status: 200, ok: true, json: async () => ({}) }; },
    });
    expect(report.ok).toBe(true);
    expect(calls).toBe(0);
  });
  it("SKIPS host-internal @cinatra-ai/* peers (not in cinatra.dependencies) — no probes, gate PASSES", async () => {
    let calls = 0;
    const report = await checkDependencyOrdering({
      manifest: {
        peerDependencies: {
          "@cinatra-ai/sdk-extensions": "*",
          "@cinatra-ai/sdk-ui": "*",
          "@cinatra-ai/mcp-client": "*",
        },
        peerDependenciesMeta: {
          "@cinatra-ai/sdk-extensions": { optional: true },
          "@cinatra-ai/sdk-ui": { optional: true },
          "@cinatra-ai/mcp-client": { optional: true },
        },
      },
      registryUrl: "https://registry.cinatra.ai",
      fetchImpl: async () => { calls++; return { status: 404, ok: false, json: async () => ({}) }; },
    });
    expect(report.ok).toBe(true);
    expect(calls).toBe(0);
    expect(report.skippedNonManifestCinatraDeps.sort()).toEqual([
      "@cinatra-ai/mcp-client",
      "@cinatra-ai/sdk-extensions",
      "@cinatra-ai/sdk-ui",
    ]);
  });
  it("ok=true when the cinatra.dependencies edge is published (host-internal peer ignored)", async () => {
    const report = await checkDependencyOrdering({
      manifest: {
        peerDependencies: { "@cinatra-ai/sdk-extensions": "*", "@cinatra-ai/social-media-connector": "*" },
        cinatra: { dependencies: [{ packageName: "@cinatra-ai/social-media-connector" }] },
      },
      registryUrl: "https://registry.cinatra.ai",
      fetchImpl: makeFetch({ "@cinatra-ai/social-media-connector": { body: { versions: { "1.0.0": {} } } } }),
    });
    expect(report.ok).toBe(true);
    expect(report.satisfied.map((d) => d.name)).toEqual(["@cinatra-ai/social-media-connector"]);
    expect(report.skippedNonManifestCinatraDeps).toEqual(["@cinatra-ai/sdk-extensions"]);
  });
  it("probes an edge declared ONLY in cinatra.dependencies (linkedin→social-media; not an npm dep)", async () => {
    const report = await checkDependencyOrdering({
      manifest: {
        peerDependencies: { "@cinatra-ai/sdk-extensions": "*" },
        cinatra: { dependencies: [{ packageName: "@cinatra-ai/social-media-connector" }] },
      },
      registryUrl: "https://registry.cinatra.ai",
      fetchImpl: makeFetch({ "@cinatra-ai/social-media-connector": { body: { versions: { "1.0.0": {} } } } }),
    });
    expect(report.deps.map((d) => d.name)).toEqual(["@cinatra-ai/social-media-connector"]);
    expect(report.deps[0].field).toBe("cinatra.dependencies");
    expect(report.ok).toBe(true);
  });
  it("assert THROWS on a MISSING cinatra.dependencies edge (real ordering violation)", async () => {
    await expect(
      assertDependencyOrdering({
        manifest: {
          peerDependencies: { "@cinatra-ai/social-media-connector": "*" },
          cinatra: { dependencies: [{ packageName: "@cinatra-ai/social-media-connector" }] },
        },
        registryUrl: "https://registry.cinatra.ai",
        fetchImpl: makeFetch({}),
      }),
    ).rejects.toThrow(/not on https:\/\/registry\.cinatra\.ai/);
  });
  it("assert THROWS with a DISTINCT 'registry not readable' message on 401 (for a real edge)", async () => {
    await expect(
      assertDependencyOrdering({
        manifest: {
          dependencies: { "@cinatra-ai/social-media-connector": "*" },
          cinatra: { dependencies: [{ packageName: "@cinatra-ai/social-media-connector" }] },
        },
        registryUrl: "https://registry.cinatra.ai",
        fetchImpl: makeFetch({ "@cinatra-ai/social-media-connector": { status: 401 } }),
      }),
    ).rejects.toThrow(/registry not readable/);
  });
});

describe("formatGateFailure", () => {
  it("distinguishes missing vs unreadable vs error sections", () => {
    const msg = formatGateFailure({
      registryUrl: "https://registry.cinatra.ai",
      missing: [{ name: "@cinatra-ai/a", range: "*", field: "dependencies", state: "missing", detail: "not found on the registry" }],
      unreadable: [{ name: "@cinatra-ai/b", range: "*", field: "peerDependencies", status: 401 }],
      errored: [],
    });
    expect(msg).toContain("not on https://registry.cinatra.ai");
    expect(msg).toContain("registry not readable");
    expect(msg).toContain("CINATRA_REGISTRY_TOKEN");
  });
});
