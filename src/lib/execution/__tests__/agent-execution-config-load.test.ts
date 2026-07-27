// Loader for the per-agent execution-config surface (exec-plane S3 slice B,
// cinatra#1708). Every dependency is injected, so this proves the RESOLUTION
// rules without a DB, an extension store, or a booted execution service.

import { afterEach, describe, it, expect, vi } from "vitest";

import {
  loadAgentExecutionConfig,
  resolvePromotionCandidates,
} from "@/lib/execution/agent-execution-config-load";

const IDENT = { packageName: "@cinatra-ai/some-agent", displayName: "Some Agent" };

function templateStub(overrides: Record<string, unknown> = {}) {
  return async () =>
    ({
      id: "t_1",
      packageName: IDENT.packageName,
      ...overrides,
    }) as never;
}

describe("loadAgentExecutionConfig", () => {
  it("uses the TEMPLATE declaration when the package declares none (editable)", async () => {
    const view = await loadAgentExecutionConfig(IDENT, {
      readManifestEnvironment: async () => ({ environment: null, readFailed: false, packaged: false }),
      readTemplate: templateStub({ executionEnvironment: { pip: ["pandas"] }, executionEnabled: true }),
      serviceState: () => "disabled",
    });
    expect(view.authority).toBe("config");
    expect(view.editable).toBe(true);
    expect(view.editorText.pip).toBe("pandas");
    expect(view.posture).toBe("on");
    expect(view.dormancy.dormant).toBe(true);
  });

  it("uses the MANIFEST declaration when the package declares one (read-only)", async () => {
    const view = await loadAgentExecutionConfig(IDENT, {
      readManifestEnvironment: async () => ({
        environment: { os: ["pandoc"] },
        readFailed: false,
        packaged: true,
      }),
      readTemplate: templateStub({ executionEnvironment: { pip: ["pandas"] } }),
      serviceState: () => "disabled",
    });
    expect(view.authority).toBe("manifest");
    expect(view.editable).toBe(false);
    expect(view.editorText.os).toBe("pandoc");
    // The config column is NOT blended into a manifest-owned recipe.
    expect(view.editorText.pip).toBe("");
  });

  it("an unreadable extension store degrades to READ-ONLY, never to 'no declaration'", async () => {
    const view = await loadAgentExecutionConfig(IDENT, {
      readManifestEnvironment: async () => ({ environment: null, readFailed: true, packaged: true }),
      readTemplate: templateStub({ executionEnvironment: { pip: ["pandas"] } }),
      serviceState: () => "disabled",
    });
    expect(view.editable).toBe(false);
    expect(view.readOnlyReason).toMatch(/could not be read/i);
    // The declaration is UNKNOWN, never "empty" — so nothing is suggested for
    // promotion against a baseline we do not actually have (codex round-2).
    expect(view.spec).toBeNull();
    expect(view.promotionCandidates).toEqual([]);
  });

  it("survives a template read failure (a package with no template row is still rendered)", async () => {
    const view = await loadAgentExecutionConfig(IDENT, {
      readManifestEnvironment: async () => ({ environment: null, readFailed: false, packaged: false }),
      readTemplate: async () => {
        throw new Error("db down");
      },
      serviceState: () => "disabled",
    });
    expect(view.templateId).toBeNull();
    expect(view.editable).toBe(false);
    expect(view.empty).toBe(true);
  });

  it("renders the honest promotion empty state when nothing was observed", async () => {
    const view = await loadAgentExecutionConfig(IDENT, {
      readManifestEnvironment: async () => ({ environment: null, readFailed: false, packaged: false }),
      readTemplate: templateStub(),
      readObservations: async () => [],
      serviceState: () => "disabled",
    });
    expect(view.promotionCandidates).toEqual([]);
    expect(view.promotionEmptyNote).toMatch(/execution plane is off/i);
  });

  it("drives the affordance from OBSERVED ad-hoc installs once they exist", async () => {
    const view = await loadAgentExecutionConfig(IDENT, {
      readManifestEnvironment: async () => ({ environment: null, readFailed: false, packaged: false }),
      readTemplate: templateStub(),
      readObservations: async () =>
        Array.from({ length: 6 }, (_, i) => ({
          runId: `r${i}`,
          manager: "os" as const,
          packageName: "pandoc",
        })).concat(
          Array.from({ length: 4 }, (_, i) => ({
            runId: `r${i + 6}`,
            manager: "os" as const,
            packageName: "jq",
          })),
        ),
      serviceState: () => "ready",
    });
    // pandoc on 6 of the last 10 runs clears the default 50% threshold; jq (4/10)
    // does not — the affordance suggests, it does not spam.
    expect(view.promotionCandidates.map((c) => c.packageName)).toEqual(["pandoc"]);
    expect(view.promotionCandidates[0]).toMatchObject({ runCount: 6, windowRuns: 10 });
  });
});

