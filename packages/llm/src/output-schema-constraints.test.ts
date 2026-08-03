/**
 * Per-provider structured-output schema sanitization (cinatra#2339).
 *
 * Lives beside `structured-json.ts`, the leaf that owns both halves of
 * structured-output support (request-side schema policy + response parsing).
 *
 * The keyword sets asserted here are the OBSERVED Anthropic rejection set from
 * a live keyword matrix against api.anthropic.com — see the provenance note in
 * `output-schema-constraints.ts`. These tests pin the transformation; the live
 * proof that the transformation is the RIGHT one lives on the PR.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ANTHROPIC_SUPPORTED_STRING_FORMATS,
  ANTHROPIC_UNSUPPORTED_SCHEMA_KEYWORDS,
  sanitizeOutputSchemaForProvider,
} from "./structured-json";

/** The classifier's real schema (packages/objects/src/classifier/index.ts). */
const CLASSIFIER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["objectTypeId", "confidence", "normalizedData", "isNewType"],
  properties: {
    objectTypeId: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    normalizedData: { type: "string" },
    isNewType: { type: "boolean" },
    inferredTypeName: { anyOf: [{ type: "string" }, { type: "null" }] },
    canonicalKeys: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
  },
} as const;

describe("sanitizeOutputSchemaForProvider — providers with no policy", () => {
  it.each(["openai", "gemini"])(
    "%s gets the IDENTICAL object reference (behaviour unchanged by construction)",
    (provider) => {
      const result = sanitizeOutputSchemaForProvider(provider, CLASSIFIER_SCHEMA);
      expect(result).toBe(CLASSIFIER_SCHEMA);
    },
  );

  it("an unknown/future provider id is passed through untouched", () => {
    const result = sanitizeOutputSchemaForProvider("some-future-provider", CLASSIFIER_SCHEMA);
    expect(result).toBe(CLASSIFIER_SCHEMA);
  });

  it("null / undefined schemas are returned as-is for every provider", () => {
    expect(sanitizeOutputSchemaForProvider("anthropic", undefined)).toBeUndefined();
    expect(sanitizeOutputSchemaForProvider("anthropic", null)).toBeNull();
  });
});

