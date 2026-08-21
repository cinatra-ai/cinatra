/**
 * cinatra#2570 (epic #2564 S6a) — the PURE suggestion producer.
 *
 * What these cases defend, in the order the producer's contract states it:
 *
 *   DISCLOSURE   the producer proposes ONLY over fields it was disclosed, and a
 *                denied disclosure proposes nothing at all.
 *   PROVENANCE   every snapshot carries the #2042 provenance — target revision,
 *                projection digest, both field lists, the authz decision, the
 *                lane id.
 *   HASH BINDING the payload hashes over its own content, the hash is stable
 *                across re-runs, and a payload edited after the fact fails
 *                verification instead of reading as a different set.
 *   ORDER        replaces and adds run before removes, and removes descend — the
 *                property that keeps sequential array patches from misaligning.
 *   FIXPOINT     applying the suggestions and re-projecting yields nothing. A
 *                producer that oscillated would re-propose the same gate forever.
 *
 * Run: pnpm exec vitest run src/lib/lifecycle/__tests__/lifecycle-suggestion-producer.test.ts
 */
import { describe, it, expect } from "vitest";

import {
  buildGateSuggestions,
  canonicalFieldValue,
  gateSuggestionSnapshotHash,
  verifyGateSuggestionSnapshotPayload,
  GATE_SUGGESTION_SNAPSHOT_SCHEMA_VERSION,
  MAX_GATE_SUGGESTIONS,
  MAX_SUGGESTION_VALUE_CHARS,
  SUGGESTION_PRODUCER_LANE_ID,
  type ProducedSuggestion,
} from "../lifecycle-suggestion-producer";
import { projectionDigest } from "../lifecycle-core-analysis";

const TARGET = { artifactId: "art-1", representationRevisionId: "rev-1" };

function build(
  includedFields: Record<string, string>,
  opts: { excludedFields?: string[]; authzDecision?: "authorized" | "partial" | "denied" } = {},
) {
  return buildGateSuggestions({
    target: TARGET,
    projection: {
      includedFields,
      excludedFields: opts.excludedFields ?? [],
    },
    authzDecision: opts.authzDecision ?? "authorized",
  });
}

function ops(suggestions: ProducedSuggestion[]): string[] {
  return suggestions.map((s) => `${s.op} ${s.fieldPath}`);
}

describe("canonicalFieldValue", () => {
  it("strips trailing whitespace per line and surrounds, keeping structure", () => {
    expect(canonicalFieldValue("  hello  ")).toBe("hello");
    expect(canonicalFieldValue("a  b")).toBe("a  b"); // interior spacing survives
    expect(canonicalFieldValue("line1   \nline2\t\n")).toBe("line1\nline2");
  });

  it("removes strippable control characters but keeps tab, LF and CR", () => {
    expect(canonicalFieldValue("a\u0000bc")).toBe("abc");
    expect(canonicalFieldValue("a\tb\nc")).toBe("a\tb\nc");
  });

  it("is idempotent", () => {
    const messy = "  x \u0001 \n  y   \n";
    expect(canonicalFieldValue(canonicalFieldValue(messy))).toBe(canonicalFieldValue(messy));
  });
});

