// Dual-read manifest dependency reader tests (#180 item 9, read seam).
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { ExtensionDependency } from "../canonical-types";
import {
  ManifestDependencyError,
  parseManifestDependencyEdges,
  validateExtensionDependencyShape,
  persistDependencyEdgesOnCanonicalRows,
  resolveLiveCanonicalEdgeTargets,
  writeDependencyEdgesToCanonicalRows,
} from "../manifest-dependencies";

function edge(
  packageName: string,
  over: Partial<ExtensionDependency> = {},
): ExtensionDependency {
  return {
    packageName,
    edgeType: "runtime",
    versionConstraint: { kind: "semver-range", range: "*" },
    requirement: "required",
    ...over,
  };
}

function manifest(cinatra: Record<string, unknown>): unknown {
  return { name: "@cinatra-ai/root", version: "1.0.0", cinatra };
}

describe("parseManifestDependencyEdges — dual-read matrix", () => {
  it("neither vocabulary present → no edges, source 'none'", () => {
    expect(parseManifestDependencyEdges(manifest({}))).toEqual({ edges: [], source: "none" });
    expect(parseManifestDependencyEdges({ name: "x" })).toEqual({ edges: [], source: "none" });
  });

  it("canonical only → canonical edges verbatim (incl. the kind field)", () => {
    const deps = [edge("@cinatra-ai/b", { kind: "connector" }), edge("@cinatra-ai/c", { edgeType: "peer", requirement: "optional" })];
    const r = parseManifestDependencyEdges(manifest({ dependencies: deps }));
    expect(r.source).toBe("canonical");
    expect(r.edges).toEqual(deps);
  });

  it("canonical empty array → [] with source 'canonical' (declared-empty, never a silent default)", () => {
    const r = parseManifestDependencyEdges(manifest({ dependencies: [] }));
    expect(r).toEqual({ edges: [], source: "canonical" });
  });

  it("explicit null is MALFORMED on both vocabularies (only an ABSENT key means 'not declared')", () => {
    expect(() => parseManifestDependencyEdges(manifest({ dependencies: null }))).toThrow(
      ManifestDependencyError,
    );
    expect(() => parseManifestDependencyEdges(manifest({ dependencies: null }))).toThrow(/null/);
    expect(() => parseManifestDependencyEdges(manifest({ agentDependencies: null }))).toThrow(
      ManifestDependencyError,
    );
    expect(() => parseManifestDependencyEdges(manifest({ agentDependencies: null }))).toThrow(/null/);
  });

  it("legacy only → projected required runtime semver-range edges WITHOUT a guessed kind", () => {
    const r = parseManifestDependencyEdges(
      manifest({ agentDependencies: { "@cinatra-ai/b": "^1.0.0", "@cinatra-ai/c": "*" } }),
    );
    expect(r.source).toBe("legacy-agent");
    expect(r.edges).toEqual([
      {
        packageName: "@cinatra-ai/b",
        edgeType: "runtime",
        versionConstraint: { kind: "semver-range", range: "^1.0.0" },
        requirement: "required",
      },
      {
        packageName: "@cinatra-ai/c",
        edgeType: "runtime",
        versionConstraint: { kind: "semver-range", range: "*" },
        requirement: "required",
      },
    ]);
    expect(r.edges.every((e) => e.kind === undefined)).toBe(true);
  });

  it("BOTH present and AGREEING → canonical wins (richer superset + range differences allowed)", () => {
    // Mirrors the real first-party shape (email-outreach-agent): canonical
    // declares MORE edges than the legacy map, and canonical ranges ('*')
    // differ from legacy ranges ('^0.1.0') — neither is a conflict.
    const canonical = [
      edge("@cinatra-ai/b", { kind: "agent" }),
      edge("@cinatra-ai/extra", { kind: "agent" }), // canonical-only edge
    ];
    const r = parseManifestDependencyEdges(
      manifest({ dependencies: canonical, agentDependencies: { "@cinatra-ai/b": "^0.1.0" } }),
    );
    expect(r.source).toBe("canonical");
    expect(r.edges).toEqual(canonical);
  });

  it("CONFLICT: a legacy name missing from the canonical array fails LOUD", () => {
    expect(() =>
      parseManifestDependencyEdges(
        manifest({ dependencies: [edge("@cinatra-ai/b")], agentDependencies: { "@cinatra-ai/dropped": "^1.0.0" } }),
      ),
    ).toThrowError(ManifestDependencyError);
    try {
      parseManifestDependencyEdges(
        manifest({ dependencies: [edge("@cinatra-ai/b")], agentDependencies: { "@cinatra-ai/dropped": "^1.0.0" } }),
      );
    } catch (e) {
      expect((e as ManifestDependencyError).code).toBe("CONFLICT");
      expect((e as Error).message).toContain("@cinatra-ai/dropped");
    }
  });

  it("CONFLICT: a legacy name weakened to optional/peer in the canonical array fails LOUD", () => {
    for (const weak of [
      edge("@cinatra-ai/b", { requirement: "optional" }),
      edge("@cinatra-ai/b", { edgeType: "peer" }),
    ]) {
      expect(() =>
        parseManifestDependencyEdges(
          manifest({ dependencies: [weak], agentDependencies: { "@cinatra-ai/b": "*" } }),
        ),
      ).toThrowError(/disagree/);
    }
  });

  it("legacy required install-time canonical edge is NOT a conflict (still install-blocking)", () => {
    const canonical = [edge("@cinatra-ai/b", { edgeType: "install-time" })];
    const r = parseManifestDependencyEdges(
      manifest({ dependencies: canonical, agentDependencies: { "@cinatra-ai/b": "*" } }),
    );
    expect(r.edges).toEqual(canonical);
  });

  it("MALFORMED canonical entries fail LOUD (never silently dropped)", () => {
    const bad: unknown[] = [
      "not-an-object",
      { packageName: "", edgeType: "runtime", versionConstraint: { kind: "semver-range", range: "*" }, requirement: "required" },
      { packageName: "@cinatra-ai/b", edgeType: "compile-time", versionConstraint: { kind: "semver-range", range: "*" }, requirement: "required" },
      { packageName: "@cinatra-ai/b", edgeType: "runtime", versionConstraint: { kind: "semver-range", range: "*" }, requirement: "mandatory" },
      { packageName: "@cinatra-ai/b", edgeType: "runtime", versionConstraint: { kind: "tag", tag: "latest" }, requirement: "required" },
      { packageName: "@cinatra-ai/b", edgeType: "runtime", versionConstraint: { kind: "semver-range", range: "" }, requirement: "required" },
      { packageName: "@cinatra-ai/b", edgeType: "runtime", versionConstraint: { kind: "semver-range", range: "*" }, requirement: "required", kind: "plugin" },
    ];
    for (const entry of bad) {
      expect(() => parseManifestDependencyEdges(manifest({ dependencies: [entry] }))).toThrowError(
        ManifestDependencyError,
      );
    }
    // non-array canonical / non-object legacy
    expect(() => parseManifestDependencyEdges(manifest({ dependencies: {} }))).toThrowError(/must be an array/);
    expect(() => parseManifestDependencyEdges(manifest({ agentDependencies: ["x"] }))).toThrowError(/map/);
  });

  it("self-edges and duplicates fail LOUD on both vocabularies", () => {
    expect(() =>
      parseManifestDependencyEdges(manifest({ dependencies: [edge("@cinatra-ai/root")] })),
    ).toThrowError(/self-edge/);
    expect(() =>
      parseManifestDependencyEdges(manifest({ agentDependencies: { "@cinatra-ai/root": "*" } })),
    ).toThrowError(/self-edge/);
    expect(() =>
      parseManifestDependencyEdges(manifest({ dependencies: [edge("@cinatra-ai/b"), edge("@cinatra-ai/b")] })),
    ).toThrowError(/duplicate/);
  });

  it("validateExtensionDependencyShape accepts all three versionConstraint kinds", () => {
    expect(validateExtensionDependencyShape(edge("@x/b"))).toEqual([]);
    expect(
      validateExtensionDependencyShape(edge("@x/b", { versionConstraint: { kind: "exact", version: "1.2.3" } })),
    ).toEqual([]);
    expect(
      validateExtensionDependencyShape(edge("@x/b", { versionConstraint: { kind: "git-ref", ref: "abc123" } })),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// persistDependencyEdgesOnCanonicalRows (the agent-path finalize-seam writer)
// ---------------------------------------------------------------------------

const readRows = vi.fn();
const record = vi.fn();
vi.mock("../canonical-store", () => ({
  readInstalledExtensionsByPackageName: (...a: unknown[]) => readRows(...a),
}));
vi.mock("../lifecycle-primitive", () => ({
  recordExtensionDependencies: (...a: unknown[]) => record(...a),
}));

function row(id: string, status: string, organizationId: string | null) {
  return { id, packageName: "@cinatra-ai/root", status, organizationId };
}

describe("persistDependencyEdgesOnCanonicalRows", () => {
  beforeEach(() => {
    readRows.mockReset();
    record.mockReset();
    record.mockResolvedValue(undefined);
  });

  it("patches every LIVE row when no org scope is given; archived rows untouched", async () => {
    readRows.mockResolvedValue([row("r1", "active", null), row("r2", "locked", "org-1"), row("r3", "archived", null)]);
    const edges = [edge("@cinatra-ai/b")];
    const res = await persistDependencyEdgesOnCanonicalRows({ packageName: "@cinatra-ai/root", edges });
    expect(res.patchedRowIds).toEqual(["r1", "r2"]);
    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledWith("r1", edges, expect.objectContaining({ actor: { source: "runtime-installer" } }));
  });

  it("patches ONLY the exact org scope when one is given (null = platform)", async () => {
    readRows.mockResolvedValue([row("r1", "active", null), row("r2", "active", "org-1")]);
    const res = await persistDependencyEdgesOnCanonicalRows({
      packageName: "@cinatra-ai/root",
      edges: [],
      organizationId: "org-1",
    });
    expect(res.patchedRowIds).toEqual(["r2"]);
  });

  it("unreachable canonical store → THROWS (fail-loud — a materializing path must never silently keep the [] seed)", async () => {
    readRows.mockRejectedValue(new Error("no SUPABASE_DB_URL"));
    await expect(
      persistDependencyEdgesOnCanonicalRows({ packageName: "@cinatra-ai/root", edges: [] }),
    ).rejects.toThrow("no SUPABASE_DB_URL");
    expect(record).not.toHaveBeenCalled();
  });

  it("ZERO live rows is the legitimate no-op (a dispatcher-less agent install has no canonical row to patch)", async () => {
    readRows.mockResolvedValue([row("r3", "archived", null)]);
    const res = await persistDependencyEdgesOnCanonicalRows({ packageName: "@cinatra-ai/root", edges: [] });
    expect(res.patchedRowIds).toEqual([]);
    expect(record).not.toHaveBeenCalled();
  });

  it("a FAILED write on an existing row throws (the invariant is not best-effort)", async () => {
    readRows.mockResolvedValue([row("r1", "active", null)]);
    record.mockRejectedValue(new Error("write refused"));
    await expect(
      persistDependencyEdgesOnCanonicalRows({ packageName: "@cinatra-ai/root", edges: [] }),
    ).rejects.toThrow("write refused");
  });

  it("SPLIT PHASES (r2): resolve is the fail-loud read (inert pre-write window); write lands on the PRE-RESOLVED targets without re-reading", async () => {
    // resolve: fail-loud on store failure, BEFORE the caller's own writes.
    readRows.mockRejectedValueOnce(new Error("store down"));
    await expect(resolveLiveCanonicalEdgeTargets({ packageName: "@cinatra-ai/root" })).rejects.toThrow(
      "store down",
    );
    // resolve: live-row filtering identical to the one-shot helper.
    readRows.mockResolvedValue([row("r1", "active", null), row("r3", "archived", null)]);
    const targets = await resolveLiveCanonicalEdgeTargets({ packageName: "@cinatra-ai/root" });
    expect(targets).toEqual([{ id: "r1", packageName: "@cinatra-ai/root" }]);
    // write: consumes the targets, never re-reads the store.
    readRows.mockClear();
    const edges = [edge("@cinatra-ai/b")];
    const res = await writeDependencyEdgesToCanonicalRows(targets, edges);
    expect(res.patchedRowIds).toEqual(["r1"]);
    expect(readRows).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith("r1", edges, expect.objectContaining({ actor: { source: "runtime-installer" } }));
  });
});
