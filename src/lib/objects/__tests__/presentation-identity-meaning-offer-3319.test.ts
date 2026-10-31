// The type picker's derived-meaning reading at the presentation host
// (cinatra#3319; spec `specs/app-artifacts.html` §VI.1 "Derived meaning &
// suggestion chips"). The postgres runner is mocked exactly as in
// presentation-identity.host.test.ts; the REAL pure resolver decides the tiers.
// `resolveArtifactPresentationReading` answers the row's presentation AND the
// picker's offer from ONE batched read (H11 counts the reads).
//
// Round 11 (the class fold): the reading says whether it is the row's own
// answer. `complete` is false when the assertion read (H12) or the matcher-pack
// install read (H13) failed and was degraded to an empty offer, and true for a
// clean read, also when the install gate genuinely denies the pack (H14).
//
// The drawing states the rule against "the pack's threshold" and names no
// number; the threshold is the pack's channel `matcherConfidenceThreshold`
// (default 0.7, packages/objects/src/registry.ts DEFAULT_MATCHER_CONFIDENCE_THRESHOLD).
// The round that found the gap read a draft at 0.7400000095367432 (a real column
// value) on a pack at the default: these cases pin that reading.
//
//   pnpm exec vitest run src/lib/objects/__tests__/presentation-identity-meaning-offer-3319.test.ts

import { beforeEach, describe, expect, it, vi } from "vitest";

const runPostgresQueriesSync = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
const ensurePostgresSchema = vi.fn();
vi.mock("@/lib/postgres-schema-init", () => ({
  ensurePostgresSchema: (...a: unknown[]) => ensurePostgresSchema(...a),
}));
vi.mock("@/lib/postgres-config", () => ({
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://test",
}));

import { objectTypeRegistry, matcherManifestRegistry } from "@cinatra-ai/objects";
import * as host from "@/lib/objects/presentation-identity";
import {
  _resetArtifactAutoSurfaceToggleForTests,
  setArtifactAutoSurfaceDisabled,
} from "@/lib/objects/artifact-autosurface-toggle";

const ORG = "org-1";
const BASE = "@cinatra-ai/markdown-artifact:artifact";
const IDEA = "@cinatra-ai/blog-idea-artifact";
const POST = "@cinatra-ai/blog-post-artifact";

type Row = Record<string, unknown>;

function registerMatcherPack(ext: string, threshold = 0.7): void {
  matcherManifestRegistry.register({
    packageName: ext,
    matcherSkillIds: [`${ext}:matcher`],
    matcherConfidenceThreshold: threshold,
    fileMimeTypes: ["text/markdown"],
  });
}

function prime(rows: Row[] | Error, installRows: Row[] | Error = []): void {
  runPostgresQueriesSync.mockImplementation((input: { queries: Array<{ text: string }> }) => {
    const text = input.queries[0]?.text ?? "";
    if (text.includes("semantic_assertion")) {
      if (rows instanceof Error) throw rows;
      return [{ rows, rowCount: rows.length }];
    }
    if (text.includes("installed_extension")) {
      if (installRows instanceof Error) throw installRows;
      return [{ rows: installRows, rowCount: installRows.length }];
    }
    throw new Error(`unexpected query: ${text}`);
  });
}

function draft(extension: string, confidence: number | null, asserted_at = "2026-10-18T22:50:07.000Z"): Row {
  return {
    artifact_id: "a1",
    extension,
    asserted_by: "matcher",
    eligibility: "draft",
    assertion_basis: "classic",
    confidence,
    asserted_at,
  };
}

type Reading = {
  complete?: boolean;
  presentation: {
    identity: { kind: string; extension?: string };
    tier: string;
    suggestions: string[];
  };
  offer: {
    preselect: string | null;
    suggestions: Array<{ extension: string; confidence: number | null }>;
  };
};

function reading(): Reading {
  // Read through the module namespace so a missing export fails as a missing
  // reading (TypeError), the base's own reason, not as an import error.
  return (host as unknown as {
    resolveArtifactPresentationReading: (i: {
      orgId: string;
      artifactId: string;
      baseType: string;
    }) => Reading;
  }).resolveArtifactPresentationReading({ orgId: ORG, artifactId: "a1", baseType: BASE });
}

function offer(): Reading["offer"] {
  return reading().offer;
}

/** How many times the mocked bridge was asked for the semantic_assertion rows. */
function assertionReads(): number {
  return runPostgresQueriesSync.mock.calls.filter((c) =>
    String((c[0] as { queries: Array<{ text: string }> }).queries[0]?.text ?? "").includes(
      "semantic_assertion",
    ),
  ).length;
}

beforeEach(() => {
  runPostgresQueriesSync.mockReset();
  ensurePostgresSchema.mockReset();
  objectTypeRegistry._clearForTests();
  matcherManifestRegistry._clearForTests();
  _resetArtifactAutoSurfaceToggleForTests();
});