describe("§VIII's before/after pair (cinatra#2852)", () => {
  it("R1 captures the DISCLOSED text beside the canonicalization it proposes", () => {
    // The fixture's before differs from its after on every axis the rule
    // touches: a stray control character, per-line trailing whitespace, and
    // surrounding whitespace.
    const disclosed = "  Re-connecting on Q3\u0001 priorities   \n second line   ";
    const { suggestions } = build({ subject: disclosed });
    expect(suggestions).toHaveLength(1);
    const [s] = suggestions;
    expect(s.op).toBe("replace");
    expect(s.before).toBe(disclosed);
    expect(s.value).toBe(canonicalFieldValue(disclosed));
    expect(s.before).not.toBe(s.value);
  });

  it("the pair is FROZEN into the snapshot, and the snapshot still hash-verifies", () => {
    const { payload } = build({ subject: "  trailing  " });
    expect(payload.suggestions[0].before).toBe("  trailing  ");
    expect(verifyGateSuggestionSnapshotPayload(payload)).not.toBeNull();
  });

  it("a rule with nothing to show carries NO before — never an invented one", () => {
    // R2 removes a whole member (no single current value) and R3 adds a field
    // that does not exist yet (nothing it currently says).
    const { suggestions } = build({
      "items.0.title": "First",
      "items.0.subtitle": "with a subtitle",
      "items.1.title": "Second",
      "items.2.title": "   ",
      "items.2.subtitle": "",
    });
    for (const s of suggestions.filter((x) => x.op !== "replace")) {
      expect(s.before).toBeUndefined();
    }
    expect(suggestions.some((s) => s.op === "add")).toBe(true);
    expect(suggestions.some((s) => s.op === "remove")).toBe(true);
  });

  it("a disclosed value past the shared ceiling is SUGGESTED without a before, not truncated", () => {
    // The canonicalization fits; the disclosed text does not. Half a field is
    // worse than no field, so the panel is dropped and the suggestion stands.
    const disclosed = `${"x".repeat(MAX_SUGGESTION_VALUE_CHARS)}   `;
    const { suggestions } = build({ body: disclosed });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].value).toBe("x".repeat(MAX_SUGGESTION_VALUE_CHARS));
    expect(suggestions[0].before).toBeUndefined();
  });

  it("a stored payload whose before is past the ceiling reads as UNREADABLE", () => {
    const { payload } = build({ subject: "  trailing  " });
    const tampered = {
      ...payload,
      suggestions: [{ ...payload.suggestions[0], before: "y".repeat(MAX_SUGGESTION_VALUE_CHARS + 1) }],
    };
    expect(verifyGateSuggestionSnapshotPayload(tampered)).toBeNull();
  });

  it("a pre-#2852 snapshot (no before anywhere) still verifies — absence is legal", () => {
    const { payload } = build({ subject: "  trailing  " });
    const legacy = {
      ...payload,
      suggestions: payload.suggestions.map((s) => {
        const rest = { ...s };
        delete rest.before;
        return rest;
      }),
    };
    const rehashed = { ...legacy, snapshotHash: gateSuggestionSnapshotHash({
      schemaVersion: legacy.schemaVersion,
      laneId: legacy.laneId,
      target: legacy.target,
      provenance: legacy.provenance,
      suggestions: legacy.suggestions,
      truncated: legacy.truncated,
    }) };
    const verified = verifyGateSuggestionSnapshotPayload(rehashed);
    expect(verified).not.toBeNull();
    expect(verified!.suggestions[0].before).toBeUndefined();
  });
});

describe("disclosure", () => {
  it("proposes nothing when the host denied disclosure — and still records the denial", () => {
    const out = build({ title: "  needs trimming  " }, { authzDecision: "denied" });
    expect(out.suggestions).toEqual([]);
    expect(out.provenance.authzDecision).toBe("denied");
    expect(out.provenance.includedFields).toEqual(["title"]);
  });

  it("proposes nothing over an empty projection", () => {
    expect(build({}).suggestions).toEqual([]);
  });

  it("never proposes over an EXCLUDED field — it is named, never read", () => {
    const out = build({ title: " x " }, { excludedFields: ["body", "secret"] });
    expect(out.provenance.excludedFields).toEqual(["body", "secret"]);
    expect(out.suggestions.every((s) => !s.fieldPath.includes("body"))).toBe(true);
    expect(out.suggestions.every((s) => !s.fieldPath.includes("secret"))).toBe(true);
  });

  it("leaves a top-level empty field alone — the lane has nothing to put there", () => {
    expect(build({ title: "", body: "" }).suggestions).toEqual([]);
  });
});

describe("provenance", () => {
  it("carries the target revision, digest, field lists, authz decision and lane id", () => {
    const included = { title: "  x  ", body: "ok" };
    const out = build(included, { excludedFields: ["attachment"], authzDecision: "partial" });
    expect(out.provenance).toEqual({
      laneId: SUGGESTION_PRODUCER_LANE_ID,
      targetArtifactId: "art-1",
      targetRevisionId: "rev-1",
      projectionDigest: projectionDigest(included),
      includedFields: ["body", "title"],
      excludedFields: ["attachment"],
      authzDecision: "partial",
    });
  });

  it("binds the payload target to the pinned revision it was built for", () => {
    const out = build({ title: " x " });
    expect(out.payload.target).toEqual(TARGET);
    expect(out.payload.laneId).toBe(SUGGESTION_PRODUCER_LANE_ID);
    expect(out.payload.schemaVersion).toBe(GATE_SUGGESTION_SNAPSHOT_SCHEMA_VERSION);
  });
});