describe("resolvePromotionCandidates", () => {
  it("never suggests a package the declaration already carries", () => {
    const candidates = resolvePromotionCandidates(
      Array.from({ length: 6 }, (_, i) => ({
        runId: `r${i}`,
        manager: "os" as const,
        packageName: "pandoc",
      })),
      { os: ["pandoc"] },
    );
    expect(candidates).toEqual([]);
  });

  it("suggests nothing against an INVALID declaration (no trustworthy baseline)", () => {
    const candidates = resolvePromotionCandidates(
      [{ runId: "r0", manager: "os", packageName: "pandoc" }],
      null,
    );
    expect(candidates).toEqual([]);
  });

  it("short-circuits with no observations (never touches the execution-plane barrel)", () => {
    expect(resolvePromotionCandidates([], { os: ["pandoc"] })).toEqual([]);
  });
});

describe("the promotion baseline is the AUTHORITATIVE declaration", () => {
  const sixRuns = Array.from({ length: 6 }, (_, i) => ({
    runId: `r${i}`,
    manager: "os" as const,
    packageName: "pandoc",
  }));

  it("uses the MANIFEST declaration, not a stale config column, when the manifest owns it", async () => {
    const view = await loadAgentExecutionConfig(IDENT, {
      // The manifest already declares pandoc → nothing to promote.
      readManifestEnvironment: async () => ({
        environment: { os: ["pandoc"] },
        readFailed: false,
        packaged: true,
      }),
      // A stale config column that does NOT declare it must not resurrect the suggestion.
      readTemplate: templateStub({ executionEnvironment: { pip: ["pandas"] } }),
      readObservations: async () => sixRuns,
      serviceState: () => "ready",
    });
    expect(view.promotionCandidates).toEqual([]);
  });

  it("suggests nothing when the authoritative declaration is INVALID", async () => {
    const view = await loadAgentExecutionConfig(IDENT, {
      readManifestEnvironment: async () => ({
        environment: { os: ["pandoc"], typo: [] },
        readFailed: false,
        packaged: true,
      }),
      readTemplate: templateStub(),
      readObservations: async () => sixRuns,
      serviceState: () => "ready",
    });
    expect(view.spec).toBeNull();
    expect(view.promotionCandidates).toEqual([]);
  });
});

// -- readManifestEnvironmentClaim: the fail-CLOSED store-read rules -----------
//
// `discoverStoreRecordsV2` SKIPS unreadable/malformed packages rather than
// throwing, so "no record" cannot be read as "not a package" for something the
// installed-extension registry says is installed (codex round-1 finding b3).

describe("readManifestEnvironmentClaim store-read discipline", () => {
  const PKG = "@cinatra-ai/not-bundled-agent";

  async function withStore(
    records: { packageName: string; executionEnvironment?: unknown }[],
    installedExtension: boolean,
  ) {
    vi.resetModules();
    vi.doMock("@/lib/extension-store-io", () => ({
      realStoreFs: {},
      discoverStoreRecordsV2: async () => records,
    }));
    vi.doMock("@/lib/extension-data-root", () => ({
      resolveExtensionDataRoot: () => "/nonexistent",
    }));
    const mod = await import("@/lib/execution/agent-execution-config-load");
    return mod.readManifestEnvironmentClaim(PKG, { installedExtension });
  }

  afterEach(() => {
    vi.doUnmock("@/lib/extension-store-io");
    vi.doUnmock("@/lib/extension-data-root");
    vi.resetModules();
  });

  it("an INSTALLED package with no readable store record fails CLOSED to read-only", async () => {
    const result = await withStore([], true);
    expect(result).toEqual({ environment: null, readFailed: true, packaged: true });
  });

  it("a package that is genuinely absent is an in-app agent, not a read failure", async () => {
    const result = await withStore([], false);
    expect(result).toEqual({ environment: null, readFailed: false, packaged: false });
  });

  it("MULTIPLE materialized digests that AGREE resolve to the agreed declaration", async () => {
    const result = await withStore(
      [
        { packageName: PKG, executionEnvironment: { os: ["pandoc"] } },
        // Same recipe, different authoring order — canonicalization makes them equal.
        { packageName: PKG, executionEnvironment: { os: ["pandoc", "pandoc"] } },
      ],
      true,
    );
    expect(result.readFailed).toBe(false);
    expect(result.environment).toEqual({ os: ["pandoc"] });
  });

  it("MULTIPLE materialized digests that DISAGREE fail CLOSED (never an arbitrary pick)", async () => {
    const result = await withStore(
      [
        { packageName: PKG, executionEnvironment: { os: ["pandoc"] } },
        { packageName: PKG, executionEnvironment: { os: ["ffmpeg"] } },
      ],
      true,
    );
    expect(result).toEqual({ environment: null, readFailed: true, packaged: true });
  });
});
