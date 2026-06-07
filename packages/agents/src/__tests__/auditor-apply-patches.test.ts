/**
 * applyAuditorPatches deterministic transform.
 *
 * Unit-tests applyAuditorPatches(input, suggestions, acceptedIds) located at
 * packages/agent-builder/src/auditor-apply.ts.
 *
 * Cases:
 *  - replace at /subject — value swap
 *  - add at /tags/- — append
 *  - remove at /draft/cc — delete
 *  - reject __proto__ / constructor / prototype path segments → throws
 *  - skip suggestions whose id is not in acceptedIds
 *  - deterministic — same input + suggestions + acceptedIds → identical JSON
 *
 * Run: cd packages/agent-builder && pnpm exec vitest run src/__tests__/auditor-apply-patches.test.ts
 */
import { describe, expect, it } from "vitest";

import { applyAuditorPatches } from "../auditor-apply";

interface SuggestionPatch {
  id: string;
  fieldPath: string;
  op: "replace" | "add" | "remove";
  value?: unknown;
  message?: string;
}

describe("applyAuditorPatches", () => {
  it("replace at /subject swaps the value", () => {
    const input = { subject: "Old", body: "Hi" };
    const suggestions: SuggestionPatch[] = [
      { id: "s1", fieldPath: "/subject", op: "replace", value: "New" },
    ];
    const out = applyAuditorPatches(input, suggestions, ["s1"]);
    expect(out).toEqual({ subject: "New", body: "Hi" });
    // Input must not be mutated (deterministic, pure).
    expect(input.subject).toBe("Old");
  });

  it("add at /tags/- appends", () => {
    const input = { tags: ["a"] };
    const suggestions: SuggestionPatch[] = [
      { id: "s1", fieldPath: "/tags/-", op: "add", value: "b" },
    ];
    const out = applyAuditorPatches(input, suggestions, ["s1"]) as { tags: string[] };
    expect(out.tags).toEqual(["a", "b"]);
  });

  it("remove at /draft/cc deletes the field", () => {
    const input = { draft: { to: "x@y", cc: "z@y" } };
    const suggestions: SuggestionPatch[] = [
      { id: "s1", fieldPath: "/draft/cc", op: "remove" },
    ];
    const out = applyAuditorPatches(input, suggestions, ["s1"]) as {
      draft: { to: string; cc?: string };
    };
    expect(out.draft.cc).toBeUndefined();
    expect(out.draft.to).toBe("x@y");
  });

  it("rejects __proto__ in path segments — throws", () => {
    const input = { x: 1 };
    const suggestions: SuggestionPatch[] = [
      { id: "s1", fieldPath: "/__proto__/polluted", op: "replace", value: 1 },
    ];
    expect(() => applyAuditorPatches(input, suggestions, ["s1"])).toThrow(
      /__proto__|forbidden|prototype/i,
    );
  });

  it("rejects constructor in path segments — throws", () => {
    const input = { x: 1 };
    const suggestions: SuggestionPatch[] = [
      { id: "s1", fieldPath: "/constructor/x", op: "replace", value: 1 },
    ];
    expect(() => applyAuditorPatches(input, suggestions, ["s1"])).toThrow(
      /constructor|forbidden|prototype/i,
    );
  });

  it("rejects prototype in path segments — throws", () => {
    const input = { x: 1 };
    const suggestions: SuggestionPatch[] = [
      { id: "s1", fieldPath: "/prototype/x", op: "replace", value: 1 },
    ];
    expect(() => applyAuditorPatches(input, suggestions, ["s1"])).toThrow(
      /prototype|forbidden/i,
    );
  });

  it("skips suggestions whose id is not in acceptedIds", () => {
    const input = { subject: "Old" };
    const suggestions: SuggestionPatch[] = [
      { id: "s1", fieldPath: "/subject", op: "replace", value: "New" },
      { id: "s2", fieldPath: "/subject", op: "replace", value: "Other" },
    ];
    const out = applyAuditorPatches(input, suggestions, ["s1"]);
    expect(out).toEqual({ subject: "New" });
  });

  it("deterministic — same inputs always produce identical output JSON", () => {
    const input = { subject: "A", tags: ["x"], draft: { cc: "z@y" } };
    const suggestions: SuggestionPatch[] = [
      { id: "s1", fieldPath: "/subject", op: "replace", value: "B" },
      { id: "s2", fieldPath: "/tags/-", op: "add", value: "y" },
      { id: "s3", fieldPath: "/draft/cc", op: "remove" },
    ];
    const acceptedIds = ["s1", "s2", "s3"];
    const out1 = applyAuditorPatches(input, suggestions, acceptedIds);
    const out2 = applyAuditorPatches(input, suggestions, acceptedIds);
    expect(JSON.stringify(out1)).toBe(JSON.stringify(out2));
  });
});
