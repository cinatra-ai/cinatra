/**
 * ENABLER 0.15 — THE SUGGESTION PROJECTOR, DECLARED BY THE KIND
 * (`PLAN: Agents Lifecycle (C)` §4.1, cinatra#3028 / epic #3023 — the projector
 * half of cinatra#2950).
 *
 * THE PLAN'S SENTENCE, VERBATIM: "The suggestion projector, declared by the
 * kind: an artifact extension may declare, beside its display, a suggestion
 * projector for its type; the host resolves it by kind when it opens a gate — on
 * the single-artifact path and the batch path alike — and a kind without one
 * yields no suggestions, recorded as such. The snapshot is multi-target: one
 * snapshot per gate holding a payload per pinned target, produced by each
 * target's own kind projector, so a batch gate with several kinds is served
 * alike and the batch decision stays one all-or-nothing boundary; the card draws
 * the chips per target inside that target's panel."
 *
 * WHAT IT FIXES, VERBATIM: "the production auto-gate hands the suggestion lane
 * the identity-only projector and the batch path skips the lane, so a real gate
 * normally has no suggestion snapshot; no kind-to-projector resolver exists; and
 * the producer's single-target snapshot makes a second target return
 * already-bound — the drawn suggestion states cannot arise on a real run."
 *
 * THIS IS ACCEPTANCE ITEM 3's contract half. The production-path half — a
 * fixture kind's projector producing snapshots through the real run, artifact
 * and gate road on BOTH paths — is
 * `packages/agents/src/__tests__/lifecycle-c-w4-suggestion-projector.integration.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  GATE_SUGGESTION_SNAPSHOT_SCHEMA_VERSION,
  GATE_SUGGESTION_SNAPSHOT_SCHEMA_VERSION_MULTI_TARGET,
  MAX_GATE_SUGGESTIONS,
  buildGateSuggestions,
  buildMultiTargetGateSuggestions,
  gateSuggestionSnapshotHash,
  isMultiTargetSnapshotPayload,
  snapshotSuggestions,
  snapshotTargetPayloads,
  verifyGateSuggestionSnapshotPayload,
  type MultiTargetSuggestionInput,
} from "@/lib/lifecycle/lifecycle-suggestion-producer";
import {
  __clearSuggestionProjectorsForTest,
  listRegisteredSuggestionProjectorKinds,
  registerSuggestionProjector,
  resolveSuggestionProjectorForKind,
} from "@/lib/lifecycle/suggestion-projector-registry";

const DRAFT_KIND = "@cinatra-ai/blog-post-artifact:post";
const IMAGE_KIND = "@cinatra-ai/blog-image-artifact:image";

/** A target whose disclosed lead needs canonicalizing — R1 fires on it. */
function entry(
  artifactId: string,
  kind: string,
  projectorId: string | null,
  lead = "  a draft with trailing space  ",
): MultiTargetSuggestionInput {
  return {
    target: { artifactId, representationRevisionId: `rev-${artifactId}` },
    kind,
    projectorId,
    projection: { includedFields: { lead }, excludedFields: ["artifact.content"] },
    authzDecision: "authorized",
  };
}

afterEach(() => __clearSuggestionProjectorsForTest());

describe("0.15 — the host resolves the projector BY KIND", () => {
  it("resolves the projector an extension declared for its type", () => {
    registerSuggestionProjector({
      typeId: DRAFT_KIND,
      projectorId: "@cinatra-ai/blog-post-artifact#draft",
      create: () => () => ({
        projection: { includedFields: { title: "x " }, excludedFields: [] },
        authzDecision: "authorized",
      }),
    });
    expect(resolveSuggestionProjectorForKind(DRAFT_KIND)?.projectorId).toBe(
      "@cinatra-ai/blog-post-artifact#draft",
    );
    expect(listRegisteredSuggestionProjectorKinds()).toEqual([DRAFT_KIND]);
  });

  it("a kind that declares none resolves to null — an answer, not a failure", () => {
    expect(resolveSuggestionProjectorForKind(IMAGE_KIND)).toBeNull();
  });

  it("a second declaration for one kind REPLACES the first — one live projector per kind", () => {
    const make = (id: string) => ({
      typeId: DRAFT_KIND,
      projectorId: id,
      create: () => () => ({
        projection: { includedFields: {}, excludedFields: [] },
        authzDecision: "authorized" as const,
      }),
    });
    registerSuggestionProjector(make("a"));
    registerSuggestionProjector(make("b"));
    expect(resolveSuggestionProjectorForKind(DRAFT_KIND)?.projectorId).toBe("b");
    expect(listRegisteredSuggestionProjectorKinds()).toEqual([DRAFT_KIND]);
  });
});

