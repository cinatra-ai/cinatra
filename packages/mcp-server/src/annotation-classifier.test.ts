import { describe, expect, it } from "vitest";
import { classifyAnnotations, coerceAnnotationBool } from "./annotation-classifier";

// cinatra#2017 S2 slice K3 — annotation classifier (design §3.4 / D5).

describe("coerceAnnotationBool", () => {
  it("accepts real booleans", () => {
    expect(coerceAnnotationBool(true)).toBe(true);
    expect(coerceAnnotationBool(false)).toBe(false);
  });
  it("coerces string booleans (case-insensitive, trimmed) and 1/0", () => {
    expect(coerceAnnotationBool("true")).toBe(true);
    expect(coerceAnnotationBool(" TRUE ")).toBe(true);
    expect(coerceAnnotationBool("false")).toBe(false);
    expect(coerceAnnotationBool("1")).toBe(true);
    expect(coerceAnnotationBool(0)).toBe(false);
    expect(coerceAnnotationBool(1)).toBe(true);
  });
  it("DROPS uninterpretable values (→ undefined)", () => {
    expect(coerceAnnotationBool("yes")).toBeUndefined();
    expect(coerceAnnotationBool(2)).toBeUndefined();
    expect(coerceAnnotationBool(null)).toBeUndefined();
    expect(coerceAnnotationBool({})).toBeUndefined();
    expect(coerceAnnotationBool(undefined)).toBeUndefined();
  });
});

describe("classifyAnnotations — precedence destructive > write > read", () => {
  it("destructiveHint truthy → destructive", () => {
    expect(classifyAnnotations({ destructiveHint: true })).toBe("destructive");
  });
  it("WP-format destructive key also → destructive", () => {
    expect(classifyAnnotations({ destructive: "true" })).toBe("destructive");
  });
  it("readOnlyHint truthy (no destructive) → read", () => {
    expect(classifyAnnotations({ readOnlyHint: true })).toBe("read");
    expect(classifyAnnotations({ readonly: "true" })).toBe("read");
  });
  it("contradictory {readOnlyHint:true, destructiveHint:true} → destructive (safe reading)", () => {
    expect(classifyAnnotations({ readOnlyHint: true, destructiveHint: true })).toBe("destructive");
  });
  it("unannotated / empty → write-class (the default)", () => {
    expect(classifyAnnotations({})).toBe("write");
    expect(classifyAnnotations(null)).toBe("write");
    expect(classifyAnnotations(undefined)).toBe("write");
  });
  it("unknown / uninterpretable hints → write-class (a mis-guess costs a hop, never an ungoverned mutation)", () => {
    expect(classifyAnnotations({ readOnlyHint: "maybe", destructiveHint: 7 })).toBe("write");
    expect(classifyAnnotations({ idempotentHint: true })).toBe("write");
  });
  it("standard key wins over WP-format when both present", () => {
    // standard readOnlyHint:false present + wp readonly:true → standard wins (false) → not read → write
    expect(classifyAnnotations({ readOnlyHint: false, readonly: true })).toBe("write");
  });
});
