/**
 * The canonical accepted/dismissed partition (cinatra#2571, epic #2564 S6b).
 *
 * The identity of a suggestion decision lives here: normalization is what makes
 * two submits of the same choices fingerprint identically (so a response-lost
 * retry is idempotent) and two different choices fingerprint differently (so a
 * competing submit is a conflict). Everything below is one of those two claims,
 * or a shape a forged body could otherwise smuggle through.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_SUGGESTION_ID_CHARS,
  MAX_SUGGESTION_PARTITION_IDS,
  normalizeSuggestionPartition,
  suggestionPartitionIds,
  suggestionPartitionMaterial,
  SUGGESTION_PARTITION_VERSION,
} from "../artifact-review-decision";

describe("normalizeSuggestionPartition — canonical identity", () => {
  it("sorts and dedupes both lists", () => {
    const r = normalizeSuggestionPartition({
      accepted: ["sug_c", "sug_a", "sug_a"],
      dismissed: ["sug_z", "sug_b"],
    });
    expect(r).toEqual({
      ok: true,
      partition: { accepted: ["sug_a", "sug_c"], dismissed: ["sug_b", "sug_z"] },
    });
  });

  it("a reordered body normalizes to the SAME partition", () => {
    const a = normalizeSuggestionPartition({ accepted: ["s1", "s2"], dismissed: ["s3"] });
    const b = normalizeSuggestionPartition({ accepted: ["s2", "s1"], dismissed: ["s3"] });
    expect(a).toEqual(b);
  });

  it("null, undefined and an all-empty partition all normalize to NO partition", () => {
    expect(normalizeSuggestionPartition(null)).toEqual({ ok: true, partition: null });
    expect(normalizeSuggestionPartition(undefined)).toEqual({ ok: true, partition: null });
    expect(normalizeSuggestionPartition({ accepted: [], dismissed: [] })).toEqual({
      ok: true,
      partition: null,
    });
    expect(normalizeSuggestionPartition({})).toEqual({ ok: true, partition: null });
  });

  it("a partition that only DISMISSES is still a partition", () => {
    const r = normalizeSuggestionPartition({ accepted: [], dismissed: ["s1"] });
    expect(r).toEqual({ ok: true, partition: { accepted: [], dismissed: ["s1"] } });
  });

  it("does NOT trim or fold an id — a padded id stays a different id", () => {
    const r = normalizeSuggestionPartition({ accepted: [" s1"], dismissed: [] });
    expect(r).toEqual({ ok: true, partition: { accepted: [" s1"], dismissed: [] } });
  });
});

describe("normalizeSuggestionPartition — refusals", () => {
  it("refuses an id in BOTH lists", () => {
    const r = normalizeSuggestionPartition({ accepted: ["s1"], dismissed: ["s1"] });
    expect(r.ok).toBe(false);
  });

  it("refuses a non-object, an array, a non-array list, an empty id and a non-string id", () => {
    expect(normalizeSuggestionPartition("nope").ok).toBe(false);
    expect(normalizeSuggestionPartition([]).ok).toBe(false);
    expect(normalizeSuggestionPartition({ accepted: "s1" }).ok).toBe(false);
    expect(normalizeSuggestionPartition({ accepted: [""] }).ok).toBe(false);
    expect(normalizeSuggestionPartition({ accepted: [42] }).ok).toBe(false);
  });

  it("refuses an over-long id and an over-long list", () => {
    expect(
      normalizeSuggestionPartition({ accepted: ["x".repeat(MAX_SUGGESTION_ID_CHARS + 1)] }).ok,
    ).toBe(false);
    expect(
      normalizeSuggestionPartition({
        accepted: Array.from({ length: MAX_SUGGESTION_PARTITION_IDS + 1 }, (_, i) => `s${i}`),
      }).ok,
    ).toBe(false);
  });

  it("the list bound is on the RAW body, so duplicate padding cannot smuggle a long list", () => {
    // 51 entries that dedupe to 1 are still refused: the bound exists to keep a
    // forged body from reaching a store read, and dedupe happens after.
    const r = normalizeSuggestionPartition({
      accepted: Array.from({ length: MAX_SUGGESTION_PARTITION_IDS + 1 }, () => "s1"),
    });
    expect(r.ok).toBe(false);
  });
});

describe("the fingerprint material", () => {
  it("is versioned and order-free", () => {
    const m = suggestionPartitionMaterial({ accepted: ["b", "a"], dismissed: ["d", "c"] });
    expect(m).toEqual({
      v: SUGGESTION_PARTITION_VERSION,
      accepted: ["a", "b"],
      dismissed: ["c", "d"],
    });
  });

  it("suggestionPartitionIds names every decided id, sorted", () => {
    expect(suggestionPartitionIds({ accepted: ["s3", "s1"], dismissed: ["s2"] })).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
  });
});