describe("0.15 — the snapshot is multi-target", () => {
  it("holds one payload per pinned target, each naming its kind and projector", () => {
    const built = buildMultiTargetGateSuggestions({
      targets: [
        entry("art-a", DRAFT_KIND, "@cinatra-ai/blog-post-artifact#draft"),
        entry("art-b", DRAFT_KIND, "@cinatra-ai/blog-post-artifact#draft", " another  "),
      ],
    });
    expect(isMultiTargetSnapshotPayload(built.payload)).toBe(true);
    expect(built.payload.schemaVersion).toBe(GATE_SUGGESTION_SNAPSHOT_SCHEMA_VERSION_MULTI_TARGET);
    expect(built.payload.targets.map((t) => t.target.artifactId)).toEqual(["art-a", "art-b"]);
    for (const t of built.payload.targets) {
      expect(t.kind).toBe(DRAFT_KIND);
      expect(t.projectorId).toBe("@cinatra-ai/blog-post-artifact#draft");
      expect(t.suggestions.length).toBeGreaterThan(0);
      // The provenance names the target's OWN revision, never the gate's first.
      expect(t.provenance.targetRevisionId).toBe(t.target.representationRevisionId);
    }
  });

  it("serves a batch gate with SEVERAL KINDS alike", () => {
    const built = buildMultiTargetGateSuggestions({
      targets: [
        entry("art-draft", DRAFT_KIND, "@cinatra-ai/blog-post-artifact#draft"),
        entry("art-image", IMAGE_KIND, "@cinatra-ai/blog-image-artifact#image", " caption "),
      ],
    });
    expect(built.payload.targets.map((t) => t.kind)).toEqual([DRAFT_KIND, IMAGE_KIND]);
    expect(built.suggestions.length).toBe(2);
  });

  it("records a kind WITHOUT a projector: null projector, no suggestions, entry still present", () => {
    const built = buildMultiTargetGateSuggestions({
      targets: [
        entry("art-draft", DRAFT_KIND, "@cinatra-ai/blog-post-artifact#draft"),
        entry("art-image", IMAGE_KIND, null),
      ],
    });
    const image = built.payload.targets.find((t) => t.target.artifactId === "art-image")!;
    expect(image.projectorId).toBeNull();
    expect(image.suggestions).toEqual([]);
    // "Recorded as such": the entry EXISTS, so a target with no chips reads as
    // "this kind declares no projector", never as "the producer never ran".
    expect(built.payload.targets).toHaveLength(2);
  });

  it("gives two targets with IDENTICAL projections distinct suggestion ids", () => {
    const built = buildMultiTargetGateSuggestions({
      targets: [
        entry("art-a", DRAFT_KIND, "p", "  same  "),
        entry("art-b", DRAFT_KIND, "p", "  same  "),
      ],
    });
    const ids = built.suggestions.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    // A duplicated id would make "which one was accepted" unanswerable, so the
    // reader refuses such a payload outright.
    expect(verifyGateSuggestionSnapshotPayload(built.payload)).not.toBeNull();
  });

  it("bounds the SNAPSHOT, not each target, and records the truncation once", () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 40; i++) wide[`field${i}`] = `  value ${i}  `;
    const one = (id: string): MultiTargetSuggestionInput => ({
      target: { artifactId: id, representationRevisionId: `rev-${id}` },
      kind: DRAFT_KIND,
      projectorId: "p",
      projection: { includedFields: wide, excludedFields: [] },
      authzDecision: "authorized",
    });
    const built = buildMultiTargetGateSuggestions({ targets: [one("a"), one("b")] });
    expect(built.suggestions.length).toBe(MAX_GATE_SUGGESTIONS);
    expect(built.payload.truncated).toBe(true);
    expect(verifyGateSuggestionSnapshotPayload(built.payload)).not.toBeNull();
  });
});

