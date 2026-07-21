// Host-seam tests for the presentation-identity resolver (epic #1883 slice A6,
// meaning-surface channel cinatra#1891 A3). The postgres runner is mocked; the
// seam binds the pure resolver to:
//   - classic/binding liveness  → object-type-registry membership;
//   - matcher thresholds         → the meaning-surface channel, AUTHORITATIVELY
//     (the retired `<ext>:artifact` fallback is gone — peer-review R1 #4);
//   - matcher liveness           → channel membership AND the org-scoped
//     active-install gate mirroring the matcher runtime (peer-review R1 #5);
//   - the org auto-surface toggle.
// These prove:
//   - the batched read is a SINGLE org-scoped ACTIVE-assertion query;
//   - the pack's channel `matcherConfidenceThreshold` drives auto-surface;
//   - a structural pack NOT in the channel never threshold-passes a draft;
//   - a matcher pack archived for the org does not surface a draft;
//   - the org toggle disables tier 2;
//   - a read error fails CLOSED to the base (type-driven) identity.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const runPostgresQueriesSync = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@/lib/postgres-config", () => ({
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://test",
}));

import { objectTypeRegistry, matcherManifestRegistry } from "@cinatra-ai/objects";
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

/** Register a declared object type in `ext`'s namespace so the extension is LIVE
 * for CLASSIC/BINDING assertions (object-type-registry membership). This is NOT
 * the meaning surface — a matcher threshold comes from the channel only. */
function registerTypePack(ext: string): void {
  objectTypeRegistry.register(
    {
      type: `${ext}:doc`,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
      renderers: { listRow: null, card: null, detail: null },
    },
    ext,
  );
}

/** Register a pack's MEANING SURFACE in the channel (cinatra#1891 A3) — the
 * matcher runtime's candidate source AND the presentation host's threshold +
 * matcher-liveness source. The threshold is ALREADY RESOLVED here (the bridge
 * applies the pack default at registration), matching the runtime entry. */
function registerMatcherPack(ext: string, threshold = 0.7): void {
  matcherManifestRegistry.register({
    packageName: ext,
    matcherSkillIds: [`${ext}:matcher`],
    matcherConfidenceThreshold: threshold,
    fileMimeTypes: ["text/plain"],
  });
}

/** Prime the mocked sync runner: routes the semantic-assertion read to `rows`
 * (or throws `rows` when an Error), and the org-scoped install-status read
 * (cinatra#1891 A3) to `installRows` (default [] ⇒ ungoverned ⇒ live). */