describe("sanitizeOutputSchemaForProvider — anthropic", () => {
  it("drops the number-range keywords that the API rejects and restates them", () => {
    const result = sanitizeOutputSchemaForProvider(
      "anthropic",
      CLASSIFIER_SCHEMA,
    ) as unknown as { properties: Record<string, Record<string, unknown>> };

    const confidence = result.properties.confidence;
    expect(confidence).not.toHaveProperty("minimum");
    expect(confidence).not.toHaveProperty("maximum");
    expect(confidence.type).toBe("number");
    expect(confidence.description).toBe(
      "Constraints (not enforced by the response format — you must satisfy them): minimum 0 (inclusive); maximum 1 (inclusive).",
    );
  });

  it("does NOT mutate the caller's schema — the original stays authoritative", () => {
    const schema = JSON.parse(JSON.stringify(CLASSIFIER_SCHEMA));
    const snapshot = JSON.stringify(schema);
    sanitizeOutputSchemaForProvider("anthropic", schema);
    expect(JSON.stringify(schema)).toBe(snapshot);
  });

  it("returns the SAME reference when a schema carries no unsupported keyword", () => {
    const clean = {
      type: "object",
      additionalProperties: false,
      required: ["a"],
      properties: { a: { type: "string", minLength: 1, maxLength: 5, pattern: "^a+$" } },
    };
    // minLength / maxLength / pattern are ACCEPTED live — stripping them would
    // needlessly weaken the schema, so they must survive untouched.
    expect(sanitizeOutputSchemaForProvider("anthropic", clean)).toBe(clean);
  });

  it.each(ANTHROPIC_UNSUPPORTED_SCHEMA_KEYWORDS)("drops the `%s` keyword", (keyword) => {
    const schema = { type: "object", properties: { v: { type: "number", [keyword]: 1 } } };
    const result = sanitizeOutputSchemaForProvider("anthropic", schema) as {
      properties: { v: Record<string, unknown> };
    };
    expect(result.properties.v).not.toHaveProperty(keyword);
    expect(result.properties.v.description).toContain("not enforced by the response format");
  });

  it("keeps supported `format` values and drops unsupported ones", () => {
    for (const format of ANTHROPIC_SUPPORTED_STRING_FORMATS) {
      const schema = { type: "object", properties: { v: { type: "string", format } } };
      expect(sanitizeOutputSchemaForProvider("anthropic", schema)).toBe(schema);
    }
    const bad = { type: "object", properties: { v: { type: "string", format: "phone" } } };
    const result = sanitizeOutputSchemaForProvider("anthropic", bad) as {
      properties: { v: Record<string, unknown> };
    };
    expect(result.properties.v).not.toHaveProperty("format");
    expect(result.properties.v.description).toContain('format "phone"');
  });

  it("recurses through every schema-valued container the API validates", () => {
    const schema = {
      type: "object",
      properties: {
        nested: { type: "object", properties: { inner: { type: "number", minimum: 0 } } },
        list: { type: "array", items: { type: "number", maximum: 9 } },
        tuple: { type: "array", prefixItems: [{ type: "number", multipleOf: 2 }] },
        legacyTuple: { type: "array", items: [{ type: "number", minimum: 1 }] },
        union: { anyOf: [{ type: "number", minimum: 0 }, { type: "null" }] },
        viaRef: { $ref: "#/$defs/Score" },
        patterned: { type: "object", patternProperties: { "^s": { type: "number", maximum: 3 } } },
        conditional: { if: { type: "number", minimum: 0 }, then: { type: "number", maximum: 1 } },
        negated: { not: { type: "number", minimum: 5 } },
        extra: { type: "object", additionalProperties: { type: "number", minimum: 2 } },
        depends: { type: "object", dependencies: { a: { type: "number", minimum: 7 } } },
      },
      $defs: { Score: { type: "number", minimum: 0, maximum: 1 } },
    };

    const json = JSON.stringify(sanitizeOutputSchemaForProvider("anthropic", schema));
    for (const keyword of ["minimum", "maximum", "multipleOf"]) {
      expect(json).not.toContain(`"${keyword}":`);
    }
    // Structure is preserved — only the keywords went away.
    const result = JSON.parse(json) as Record<string, Record<string, Record<string, unknown>>>;
    expect(result.properties.viaRef.$ref).toBe("#/$defs/Score");
    expect(Object.keys(result.properties)).toHaveLength(11);
  });

  it("NEVER recurses into instance-valued keywords (enum/const/default/examples)", () => {
    // `{ minimum: 3 }` here is DATA the model may legally emit, not a schema.
    // Rewriting it would silently change the accepted value set.
    const schema = {
      type: "object",
      properties: {
        v: {
          type: "object",
          enum: [{ minimum: 3 }],
          const: { maximum: 4 },
          default: { minimum: 5 },
          examples: [{ uniqueItems: true }],
        },
      },
    };
    expect(sanitizeOutputSchemaForProvider("anthropic", schema)).toBe(schema);
  });

  it("sanitizes EVERY occurrence of a subschema object shared by several properties", () => {
    // Regression (codex round-1): a shared object is not a cycle. Treating the
    // second sighting as one left it unsanitized and the request still 400'd.
    const shared = { type: "number", minimum: 0, maximum: 1 };
    const schema = { type: "object", properties: { a: shared, b: shared, c: { items: shared } } };

    const result = sanitizeOutputSchemaForProvider("anthropic", schema) as {
      properties: { a: Record<string, unknown>; b: Record<string, unknown>; c: { items: unknown } };
    };

    for (const node of [result.properties.a, result.properties.b, result.properties.c.items]) {
      expect(node).not.toHaveProperty("minimum");
      expect(node).not.toHaveProperty("maximum");
    }
    // The sharing survives: one sanitized node, still referenced three times.
    expect(result.properties.b).toBe(result.properties.a);
    expect(result.properties.c.items).toBe(result.properties.a);
    // …and the input object was never mutated.
    expect(shared).toEqual({ type: "number", minimum: 0, maximum: 1 });
  });

  it("preserves boolean subschemas", () => {
    const schema = { type: "object", properties: { v: { type: "number", minimum: 0 } }, additionalProperties: false };
    const result = sanitizeOutputSchemaForProvider("anthropic", schema) as Record<string, unknown>;
    expect(result.additionalProperties).toBe(false);
  });

  it("degrades to the original schema instead of throwing on a cyclic input", () => {
    const cyclic: Record<string, unknown> = { type: "object", properties: {} };
    (cyclic.properties as Record<string, unknown>).self = cyclic;
    expect(() => sanitizeOutputSchemaForProvider("anthropic", cyclic)).not.toThrow();
  });

  it("forwards the original schema (and warns) if sanitization itself fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hostile = {
      type: "object",
      get properties(): never {
        throw new Error("boom");
      },
    };
    expect(sanitizeOutputSchemaForProvider("anthropic", hostile)).toBe(hostile);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
