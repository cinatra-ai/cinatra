import { describe, expect, it } from "vitest";

import {
  normalizeProjectAgentEnvironment,
  resolveRunExecutionEnvironment,
} from "../execution-environment";

describe("normalizeProjectAgentEnvironment", () => {
  it("normalizes to the SAME internal type as packaged manifests (canonical spec)", () => {
    const result = normalizeProjectAgentEnvironment({ pip: ["b", "a", "b"] });
    expect(result).toEqual({ ok: true, spec: { pip: ["a", "b"] } });
  });

  it("treats null/undefined as no declared environment", () => {
    expect(normalizeProjectAgentEnvironment(null)).toEqual({ ok: true, spec: {} });
    expect(normalizeProjectAgentEnvironment(undefined)).toEqual({ ok: true, spec: {} });
  });

  it("fails closed on unknown keys exactly like the manifest path", () => {
    const result = normalizeProjectAgentEnvironment({ pips: ["x"] });
    expect(result.ok).toBe(false);
  });
});

describe("resolveRunExecutionEnvironment", () => {
  const liveEnv = { pip: ["pandas==2.2.1"] };
  const snapshotEnv = { pip: ["pandas==2.0.0"] };

  it("PINNED run resolves the SNAPSHOT environment, never the live template", () => {
    // The live template's spec CHANGED after the version snapshot was taken —
    // the pinned run must keep mounting the snapshot's recipe (cinatra#1708
    // acceptance: "a pinned run mounts its snapshot's environment after the
    // live spec changed").
    const resolved = resolveRunExecutionEnvironment({
      pinnedSnapshot: { executionEnvironment: snapshotEnv },
      liveTemplateEnvironment: liveEnv,
    });
    expect(resolved).toEqual({
      kind: "declared",
      spec: { pip: ["pandas==2.0.0"] },
      source: "version-snapshot",
    });
  });

  it("a pinned snapshot WITHOUT a declared env resolves none — no live fallback", () => {
    const resolved = resolveRunExecutionEnvironment({
      pinnedSnapshot: {},
      liveTemplateEnvironment: liveEnv,
    });
    expect(resolved).toEqual({ kind: "none" });
  });

  it("draft/unpinned run resolves the live template environment", () => {
    const resolved = resolveRunExecutionEnvironment({
      liveTemplateEnvironment: liveEnv,
    });
    expect(resolved).toEqual({
      kind: "declared",
      spec: { pip: ["pandas==2.2.1"] },
      source: "live-template",
    });
  });

  it("no declared environment anywhere resolves none", () => {
    expect(resolveRunExecutionEnvironment({})).toEqual({ kind: "none" });
    expect(
      resolveRunExecutionEnvironment({ liveTemplateEnvironment: { pip: [] } }),
    ).toEqual({ kind: "none" });
  });

  it("an invalid declaration resolves invalid (fail-closed), with its source", () => {
    const resolved = resolveRunExecutionEnvironment({
      pinnedSnapshot: { executionEnvironment: { bogus: ["x"] } },
    });
    expect(resolved.kind).toBe("invalid");
    if (resolved.kind !== "invalid") return;
    expect(resolved.source).toBe("version-snapshot");
    expect(resolved.errors.length).toBeGreaterThan(0);
  });
});

describe("resolveRunExecutionEnvironment — packaged-manifest source (epic #1705)", () => {
  it("a packaged manifest declaration resolves declared, sourced to the manifest", () => {
    const resolved = resolveRunExecutionEnvironment({
      packagedManifestEnvironment: { pip: ["pandas==2.2.1"], os: ["pandoc"] },
    });
    expect(resolved).toEqual({
      kind: "declared",
      spec: { os: ["pandoc"], pip: ["pandas==2.2.1"] },
      source: "packaged-manifest",
    });
  });

  it("REGRESSION (#1705 fail-open): a manifest-declared env no longer reads as none", () => {
    // Before the run-seam fix the bridge supplied only `liveTemplateEnvironment`,
    // so a packaged agent's manifest declaration resolved `none` and the run
    // silently executed on L0 — the inverse of the epic's contract.
    expect(
      resolveRunExecutionEnvironment({ liveTemplateEnvironment: undefined }),
    ).toEqual({ kind: "none" });
    expect(
      resolveRunExecutionEnvironment({
        packagedManifestEnvironment: { pip: ["pandas"] },
        liveTemplateEnvironment: undefined,
      }).kind,
    ).toBe("declared");
  });

  it("a NON-EMPTY manifest declaration wins over the template config AND the pin", () => {
    // Epic D8: a packaged agent's environment is reviewed/locked through the
    // extension review path and versioned by the INSTALLED PACKAGE version,
    // which the agent-template pin does not name.
    const resolved = resolveRunExecutionEnvironment({
      packagedManifestEnvironment: { npm: ["cowsay"] },
      pinnedSnapshot: { executionEnvironment: { pip: ["pandas"] } },
      liveTemplateEnvironment: { pip: ["numpy"] },
    });
    expect(resolved).toEqual({
      kind: "declared",
      spec: { npm: ["cowsay"] },
      source: "packaged-manifest",
    });
  });

  it("a manifest that declares an EMPTY recipe leaves the recipe to the config sources", () => {
    // slice B's instance-local case: the package asked for nothing, so an
    // instance-local / project declaration still applies.
    expect(
      resolveRunExecutionEnvironment({
        packagedManifestEnvironment: {},
        liveTemplateEnvironment: { pip: ["pandas"] },
      }),
    ).toEqual({ kind: "declared", spec: { pip: ["pandas"] }, source: "live-template" });
    expect(
      resolveRunExecutionEnvironment({
        packagedManifestEnvironment: { pip: [] },
        pinnedSnapshot: { executionEnvironment: { npm: ["cowsay"] } },
        liveTemplateEnvironment: { pip: ["pandas"] },
      }),
    ).toEqual({ kind: "declared", spec: { npm: ["cowsay"] }, source: "version-snapshot" });
  });

  it("an INVALID manifest declaration fails closed, sourced to the manifest", () => {
    const resolved = resolveRunExecutionEnvironment({
      packagedManifestEnvironment: { bogus: ["x"] },
      liveTemplateEnvironment: { pip: ["pandas"] },
    });
    expect(resolved.kind).toBe("invalid");
    if (resolved.kind !== "invalid") return;
    expect(resolved.source).toBe("packaged-manifest");
  });

  it("the claim resolver's PRESENT-but-malformed marker fails closed, never 'no environment'", () => {
    const resolved = resolveRunExecutionEnvironment({
      packagedManifestEnvironment: { __invalidExecutionEnvironmentDeclaration: true },
    });
    expect(resolved.kind).toBe("invalid");
    if (resolved.kind !== "invalid") return;
    expect(resolved.source).toBe("packaged-manifest");
  });

  it("an absent manifest claim leaves today's pinned/live behaviour byte-identical", () => {
    expect(
      resolveRunExecutionEnvironment({
        packagedManifestEnvironment: null,
        liveTemplateEnvironment: { pip: ["pandas"] },
      }),
    ).toEqual({ kind: "declared", spec: { pip: ["pandas"] }, source: "live-template" });
    expect(
      resolveRunExecutionEnvironment({
        packagedManifestEnvironment: undefined,
        pinnedSnapshot: { executionEnvironment: null },
        liveTemplateEnvironment: { pip: ["pandas"] },
      }),
    ).toEqual({ kind: "none" });
  });
});