describe("R1 — normalization replace", () => {
  it("proposes the canonicalization of the disclosed text, never invented prose", () => {
    const out = build({ title: "  Hello  " });
    expect(out.suggestions).toHaveLength(1);
    const [s] = out.suggestions;
    expect(s!.op).toBe("replace");
    expect(s!.fieldPath).toBe("/title");
    expect(s!.value).toBe("Hello");
  });

  it("says nothing about a field that is already canonical", () => {
    expect(build({ title: "Hello", body: "line1\nline2" }).suggestions).toEqual([]);
  });

  it("SKIPS rather than truncates a canonicalization past the value bound", () => {
    const long = `${"a".repeat(MAX_SUGGESTION_VALUE_CHARS + 10)}   `;
    expect(build({ body: long }).suggestions).toEqual([]);
  });

  it("drops a path whose segment is a prototype-mutation key", () => {
    expect(build({ "a.__proto__.b": "  x  " }).suggestions).toEqual([]);
  });
});

describe("R2 — remove an entirely empty collection member", () => {
  it("removes the member whole and says nothing about its individual fields", () => {
    const out = build({
      "items.0.title": "kept",
      "items.0.body": "kept",
      "items.1.title": "   ",
      "items.1.body": "",
    });
    expect(ops(out.suggestions)).toEqual(["remove /items/1"]);
  });

  it("does not remove a member that carries anything", () => {
    const out = build({ "items.0.title": "x", "items.1.title": "y" });
    expect(out.suggestions).toEqual([]);
  });
});

describe("R3 — add a key the siblings carry", () => {
  it("adds the missing key with an EMPTY value, never a guess", () => {
    const out = build({
      "items.0.title": "a",
      "items.0.subtitle": "sub",
      "items.1.title": "b",
    });
    expect(ops(out.suggestions)).toEqual(["add /items/1/subtitle"]);
    expect(out.suggestions[0]!.value).toBe("");
  });

  it("does not propagate a key no sibling actually carries", () => {
    const out = build({
      "items.0.title": "a",
      "items.0.subtitle": "",
      "items.1.title": "b",
    });
    expect(out.suggestions).toEqual([]);
  });
});

describe("ordering", () => {
  it("runs replaces, then adds, then removes in DESCENDING index order", () => {
    const out = build({
      "items.0.title": " a ",
      "items.0.subtitle": "sub",
      "items.1.title": "b",
      "items.2.title": "",
      "items.2.subtitle": "  ",
      "items.3.title": " ",
      "items.3.subtitle": "",
    });
    expect(ops(out.suggestions)).toEqual([
      "replace /items/0/title",
      "add /items/1/subtitle",
      "remove /items/3",
      "remove /items/2",
    ]);
  });
});

describe("determinism + hash binding", () => {
  it("is byte-identical across runs over the same projection", () => {
    const included = { "items.0.title": " a ", "items.1.title": "b" };
    expect(build(included).payload).toEqual(build(included).payload);
  });

  it("does not depend on the ORDER the projection keys were built in", () => {
    const a = build({ "b.0.x": " 1 ", "a.0.x": " 2 " });
    const b = build({ "a.0.x": " 2 ", "b.0.x": " 1 " });
    expect(a.payload.snapshotHash).toBe(b.payload.snapshotHash);
  });

  it("changes the hash when the disclosed content changes", () => {
    expect(build({ title: " a " }).payload.snapshotHash).not.toBe(
      build({ title: " b " }).payload.snapshotHash,
    );
  });

  it("verifies a well-formed payload and REFUSES one edited after the fact", () => {
    const { payload } = build({ title: " x " });
    expect(verifyGateSuggestionSnapshotPayload(payload)).toEqual(payload);

    const tampered = {
      ...payload,
      suggestions: [
        ...payload.suggestions,
        { id: "sug_forged", fieldPath: "/other", op: "replace", value: "x", message: "m" },
      ],
    };
    expect(verifyGateSuggestionSnapshotPayload(tampered)).toBeNull();
  });

  it("refuses a payload from an unknown schema version", () => {
    const { payload } = build({ title: " x " });
    const bumped = { ...payload, schemaVersion: 99 };
    expect(verifyGateSuggestionSnapshotPayload(bumped)).toBeNull();
  });

  it("hashes over everything except the hash itself", () => {
    const { payload } = build({ title: " x " });
    const { snapshotHash, ...unhashed } = payload;
    expect(gateSuggestionSnapshotHash(unhashed)).toBe(snapshotHash);
  });
});