describe("0.15 — both payload shapes are read through one accessor", () => {
  it("the single-target payload still verifies, unchanged", () => {
    const built = buildGateSuggestions({
      target: { artifactId: "art-a", representationRevisionId: "rev-a" },
      projection: { includedFields: { lead: "  x  " }, excludedFields: [] },
      authzDecision: "authorized",
    });
    expect(built.payload.schemaVersion).toBe(GATE_SUGGESTION_SNAPSHOT_SCHEMA_VERSION);
    expect(verifyGateSuggestionSnapshotPayload(built.payload)).toEqual(built.payload);
    expect(snapshotSuggestions(built.payload)).toEqual(built.suggestions);
    const halves = snapshotTargetPayloads(built.payload);
    expect(halves).toHaveLength(1);
    expect(halves[0]!.target.artifactId).toBe("art-a");
  });

  it("a single-target derivation's ids are byte-identical to before the scope existed", () => {
    // The id material folds an EMPTY scope in as nothing, so every snapshot
    // already stored still matches a re-derivation and an idempotent re-write
    // stays idempotent rather than turning into `already-bound`.
    const built = buildGateSuggestions({
      target: { artifactId: "art-a", representationRevisionId: "rev-a" },
      projection: { includedFields: { lead: "  x  " }, excludedFields: [] },
      authzDecision: "authorized",
    });
    const again = buildGateSuggestions({
      target: { artifactId: "art-a", representationRevisionId: "rev-a" },
      projection: { includedFields: { lead: "  x  " }, excludedFields: [] },
      authzDecision: "authorized",
      idScope: "",
    });
    expect(again.payload.snapshotHash).toBe(built.payload.snapshotHash);
  });

  it("flattens a multi-target payload in the payload's own order", () => {
    const built = buildMultiTargetGateSuggestions({
      targets: [entry("art-a", DRAFT_KIND, "p"), entry("art-b", DRAFT_KIND, "p", " b ")],
    });
    expect(snapshotSuggestions(built.payload)).toEqual([
      ...built.payload.targets[0]!.suggestions,
      ...built.payload.targets[1]!.suggestions,
    ]);
  });
});

describe("0.15 — the reader refuses an inconsistent multi-target payload", () => {
  function rehash(payload: Record<string, unknown>): Record<string, unknown> {
    const { snapshotHash, ...rest } = payload;
    void snapshotHash;
    return { ...rest, snapshotHash: gateSuggestionSnapshotHash(rest as never) };
  }

  it("refuses an unknown schema version rather than guessing", () => {
    const built = buildMultiTargetGateSuggestions({ targets: [entry("art-a", DRAFT_KIND, "p")] });
    expect(
      verifyGateSuggestionSnapshotPayload(rehash({ ...built.payload, schemaVersion: 3 })),
    ).toBeNull();
  });

  it("refuses a payload with NO targets", () => {
    const built = buildMultiTargetGateSuggestions({ targets: [entry("art-a", DRAFT_KIND, "p")] });
    expect(verifyGateSuggestionSnapshotPayload(rehash({ ...built.payload, targets: [] }))).toBeNull();
  });

  it("refuses two entries for one pinned target", () => {
    const built = buildMultiTargetGateSuggestions({ targets: [entry("art-a", DRAFT_KIND, "p")] });
    const doubled = rehash({
      ...built.payload,
      targets: [built.payload.targets[0], built.payload.targets[0]],
    });
    expect(verifyGateSuggestionSnapshotPayload(doubled)).toBeNull();
  });

  it("refuses a null projector that nonetheless carries suggestions", () => {
    const built = buildMultiTargetGateSuggestions({ targets: [entry("art-a", DRAFT_KIND, "p")] });
    const lying = rehash({
      ...built.payload,
      targets: [{ ...built.payload.targets[0], projectorId: null }],
    });
    expect(verifyGateSuggestionSnapshotPayload(lying)).toBeNull();
  });

  it("refuses a target whose provenance names another revision", () => {
    const built = buildMultiTargetGateSuggestions({ targets: [entry("art-a", DRAFT_KIND, "p")] });
    const skewed = rehash({
      ...built.payload,
      targets: [
        {
          ...built.payload.targets[0],
          provenance: { ...built.payload.targets[0]!.provenance, targetRevisionId: "rev-other" },
        },
      ],
    });
    expect(verifyGateSuggestionSnapshotPayload(skewed)).toBeNull();
  });

  it("refuses a moved payload — the hash still binds the bytes", () => {
    const built = buildMultiTargetGateSuggestions({ targets: [entry("art-a", DRAFT_KIND, "p")] });
    const tampered = {
      ...built.payload,
      targets: [
        {
          ...built.payload.targets[0],
          suggestions: [
            { ...built.payload.targets[0]!.suggestions[0], value: "smuggled" },
          ],
        },
      ],
    };
    expect(verifyGateSuggestionSnapshotPayload(tampered)).toBeNull();
  });
});
