import { describe, expect, it } from "vitest";

import {
  CINATRA_SCOPE,
  DEFAULT_REGISTRY_URL,
  extractCinatraDeps,
  extractCinatraManifestDepNames,
  selectExtensionDepsToProbe,
  probeDep,
  checkDependencyOrdering,
  assertDependencyOrdering,
  formatGateFailure,
  vendorAuthHeader,
  classifySubmissionOutcome,
  assertSubmissionOutcome,
  buildSubmitArguments,
} from "../templates/release/release-submit.mjs";

function makeFetch(table) {
  return async (url) => {
    const m = /@cinatra-ai%2F([^/?#]+)/.exec(url);
    const name = m ? `@cinatra-ai/${decodeURIComponent(m[1])}` : url;
    const entry = table[name];
    if (!entry) return { status: 404, ok: false, json: async () => ({}) };
    const status = entry.status ?? 200;
    return { status, ok: status >= 200 && status < 300, json: async () => entry.body ?? {} };
  };
}

describe("release-submit dependency gate (existence-based)", () => {
  it("exposes the canonical constants", () => {
    expect(CINATRA_SCOPE).toBe("@cinatra-ai/");
    expect(DEFAULT_REGISTRY_URL).toBe("https://registry.cinatra.ai");
  });

  it("extractCinatraDeps pulls deps+peerDeps, dedups, ignores non-@cinatra-ai", () => {
    const deps = extractCinatraDeps({
      dependencies: { "@cinatra-ai/sdk-extensions": "^2.0.0", react: "19" },
      peerDependencies: { "@cinatra-ai/sdk-ui": "*", "@cinatra-ai/sdk-extensions": "^2.0.0" },
    });
    expect(deps.map((d) => d.name).sort()).toEqual(["@cinatra-ai/sdk-extensions", "@cinatra-ai/sdk-ui"]);
  });

  const opts = (table) => ({ registryUrl: "https://registry.cinatra.ai", fetchImpl: makeFetch(table) });

  it("satisfied when the package has published versions (any range)", async () => {
    const r = await probeDep(
      { name: "@cinatra-ai/sdk-extensions", range: "^2.0.0", field: "peerDependencies" },
      opts({ "@cinatra-ai/sdk-extensions": { body: { versions: { "1.0.0": {} } } } }),
    );
    // existence-based: even a non-matching semver counts as published (the
    // marketplace re-validates exact compat at approval).
    expect(r.state).toBe("satisfied");
  });
  it("missing on 404", async () => {
    const r = await probeDep({ name: "@cinatra-ai/nope", range: "*", field: "dependencies" }, opts({}));
    expect(r.state).toBe("missing");
  });
  it("missing when published but zero versions", async () => {
    const r = await probeDep(
      { name: "@cinatra-ai/x", range: "*", field: "dependencies" },
      opts({ "@cinatra-ai/x": { body: { versions: {} } } }),
    );
    expect(r.state).toBe("missing");
  });
  it("UNREADABLE (distinct from missing) on 401/403", async () => {
    expect((await probeDep({ name: "@cinatra-ai/x", range: "*", field: "dependencies" }, opts({ "@cinatra-ai/x": { status: 401 } }))).state).toBe("unreadable");
    expect((await probeDep({ name: "@cinatra-ai/x", range: "*", field: "dependencies" }, opts({ "@cinatra-ai/x": { status: 403 } }))).state).toBe("unreadable");
  });
  it("error on a network throw (no silent pass)", async () => {
    const r = await probeDep(
      { name: "@cinatra-ai/x", range: "*", field: "dependencies" },
      { registryUrl: "https://registry.cinatra.ai", fetchImpl: async () => { throw new Error("ENET"); } },
    );
    expect(r.state).toBe("error");
  });
});

describe("release-submit selectExtensionDepsToProbe (cinatra.dependencies is the edge authority)", () => {
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

describe("release-submit checkDependencyOrdering + assert (probes canonical cinatra.dependencies edges only)", () => {
  it("ok=true for a 0-dep manifest, no probes", async () => {
    let calls = 0;
    const report = await checkDependencyOrdering({
      manifest: {},
      fetchImpl: async () => { calls++; return { status: 200, ok: true, json: async () => ({}) }; },
    });
    expect(report.ok).toBe(true);
    expect(calls).toBe(0);
  });
  it("SKIPS host-internal @cinatra-ai/* peers (not in cinatra.dependencies) — no probes, gate PASSES", async () => {
    let calls = 0;
    const report = await checkDependencyOrdering({
      manifest: {
        peerDependencies: { "@cinatra-ai/sdk-extensions": "*", "@cinatra-ai/sdk-ui": "*", "@cinatra-ai/mcp-client": "*" },
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
  it("probes an edge declared ONLY in cinatra.dependencies (not an npm dep)", async () => {
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
    expect(report.skippedNonManifestCinatraDeps).toEqual(["@cinatra-ai/sdk-extensions"]);
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
  it("assert THROWS with DISTINCT 'registry not readable' on 401 (for a real edge)", async () => {
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

describe("release-submit parity with the dev CLI gate", () => {
  it("uses the same scope + default registry as packages/cli/src/extensions-dependency-gate.mjs", async () => {
    const dev = await import("../../../packages/cli/src/extensions-dependency-gate.mjs");
    expect(CINATRA_SCOPE).toBe(dev.CINATRA_SCOPE);
    expect(DEFAULT_REGISTRY_URL).toBe(dev.DEFAULT_REGISTRY_URL);
  });
  it("extractCinatraDeps agrees with the dev CLI on the same manifest", async () => {
    const dev = await import("../../../packages/cli/src/extensions-dependency-gate.mjs");
    const manifest = {
      dependencies: { "@cinatra-ai/a": "^1", lodash: "*" },
      peerDependencies: { "@cinatra-ai/b": "*" },
    };
    expect(extractCinatraDeps(manifest)).toEqual(dev.extractCinatraDeps(manifest));
  });
  it("selectExtensionDepsToProbe agrees with the dev CLI (same edge classification)", async () => {
    const dev = await import("../../../packages/cli/src/extensions-dependency-gate.mjs");
    const manifest = {
      dependencies: { "@cinatra-ai/nango-connector": "*", "@cinatra-ai/sdk-extensions": "*", lodash: "*" },
      peerDependencies: { "@cinatra-ai/sdk-ui": "*" },
      cinatra: {
        dependencies: [{ packageName: "@cinatra-ai/nango-connector" }, { packageName: "@cinatra-ai/social-media-connector" }],
      },
    };
    expect(selectExtensionDepsToProbe(manifest)).toEqual(dev.selectExtensionDepsToProbe(manifest));
  });
});

describe("release-submit vendorAuthHeader", () => {
  it("returns {} for an empty/falsy token", () => {
    expect(vendorAuthHeader("")).toEqual({});
    expect(vendorAuthHeader(undefined)).toEqual({});
  });

  it("passes an already-formatted Basic/Bearer header through unchanged", () => {
    expect(vendorAuthHeader("Basic xyz")).toEqual({ authorization: "Basic xyz" });
    expect(vendorAuthHeader("Bearer abc")).toEqual({ authorization: "Bearer abc" });
    // prefix match is case-insensitive (/^(Bearer|Basic)\s/i) — pass through unchanged.
    expect(vendorAuthHeader("basic xyz")).toEqual({ authorization: "basic xyz" });
  });

  it("builds HTTP Basic base64(<default-user>:<app-pw>) for a raw token", () => {
    const saved = process.env.CINATRA_MARKETPLACE_VENDOR_USER;
    delete process.env.CINATRA_MARKETPLACE_VENDOR_USER;
    try {
      expect(vendorAuthHeader("app-pw-123")).toEqual({
        authorization: `Basic ${Buffer.from("cinatra-ai:app-pw-123").toString("base64")}`,
      });
    } finally {
      if (saved === undefined) delete process.env.CINATRA_MARKETPLACE_VENDOR_USER;
      else process.env.CINATRA_MARKETPLACE_VENDOR_USER = saved;
    }
  });

  it("honors a CINATRA_MARKETPLACE_VENDOR_USER override for the Basic user", () => {
    const saved = process.env.CINATRA_MARKETPLACE_VENDOR_USER;
    process.env.CINATRA_MARKETPLACE_VENDOR_USER = "vendor-x";
    try {
      expect(vendorAuthHeader("pw")).toEqual({
        authorization: `Basic ${Buffer.from("vendor-x:pw").toString("base64")}`,
      });
    } finally {
      if (saved === undefined) delete process.env.CINATRA_MARKETPLACE_VENDOR_USER;
      else process.env.CINATRA_MARKETPLACE_VENDOR_USER = saved;
    }
  });
});

describe("classifySubmissionOutcome (promotion-state truth)", () => {
  it("listed only when terminal status=promoted + promotion_state=complete", () => {
    expect(classifySubmissionOutcome({ status: "promoted", promotionState: "complete" })).toEqual({ kind: "listed" });
  });
  it("failed when promotion_state=failed (the half-failed 200, no isError)", () => {
    expect(classifySubmissionOutcome({ status: "approved", promotionState: "failed" }).kind).toBe("failed");
  });
  it("pending when status=pending (auto-approve off / separation-of-duties)", () => {
    expect(classifySubmissionOutcome({ status: "pending", promotionState: null }).kind).toBe("pending");
  });
  it("unconfirmed for in_flight / unknown shapes", () => {
    expect(classifySubmissionOutcome({ status: "approved", promotionState: "in_flight" }).kind).toBe("unconfirmed");
    expect(classifySubmissionOutcome({}).kind).toBe("unconfirmed");
  });
  it("is case-insensitive", () => {
    expect(classifySubmissionOutcome({ status: "PROMOTED", promotionState: "COMPLETE" })).toEqual({ kind: "listed" });
  });
});

describe("assertSubmissionOutcome", () => {
  it("THROWS on a half-failed promotion (failed)", () => {
    expect(() => assertSubmissionOutcome({ submissionId: "9", status: "approved", promotionState: "failed" })).toThrow(/NOT a renderable storefront listing/);
  });
  it("does NOT throw on listed", () => {
    expect(assertSubmissionOutcome({ submissionId: "9", status: "promoted", promotionState: "complete" })).toEqual({ kind: "listed" });
  });
  it("does NOT throw on pending (legitimate when auto-approve is off) — warns instead", () => {
    const saved = process.stderr.write;
    let warned = "";
    process.stderr.write = (s) => {
      warned += s;
      return true;
    };
    try {
      const r = assertSubmissionOutcome({ submissionId: "9", status: "pending", promotionState: null });
      expect(r.kind).toBe("pending");
    } finally {
      process.stderr.write = saved;
    }
    expect(warned).toMatch(/NOT confirmed-listed/);
  });
});

describe("buildSubmitArguments (source-identity token forwarding + back-compat)", () => {
  const base = {
    namespace: "@cinatra-ai",
    extensionName: "blog-skills",
    version: "0.1.0",
    artifactDigestSha256: "abc123",
    artifactSizeBytes: 4096,
    tarballBase64: "QkFTRTY0",
  };

  it("emits the historical shape with NO optional fields when none are supplied", () => {
    expect(buildSubmitArguments(base)).toEqual({
      namespace: "@cinatra-ai",
      extension_name: "blog-skills",
      version: "0.1.0",
      artifact_digest_sha256: "abc123",
      artifact_size_bytes: 4096,
      tarball_base64: "QkFTRTY0",
    });
  });

  it("includes source_identity_token ONLY when it is a non-empty string", () => {
    expect(buildSubmitArguments({ ...base, sourceIdentityToken: "ey.JWT.sig" }).source_identity_token).toBe("ey.JWT.sig");
    for (const empty of [undefined, "", null]) {
      expect("source_identity_token" in buildSubmitArguments({ ...base, sourceIdentityToken: empty })).toBe(false);
    }
  });

  it("includes description independently, and both optionals together", () => {
    expect("description" in buildSubmitArguments(base)).toBe(false);
    const both = buildSubmitArguments({ ...base, description: "hi", sourceIdentityToken: "tok" });
    expect(both.description).toBe("hi");
    expect(both.source_identity_token).toBe("tok");
  });

  it("does not mutate or reorder the required wire fields when the token is present", () => {
    const withTok = buildSubmitArguments({ ...base, sourceIdentityToken: "tok" });
    expect(withTok.namespace).toBe("@cinatra-ai");
    expect(withTok.extension_name).toBe("blog-skills");
    expect(withTok.artifact_digest_sha256).toBe("abc123");
    expect(withTok.artifact_size_bytes).toBe(4096);
    expect(withTok.tarball_base64).toBe("QkFTRTY0");
  });
});