describe("bounds", () => {
  it("caps the snapshot and RECORDS the truncation", () => {
    const included: Record<string, string> = {};
    for (let i = 0; i < MAX_GATE_SUGGESTIONS + 5; i++) included[`f${i}`] = ` v${i} `;
    const out = build(included);
    expect(out.suggestions).toHaveLength(MAX_GATE_SUGGESTIONS);
    expect(out.payload.truncated).toBe(true);
  });

  it("does not claim truncation when nothing was dropped", () => {
    expect(build({ title: " x " }).payload.truncated).toBe(false);
  });
});

describe("fixpoint", () => {
  /** Re-project the field map as it would look after the suggestions applied. */
  function applyToProjection(
    included: Record<string, string>,
    suggestions: ProducedSuggestion[],
  ): Record<string, string> {
    const next: Record<string, string> = { ...included };
    for (const s of suggestions) {
      const dotted = s.fieldPath
        .slice(1)
        .split("/")
        .map((seg) => seg.replaceAll("~1", "/").replaceAll("~0", "~"))
        .join(".");
      if (s.op === "replace" || s.op === "add") {
        next[dotted] = s.value ?? "";
      } else {
        for (const key of Object.keys(next)) {
          if (key === dotted || key.startsWith(`${dotted}.`)) delete next[key];
        }
      }
    }
    return next;
  }

  it("proposes nothing on a second pass over the applied result", () => {
    const included = {
      "items.0.title": " a ",
      "items.0.subtitle": "sub",
      "items.1.title": "b",
      "items.2.title": "",
      "items.2.subtitle": "  ",
      lead: "  headline  ",
    };
    const first = build(included);
    expect(first.suggestions.length).toBeGreaterThan(0);
    const second = build(applyToProjection(included, first.suggestions));
    expect(second.suggestions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Codex convergence round 1 (cinatra#2570) — the cases the review found missing.
// Each one is a defect that shipped in the first draft, so each keeps its own
// name rather than being folded into the blocks above.
// ---------------------------------------------------------------------------

describe("removal ordering is NUMERIC, not lexicographic", () => {
  it("removes /items/10 before /items/2 — string order would splice the wrong member", () => {
    const included: Record<string, string> = {};
    for (let i = 0; i < 12; i++) included[`items.${i}.title`] = i === 2 || i === 10 ? "" : `t${i}`;
    const out = build(included);
    expect(ops(out.suggestions)).toEqual(["remove /items/10", "remove /items/2"]);
  });

  it("orders replaces by index too, so a fixture never depends on string collation", () => {
    const included: Record<string, string> = {};
    for (const i of [2, 10]) included[`items.${i}.title`] = ` t${i} `;
    const out = build(included);
    expect(ops(out.suggestions)).toEqual([
      "replace /items/2/title",
      "replace /items/10/title",
    ]);
  });
});

describe("R2 never deletes what the lane was not shown", () => {
  const emptyMember = {
    "items.0.title": "kept",
    "items.1.title": "",
  };

  it("removes the empty member under FULL disclosure", () => {
    expect(ops(build(emptyMember).suggestions)).toEqual(["remove /items/1"]);
  });

  it("proposes NO removal when any field was withheld", () => {
    const out = build(emptyMember, { excludedFields: ["items.1.body"] });
    expect(out.suggestions).toEqual([]);
  });

  it("proposes NO removal on a PARTIAL authorization", () => {
    const out = build(emptyMember, { authzDecision: "partial" });
    expect(out.suggestions).toEqual([]);
  });
});

describe("R3 proposes only DIRECT keys", () => {
  it("does not propose a nested key whose parent container may not exist", () => {
    const out = build({
      "items.0.title": "a",
      "items.0.meta.label": "deep",
      "items.1.title": "b",
    });
    // `/items/1/meta/label` would throw in the apply transform — `items[1].meta`
    // does not exist and the transform creates no intermediate containers.
    expect(out.suggestions).toEqual([]);
  });

  it("still proposes the direct sibling key next to a nested one", () => {
    const out = build({
      "items.0.title": "a",
      "items.0.subtitle": "sub",
      "items.0.meta.label": "deep",
      "items.1.title": "b",
    });
    expect(ops(out.suggestions)).toEqual(["add /items/1/subtitle"]);
  });
});

describe("truncation is convergent, and says so", () => {
  it("a truncated snapshot converges over further passes instead of oscillating", () => {
    const included: Record<string, string> = {};
    for (let i = 0; i < MAX_GATE_SUGGESTIONS + 7; i++) included[`f${i.toString().padStart(3, "0")}`] = ` v${i} `;
    const first = build(included);
    expect(first.payload.truncated).toBe(true);

    const applied = { ...included };
    for (const s of first.suggestions) {
      applied[s.fieldPath.slice(1)] = s.value ?? "";
    }
    const second = build(applied);
    // Strictly fewer findings remain, and the tail is reachable — a producer
    // that re-proposed the SAME fields would be the oscillation the contract
    // forbids.
    expect(second.suggestions.length).toBe(7);
    expect(second.payload.truncated).toBe(false);
    const firstPaths = new Set(first.suggestions.map((s) => s.fieldPath));
    expect(second.suggestions.every((s) => !firstPaths.has(s.fieldPath))).toBe(true);
  });
});

describe("verification enforces the payload's INTERNAL consistency", () => {
  it("refuses a payload whose provenance names a different revision", () => {
    const { payload } = build({ title: " x " });
    const drifted = {
      ...payload,
      provenance: { ...payload.provenance, targetRevisionId: "rev-somewhere-else" },
    };
    const rehashed = { ...drifted, snapshotHash: gateSuggestionSnapshotHash(stripHash(drifted)) };
    expect(verifyGateSuggestionSnapshotPayload(rehashed)).toBeNull();
  });

  it("refuses a payload whose provenance names a different artifact", () => {
    const { payload } = build({ title: " x " });
    const drifted = {
      ...payload,
      provenance: { ...payload.provenance, targetArtifactId: "art-somewhere-else" },
    };
    const rehashed = { ...drifted, snapshotHash: gateSuggestionSnapshotHash(stripHash(drifted)) };
    expect(verifyGateSuggestionSnapshotPayload(rehashed)).toBeNull();
  });

  it("refuses a payload whose provenance names a different lane", () => {
    const { payload } = build({ title: " x " });
    const drifted = { ...payload, provenance: { ...payload.provenance, laneId: "some-agent" } };
    const rehashed = { ...drifted, snapshotHash: gateSuggestionSnapshotHash(stripHash(drifted)) };
    expect(verifyGateSuggestionSnapshotPayload(rehashed)).toBeNull();
  });

  it("refuses duplicate suggestion ids — `accepted ⊆ surfaced` needs them distinct", () => {
    const { payload } = build({ title: " x " });
    const dup = { ...payload, suggestions: [payload.suggestions[0]!, payload.suggestions[0]!] };
    const rehashed = { ...dup, snapshotHash: gateSuggestionSnapshotHash(stripHash(dup)) };
    expect(verifyGateSuggestionSnapshotPayload(rehashed)).toBeNull();
  });

  it("refuses a replace with no value and a remove that carries one", () => {
    const { payload } = build({ title: " x " });
    const malformed: ProducedSuggestion[] = [
      { id: "sug_a", fieldPath: "/t", op: "replace", message: "m" },
      { id: "sug_b", fieldPath: "/t", op: "remove", value: "x", message: "m" },
    ];
    for (const bad of malformed) {
      const broken = { ...payload, suggestions: [bad] };
      const rehashed = { ...broken, snapshotHash: gateSuggestionSnapshotHash(stripHash(broken)) };
      expect(verifyGateSuggestionSnapshotPayload(rehashed)).toBeNull();
    }
  });

  it("refuses a pointer whose decoded segment is a prototype-mutation key", () => {
    const { payload } = build({ title: " x " });
    const broken = {
      ...payload,
      suggestions: [
        {
          id: "sug_p",
          fieldPath: "/__proto__/x",
          op: "replace",
          value: "1",
          message: "m",
        } satisfies ProducedSuggestion,
      ],
    };
    const rehashed = { ...broken, snapshotHash: gateSuggestionSnapshotHash(stripHash(broken)) };
    expect(verifyGateSuggestionSnapshotPayload(rehashed)).toBeNull();
  });

  it("refuses a suggestion list past the snapshot bound", () => {
    const { payload } = build({ title: " x " });
    const flooded = {
      ...payload,
      suggestions: Array.from({ length: MAX_GATE_SUGGESTIONS + 1 }, (_, i) => ({
        id: `sug_${i}`,
        fieldPath: `/f${i}`,
        op: "replace" as const,
        value: "v",
        message: "m",
      })),
    };
    const rehashed = { ...flooded, snapshotHash: gateSuggestionSnapshotHash(stripHash(flooded)) };
    expect(verifyGateSuggestionSnapshotPayload(rehashed)).toBeNull();
  });
});

function stripHash<T extends { snapshotHash: string }>(p: T): Omit<T, "snapshotHash"> {
  const rest = { ...p } as Record<string, unknown>;
  delete rest.snapshotHash;
  return rest as Omit<T, "snapshotHash">;
}