function prime(rows: Row[] | Error, installRows: Row[] = []): void {
  runPostgresQueriesSync.mockImplementation((input: { queries: Array<{ text: string }> }) => {
    const text = input.queries[0]?.text ?? "";
    if (text.includes("semantic_assertion")) {
      if (rows instanceof Error) throw rows;
      return [{ rows, rowCount: rows.length }];
    }
    if (text.includes("installed_extension")) {
      return [{ rows: installRows, rowCount: installRows.length }];
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
  matcherManifestRegistry._clearForTests();
  _resetArtifactAutoSurfaceToggleForTests();
});

describe("active-assertion read: SQL shape + scoping", () => {
  it("is a SINGLE batched, org-scoped, NON-archived query (no matcher-pack assertion ⇒ no install read)", () => {
    prime([]);
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
    prime(new Error("connection refused"));
    registerTypePack(X); // X live, but the assertion read fails
    const out = resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toEqual({ kind: "no-primary" });
    expect(out.suggestions).toEqual([]);
  });
});

describe("policy binding — classic liveness via object-type registry membership", () => {
  it("a live classic user assertion surfaces as the presentation identity", () => {
    registerTypePack(X);
    prime([sa({ artifact_id: "a1", extension: X, asserted_by: "user" })]);
    const out = resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toEqual({ kind: "extension", extension: X });
    expect(out.tier).toBe("classic");
  });

  it("an UNINSTALLED extension's assertion never wins (registry + channel both empty)", () => {
    // X is NOT registered ⇒ not live.
    prime([sa({ artifact_id: "a1", extension: X, asserted_by: "user" })]);
    const out = resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toEqual({ kind: "no-primary" });
  });
});

describe("policy binding — matcher threshold from the meaning-surface channel", () => {
  it("honors the pack's declared matcherConfidenceThreshold", () => {
    registerMatcherPack(X, 0.5);
    prime([
      sa({ artifact_id: "a1", extension: X, asserted_by: "matcher", eligibility: "draft", confidence: 0.6 }),
    ]);
    const out = resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toEqual({ kind: "extension", extension: X }); // 0.6 >= 0.5
    expect(out.tier).toBe("matcher");
  });

  it("a channel entry resolved to the default 0.7 keeps a 0.6 draft a chip", () => {
    registerMatcherPack(X); // resolved default 0.7 (the bridge applies it)
    prime([
      sa({ artifact_id: "a1", extension: X, asserted_by: "matcher", eligibility: "draft", confidence: 0.6 }),
    ]);
    const out = resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toEqual({ kind: "no-primary" });
    expect(out.suggestions).toEqual([X]);
  });

  it("a STRUCTURAL pack NOT in the channel never threshold-passes a draft (peer-review R1 #4: no unsafe fallback)", () => {
    // X registers a structural object type (so it is classic-live) but declared
    // NO matchers ⇒ it is NOT in the channel. A forced/legacy draft on X must
    // NOT auto-surface at the old default 0.7 — the threshold is null.
    registerTypePack(X);
    prime([
      sa({ artifact_id: "a1", extension: X, asserted_by: "matcher", eligibility: "draft", confidence: 0.9 }),
    ]);
    const out = resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toEqual({ kind: "no-primary" });
    // Still a live draft (X is a live extension), so it stays a suggestion chip —
    // it just never auto-surfaces.
    expect(out.suggestions).toEqual([X]);
  });
});

describe("policy binding — matcher liveness mirrors the org-scoped install gate (peer-review R1 #5)", () => {
  it("an UNGOVERNED matcher pack (no install row) surfaces a passing draft", () => {
    registerMatcherPack(X, 0.5);
    prime(
      [sa({ artifact_id: "a1", extension: X, asserted_by: "matcher", eligibility: "draft", confidence: 0.9 })],
      [], // no install rows ⇒ ungoverned ⇒ live (CG-1 parity)
    );
    const out = resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toEqual({ kind: "extension", extension: X });
    expect(out.tier).toBe("matcher");
  });

  it("A4-seam: a USER (classic) assertion on a MATCHER-ONLY pack serves at tier-1 'classic' when org-live", () => {
    // The exact A4 picker Confirm: the pack registers NO object type (matcher-only,
    // like brand-voice); the human asserts it (assertedBy:"user", classic). Its
    // liveness is decided SOLELY by the org-scoped install gate (it is not in the
    // type-registry base set). An active org install ⇒ the classic user assertion
    // WINS tier-1 (rank 3), presenting as the pack — the picker's write and the
    // resolver's read agree (no dead pick).
    registerMatcherPack(X, 0.7); // channel-only; NO registerTypePack
    prime(
      [sa({ artifact_id: "a1", extension: X, asserted_by: "user" })],
      [{ package_name: X, status: "active", organization_id: ORG }],
    );
    const out = resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toEqual({ kind: "extension", extension: X });
    expect(out.tier).toBe("classic");
  });

  it("A4-seam: the SAME user assertion does NOT surface when the matcher-only pack is archived for the org (no dead pick)", () => {
    registerMatcherPack(X, 0.7);
    prime(
      [sa({ artifact_id: "a1", extension: X, asserted_by: "user" })],
      [{ package_name: X, status: "archived", organization_id: ORG }],
    );
    const out = resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    // Not live ⇒ the classic user assertion cannot win tier-1; falls to base.
    expect(out.identity).toEqual({ kind: "no-primary" });
    expect(out.tier).toBe("claim-backed");
  });

  it("a live org-owned install surfaces the draft", () => {
    registerMatcherPack(X, 0.5);
    prime(
      [sa({ artifact_id: "a1", extension: X, asserted_by: "matcher", eligibility: "draft", confidence: 0.9 })],
      [{ package_name: X, status: "active", organization_id: ORG }],
    );
    const out = resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toEqual({ kind: "extension", extension: X });
  });

  it("a pack ARCHIVED for this org is NOT live — the draft neither surfaces nor chips", () => {
    registerMatcherPack(X, 0.5);
    prime(
      [sa({ artifact_id: "a1", extension: X, asserted_by: "matcher", eligibility: "draft", confidence: 0.9 })],
      [{ package_name: X, status: "archived", organization_id: ORG }],
    );
    const out = resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toEqual({ kind: "no-primary" });
    expect(out.suggestions).toEqual([]); // filtered out of liveDrafts (not live)
  });

  it("a pack live ONLY for another org does not surface here (no cross-org bleed)", () => {
    registerMatcherPack(X, 0.5);
    prime(
      [sa({ artifact_id: "a1", extension: X, asserted_by: "matcher", eligibility: "draft", confidence: 0.9 })],
      [{ package_name: X, status: "active", organization_id: "org-other" }],
    );
    const out = resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toEqual({ kind: "no-primary" });
    expect(out.suggestions).toEqual([]);
  });

  it("an ambient (platform) live install governs the org", () => {
    registerMatcherPack(X, 0.5);
    prime(
      [sa({ artifact_id: "a1", extension: X, asserted_by: "matcher", eligibility: "draft", confidence: 0.9 })],
      [{ package_name: X, status: "active", organization_id: null }],
    );
    const out = resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toEqual({ kind: "extension", extension: X });
  });

  it("a DUAL-registry pack (object type AND channel) archived for the org does NOT bypass the gate via type membership", () => {
    // X registers an own-namespace object type (⇒ it is in the type-registry base
    // live set) AND declares matchers (⇒ it is a channel pack). Archived for this
    // org, the org-scoped gate must WIN — the type-registry membership must not
    // keep the matcher draft surfacing (codex implementation-round #1).
    registerTypePack(X);
    registerMatcherPack(X, 0.5);
    prime(
      [sa({ artifact_id: "a1", extension: X, asserted_by: "matcher", eligibility: "draft", confidence: 0.9 })],
      [{ package_name: X, status: "archived", organization_id: ORG }],
    );
    const out = resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toEqual({ kind: "no-primary" });
    expect(out.suggestions).toEqual([]); // not live ⇒ not even a chip
  });

  it("a DUAL-registry pack ACTIVE for the org surfaces (gate approves; parity with type membership)", () => {
    registerTypePack(X);
    registerMatcherPack(X, 0.5);
    prime(
      [sa({ artifact_id: "a1", extension: X, asserted_by: "matcher", eligibility: "draft", confidence: 0.9 })],
      [{ package_name: X, status: "active", organization_id: ORG }],
    );
    const out = resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: GENERIC });
    expect(out.identity).toEqual({ kind: "extension", extension: X });
    expect(out.tier).toBe("matcher");
  });
});

describe("policy binding — org auto-surface toggle", () => {
  it("the org toggle disables matcher auto-surface (draft stays a chip)", () => {
    registerMatcherPack(X, 0.5);
    setArtifactAutoSurfaceDisabled(ORG, true);
    prime([
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
    registerTypePack(X);
    registerTypePack(Y);
    prime([
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
