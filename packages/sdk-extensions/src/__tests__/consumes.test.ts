// Structured `cinatra.consumes` parser tests (engineering#422 PR-1).
import { describe, expect, it } from "vitest";

import {
  ConsumesManifestError,
  parseConsumedPrimitives,
  validateConsumedPrimitiveShape,
  type ConsumedPrimitive,
} from "../consumes";

function manifest(cinatra: Record<string, unknown>): unknown {
  return { name: "@cinatra-ai/blog-linkedin-publish-agent", version: "0.1.0", cinatra };
}

describe("validateConsumedPrimitiveShape", () => {
  it("accepts a well-formed entry", () => {
    expect(
      validateConsumedPrimitiveShape({ primitive: "linkedin_post_publish", requirement: "required" }),
    ).toEqual([]);
    expect(
      validateConsumedPrimitiveShape({ primitive: "artifact_representation_get", requirement: "optional" }),
    ).toEqual([]);
  });

  it("rejects an empty / missing primitive", () => {
    expect(validateConsumedPrimitiveShape({ primitive: "", requirement: "required" })).toContain(
      "primitive must be a non-empty string",
    );
    expect(validateConsumedPrimitiveShape({ requirement: "required" })).toContain(
      "primitive must be a non-empty string",
    );
  });

  it("rejects a whitespace-only primitive (never masquerades as a real name)", () => {
    expect(validateConsumedPrimitiveShape({ primitive: "   ", requirement: "required" })).toContain(
      "primitive must be a non-empty string",
    );
  });

  it("rejects an unknown requirement", () => {
    const problems = validateConsumedPrimitiveShape({ primitive: "x", requirement: "maybe" });
    expect(problems.some((p) => p.startsWith("requirement must be one of"))).toBe(true);
  });

  it("rejects a non-object entry", () => {
    expect(validateConsumedPrimitiveShape("nope")).toEqual(["entry is not an object"]);
    expect(validateConsumedPrimitiveShape(["arr"])).toEqual(["entry is not an object"]);
    expect(validateConsumedPrimitiveShape(null)).toEqual(["entry is not an object"]);
  });
});

describe("parseConsumedPrimitives", () => {
  it("absent key → [] (not declared)", () => {
    expect(parseConsumedPrimitives(manifest({}))).toEqual([]);
    expect(parseConsumedPrimitives({ name: "x" })).toEqual([]);
    expect(parseConsumedPrimitives(null)).toEqual([]);
  });

  it("empty array → [] (declared-empty)", () => {
    expect(parseConsumedPrimitives(manifest({ consumes: [] }))).toEqual([]);
  });

  it("well-formed array → normalized entries (only the contract fields)", () => {
    const consumes = [
      { primitive: "blog_post_publish_linkedin_publish", requirement: "required", extra: "smuggled" },
      { primitive: "artifact_representation_get", requirement: "optional" },
    ];
    const out = parseConsumedPrimitives(manifest({ consumes }));
    const expected: ConsumedPrimitive[] = [
      { primitive: "blog_post_publish_linkedin_publish", requirement: "required" },
      { primitive: "artifact_representation_get", requirement: "optional" },
    ];
    expect(out).toEqual(expected);
    // Smuggled fields are NOT passed through.
    expect((out[0] as Record<string, unknown>).extra).toBeUndefined();
  });

  it("explicit null is MALFORMED (consumes-nothing is [], never null)", () => {
    expect(() => parseConsumedPrimitives(manifest({ consumes: null }))).toThrow(ConsumesManifestError);
  });

  it("non-array is MALFORMED", () => {
    expect(() => parseConsumedPrimitives(manifest({ consumes: { primitive: "x" } }))).toThrow(
      ConsumesManifestError,
    );
  });

  it("a malformed entry is fail-loud (never silently dropped)", () => {
    expect(() =>
      parseConsumedPrimitives(manifest({ consumes: [{ primitive: "", requirement: "required" }] })),
    ).toThrow(ConsumesManifestError);
  });

  it("a duplicate primitive is fail-loud", () => {
    expect(() =>
      parseConsumedPrimitives(
        manifest({
          consumes: [
            { primitive: "linkedin_post_publish", requirement: "required" },
            { primitive: "linkedin_post_publish", requirement: "optional" },
          ],
        }),
      ),
    ).toThrow(/duplicate cinatra.consumes entry/);
  });

  it("uses the package label from the manifest name in errors", () => {
    expect(() => parseConsumedPrimitives(manifest({ consumes: null }))).toThrow(
      /@cinatra-ai\/blog-linkedin-publish-agent/,
    );
  });
});
