// Regression test for the cas_assert SQL pattern.
//
// The cas_assert CTE wraps every history-aware writer CTE and raises
// `division_by_zero` (SQLSTATE 22012) when the write returned zero rows
// (CAS miss). The JS-side catches this and rethrows as
// VersionConflictError. This test verifies the JS-side conversion
// without needing a real PG connection — we exercise the error-shape
// detection.

import { describe, expect, it } from "vitest";

import { VersionConflictError } from "../errors";

// Mirror the canonical-writer.ts isCasAssertError signature so the test
// stays close to what runs in production. Keep in sync with the helper
// in canonical-writer.ts.
function isCasAssertError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: string; message?: string };
  if (err.code === "22012") return true;
  return /division by zero/i.test(err.message ?? "");
}

describe("cas_assert error detection", () => {
  it("matches by SQLSTATE 22012", () => {
    const err = Object.assign(new Error("oops"), { code: "22012" });
    expect(isCasAssertError(err)).toBe(true);
  });

  it("matches by message text (case-insensitive)", () => {
    expect(isCasAssertError(new Error("Division by zero"))).toBe(true);
    expect(isCasAssertError(new Error("ERROR: division by zero"))).toBe(true);
    expect(isCasAssertError(new Error("division By Zero"))).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isCasAssertError(new Error("connection refused"))).toBe(false);
    expect(
      isCasAssertError(
        Object.assign(new Error("foreign key violation"), { code: "23503" }),
      ),
    ).toBe(false);
    expect(isCasAssertError(null)).toBe(false);
    expect(isCasAssertError(undefined)).toBe(false);
    expect(isCasAssertError({})).toBe(false);
    expect(isCasAssertError("string error")).toBe(false);
  });
});

describe("VersionConflictError shape (used after cas_assert raises)", () => {
  it("carries the precise reason that the writer derived", () => {
    const e = new VersionConflictError({
      objectId: "obj_1",
      currentVersion: 5,
      expectedBaseVersion: 3,
      latestSnapshot: { payload: { data: { x: 1 } } },
      conflictingFields: ["data"],
      reason: "stale-write",
    });
    expect(e.reason).toBe("stale-write");
    expect(e.currentVersion).toBe(5);
    expect(e.expectedBaseVersion).toBe(3);
    expect(e.objectId).toBe("obj_1");
    expect(e.message).toContain("VersionConflict");
    expect(e.message).toContain("stale-write");
  });

  it("toPayload round-trips the conflict descriptor", () => {
    const payload = {
      objectId: "obj_2",
      currentVersion: 0,
      expectedBaseVersion: null,
      latestSnapshot: null,
      conflictingFields: [],
      reason: "row-exists" as const,
    };
    const e = new VersionConflictError(payload);
    expect(e.toPayload()).toEqual(payload);
  });
});