describe("cinatra#3319 — resolveArtifactPresentationReading (§VI.1 threshold rule)", () => {
  it("H1: the round's draft (0.7400000095367432 on a pack at the default 0.7) is the pre-selection, not a chip", () => {
    registerMatcherPack(IDEA);
    prime([draft(IDEA, 0.7400000095367432)]);
    expect(offer()).toEqual({ preselect: IDEA, suggestions: [] });
  });

  it("H2: a draft exactly AT the pack's threshold pre-selects (at or above)", () => {
    registerMatcherPack(IDEA, 0.7);
    prime([draft(IDEA, 0.7)]);
    expect(offer().preselect).toBe(IDEA);
  });

  it("H3: a draft BELOW the pack's threshold never pre-selects; it is a chip with its confidence", () => {
    registerMatcherPack(IDEA, 0.7);
    prime([draft(IDEA, 0.61)]);
    expect(offer()).toEqual({ preselect: null, suggestions: [{ extension: IDEA, confidence: 0.61 }] });
  });

  it("H4: the threshold is the pack's own (0.6 pre-selects on a pack at 0.5)", () => {
    registerMatcherPack(IDEA, 0.5);
    prime([draft(IDEA, 0.6)]);
    expect(offer().preselect).toBe(IDEA);
  });

  it("H5: the org toggle (escape hatch) turns a passing draft into a chip only", () => {
    registerMatcherPack(IDEA, 0.7);
    setArtifactAutoSurfaceDisabled(ORG, true);
    prime([draft(IDEA, 0.95)]);
    expect(offer()).toEqual({ preselect: null, suggestions: [{ extension: IDEA, confidence: 0.95 }] });
  });

  it("H6: a tie at the top confidence pre-selects nothing; both drafts are chips", () => {
    registerMatcherPack(IDEA, 0.7);
    registerMatcherPack(POST, 0.7);
    prime([draft(IDEA, 0.8), draft(POST, 0.8)]);
    expect(offer()).toEqual({
      preselect: null,
      suggestions: [
        { extension: IDEA, confidence: 0.8 },
        { extension: POST, confidence: 0.8 },
      ],
    });
  });

  it("H7: the winning draft pre-selects and the other stays a chip with its highest confidence", () => {
    registerMatcherPack(IDEA, 0.7);
    registerMatcherPack(POST, 0.7);
    prime([
      draft(IDEA, 0.9),
      draft(POST, 0.3, "2026-10-18T22:00:00.000Z"),
      draft(POST, 0.55, "2026-10-18T22:10:00.000Z"),
    ]);
    expect(offer()).toEqual({ preselect: IDEA, suggestions: [{ extension: POST, confidence: 0.55 }] });
  });

  it("H8: a user-sourced meaning outranks the draft: no pre-selection, the draft is a chip", () => {
    registerMatcherPack(IDEA, 0.7);
    registerMatcherPack(POST, 0.7);
    prime([
      {
        artifact_id: "a1",
        extension: POST,
        asserted_by: "user",
        eligibility: "eligible",
        assertion_basis: "classic",
        confidence: null,
        asserted_at: "2026-10-18T22:00:00.000Z",
      },
      draft(IDEA, 0.99),
    ]);
    expect(offer()).toEqual({ preselect: null, suggestions: [{ extension: IDEA, confidence: 0.99 }] });
  });

  it("H9: a draft on a pack archived for this org neither pre-selects nor chips", () => {
    registerMatcherPack(IDEA, 0.7);
    prime([draft(IDEA, 0.9)], [{ package_name: IDEA, status: "archived", organization_id: ORG }]);
    expect(offer()).toEqual({ preselect: null, suggestions: [] });
  });

  it("H10: a failed semantic_assertion read fails closed: base presentation, no pre-selection, no chips", () => {
    registerMatcherPack(IDEA, 0.7);
    prime(new Error("read down"));
    const r = reading();
    expect(r.presentation.tier).toBe("claim-backed");
    expect(r.offer).toEqual({ preselect: null, suggestions: [] });
  });

  it("H12: a failed semantic_assertion read is told apart from the row's own empty offer (complete: false)", () => {
    registerMatcherPack(IDEA, 0.7);
    prime(new Error("read down"));
    const r = reading();
    expect(r.offer).toEqual({ preselect: null, suggestions: [] });
    expect(r.complete).toBe(false);
  });

  it("H13: a failed install read degrades the draft to not live, and the reading says it is incomplete", () => {
    registerMatcherPack(IDEA, 0.7);
    prime([draft(IDEA, 0.9)], new Error("install status down"));
    const r = reading();
    expect(r.offer).toEqual({ preselect: null, suggestions: [] });
    expect(r.complete).toBe(false);
  });

  it("H14: a clean read is complete, also when the install gate genuinely denies the pack", () => {
    registerMatcherPack(IDEA, 0.7);
    prime([draft(IDEA, 0.9)]);
    expect(reading()).toMatchObject({ complete: true, offer: { preselect: IDEA } });
    prime([draft(IDEA, 0.9)], [{ package_name: IDEA, status: "archived", organization_id: ORG }]);
    expect(reading()).toMatchObject({
      complete: true,
      offer: { preselect: null, suggestions: [] },
    });
  });

  it("H11: ONE read answers both: one semantic_assertion query, and the presentation equals the row's own", () => {
    registerMatcherPack(IDEA, 0.7);
    registerMatcherPack(POST, 0.7);
    prime([draft(IDEA, 0.9), draft(POST, 0.55)]);
    const r = reading();
    expect(assertionReads()).toBe(1);
    // The same rows, read by the singular wrapper the library row and every
    // other detail reader use: the reading's presentation is exactly it.
    const row = host.resolveArtifactPresentationIdentity({ orgId: ORG, artifactId: "a1", baseType: BASE });
    expect(assertionReads()).toBe(2);
    expect(r.presentation).toEqual(row);
    // The pre-selection IS the presented identity (tier matcher), never a
    // separately decided value.
    expect(r.presentation.tier).toBe("matcher");
    expect(r.offer.preselect).toBe(r.presentation.identity.extension);
    expect(r.offer.suggestions.map((s) => s.extension)).toEqual(r.presentation.suggestions);
  });
});
