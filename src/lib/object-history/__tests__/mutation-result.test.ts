// MutationResult<T> contract.
// Type-level + runtime discrimination pin for the canonical write-action
// result. The full type lives in mutation-result.ts and is re-exported from
// the object-history barrel for every server action to consume.

import { describe, expect, it } from "vitest";
import type { MutationResult } from "../mutation-result";

function ok<T>(data: T, changeSetId?: string): MutationResult<T> {
  return { ok: true, data, changeSetId };
}
function fail(error: string): MutationResult {
  return { ok: false, error };
}

describe("MutationResult<T>", () => {
  it("discriminates on `ok`", () => {
    const a = ok({ x: 1 }, "cs_1");
    const b = fail("nope");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    if (a.ok) {
      expect(a.data).toEqual({ x: 1 });
      expect(a.changeSetId).toBe("cs_1");
    }
    if (!b.ok) {
      expect(b.error).toBe("nope");
    }
  });

  it("success without a changeSetId is valid (no undo affordance)", () => {
    const r: MutationResult<number> = { ok: true, data: 5 };
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changeSetId).toBeUndefined();
  });

  it("failure can carry structured details", () => {
    const r: MutationResult = {
      ok: false,
      error: "validation failed",
      details: { field: "name" },
    };
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.details).toEqual({ field: "name" });
  });
});
