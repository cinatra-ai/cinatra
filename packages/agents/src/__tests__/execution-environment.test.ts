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
