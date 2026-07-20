// Host-seam tests for the presentation-identity resolver (epic #1883 slice A6).
// The postgres runner is mocked; the seam binds the pure resolver to the
// in-process object-type registry (install/live + per-pack thresholds) and the
// org auto-surface toggle. These prove:
//   - the batched read is a SINGLE org-scoped ACTIVE-assertion query (eligible +
//     drafts, archived excluded);
//   - live status is registry membership; an uninstalled extension never wins;
//   - the pack's `matcherConfidenceThreshold` drives auto-surface;
//   - the org toggle disables tier 2;
//   - a read error fails CLOSED to the base (type-driven) identity.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ArtifactDescriptor } from "@cinatra-ai/objects";

const runPostgresQueriesSync = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@/lib/postgres-config", () => ({
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://test",
}));

import { objectTypeRegistry } from "@cinatra-ai/objects";
import {
  resolveArtifactPresentationIdentities,
  resolveArtifactPresentationIdentity,
} from "@/lib/objects/presentation-identity";
import {
  _resetArtifactAutoSurfaceToggleForTests,
  setArtifactAutoSurfaceDisabled,
} from "@/lib/objects/artifact-autosurface-toggle";

const ORG = "org-1";
const GENERIC = "@cinatra-ai/artifact:object";
const X = "@acme/x-artifact";
const Y = "@acme/y-artifact";

type Row = Record<string, unknown>;

/** Register the `<ext>:artifact` umbrella type so the extension is LIVE and its
 * manifest threshold resolves. */
function registerArtifactExt(ext: string, threshold?: number): void {
  const isArtifact = {
    accepts: { file: { mimeTypes: ["text/plain"] } },
    ...(threshold !== undefined ? { matcherConfidenceThreshold: threshold } : {}),
  } as unknown as ArtifactDescriptor;
  objectTypeRegistry.register(
    {
      type: `${ext}:artifact`,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
      renderers: { listRow: null, card: null, detail: null },
      isArtifact,
    },
    ext,
  );
}

/** Prime the single active-assertion read (or an error). */
function primeAssertions(rows: Row[] | Error): void {
  runPostgresQueriesSync.mockImplementation((input: { queries: Array<{ text: string }> }) => {
    const text = input.queries[0]?.text ?? "";
    if (text.includes("semantic_assertion")) {
      if (rows instanceof Error) throw rows;
      return [{ rows, rowCount: rows.length }];
    }
    throw new Error(`unexpected query: ${text}`);
  });
}

function sa(part: Partial<Row> & { artifact_id: string; extension: string }): Row {
  return {
    asserted_by: "user",
    eligibility: "eligible",
    assertion_basis: "classic",
    confidence: null,
    asserted_at: "2026-07-20T00:00:00.000Z",
    ...part,
  };
}

beforeEach(() => {
  runPostgresQueriesSync.mockReset();
  objectTypeRegistry._clearForTests();
  _resetArtifactAutoSurfaceToggleForTests();
});

describe("active-assertion read: SQL shape + scoping", () => {
  it("is a SINGLE batched, org-scoped, NON-archived query", () => {
    primeAssertions([]);
    resolveArtifactPresentationIdentities({ orgId: ORG, rows: [{ id: "a1", type: GENERIC }] });
    const calls = runPostgresQueriesSync.mock.calls.map(
      (c) => (c[0] as { queries: Array<{ text: string; values: unknown[] }> }).queries[0],
    );
    expect(calls).toHaveLength(1);
    const q = calls[0]!;
    expect(q.text).toContain("semantic_assertion");
    expect(q.text).toContain("eligibility <> 'archived'");
    expect(q.text).toContain("assertion_basis");
    expect(q.values).toEqual([ORG, ["a1"]]);
  });

  it("a read error fails CLOSED to the base type-driven identity", () => {
    primeAssertions(new Error("connection refused"));
    registerArtifactExt(X); // X live, but the assertion read fails
    const out = resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toEqual({ kind: "no-primary" });
    expect(out.suggestions).toEqual([]);
  });
});

describe("policy binding — install/live via registry membership", () => {
  it("a live classic user assertion surfaces as the presentation identity", () => {
    registerArtifactExt(X);
    primeAssertions([sa({ artifact_id: "a1", extension: X, asserted_by: "user" })]);
    const out = resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toEqual({ kind: "extension", extension: X });
    expect(out.tier).toBe("classic");
  });

  it("an UNINSTALLED extension's assertion never wins (registry has no such type)", () => {
    // X is NOT registered ⇒ not live.
    primeAssertions([sa({ artifact_id: "a1", extension: X, asserted_by: "user" })]);
    const out = resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toEqual({ kind: "no-primary" });
  });
});

describe("policy binding — matcher threshold from the manifest", () => {
  it("honors the pack's declared matcherConfidenceThreshold", () => {
    registerArtifactExt(X, 0.5);
    primeAssertions([
      sa({ artifact_id: "a1", extension: X, asserted_by: "matcher", eligibility: "draft", confidence: 0.6 }),
    ]);
    const out = resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toEqual({ kind: "extension", extension: X }); // 0.6 >= 0.5
    expect(out.tier).toBe("matcher");
  });

  it("defaults to 0.7 when the pack declares no threshold — a 0.6 draft stays a chip", () => {
    registerArtifactExt(X); // no threshold ⇒ default 0.7
    primeAssertions([
      sa({ artifact_id: "a1", extension: X, asserted_by: "matcher", eligibility: "draft", confidence: 0.6 }),
    ]);
    const out = resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toEqual({ kind: "no-primary" });
    expect(out.suggestions).toEqual([X]);
  });
});

describe("policy binding — org auto-surface toggle", () => {
  it("the org toggle disables matcher auto-surface (draft stays a chip)", () => {
    registerArtifactExt(X, 0.5);
    setArtifactAutoSurfaceDisabled(ORG, true);
    primeAssertions([
      sa({ artifact_id: "a1", extension: X, asserted_by: "matcher", eligibility: "draft", confidence: 0.9 }),
    ]);
    const out = resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toEqual({ kind: "no-primary" });
    expect(out.tier).toBe("claim-backed");
    expect(out.suggestions).toEqual([X]);
  });
});

describe("batched multi-row resolution", () => {
  it("resolves each row independently from its own assertions", () => {
    registerArtifactExt(X);
    registerArtifactExt(Y);
    primeAssertions([
      sa({ artifact_id: "a1", extension: X, asserted_by: "user" }),
      sa({ artifact_id: "a2", extension: Y, asserted_by: "agent" }),
    ]);
    const map = resolveArtifactPresentationIdentities({
      orgId: ORG,
      rows: [
        { id: "a1", type: GENERIC },
        { id: "a2", type: GENERIC },
        { id: "a3", type: GENERIC }, // no assertions ⇒ base identity
      ],
    });
    expect(map.get("a1")!.identity).toEqual({ kind: "extension", extension: X });
    expect(map.get("a2")!.identity).toEqual({ kind: "extension", extension: Y });
    expect(map.get("a3")!.identity).toEqual({ kind: "no-primary" });
  });
});
