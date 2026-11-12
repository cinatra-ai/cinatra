/**
 * cinatra#4244 - the pure readings behind a schema-drawn gate that asks for
 * fields of its own: what the gate schema declares, and the approval it sends.
 *
 * The helpers are read through a namespace import, so a helper that does not
 * exist fails its own cases, not the whole file.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/hitl-gate-submit-schema-field-gate-4244.test.ts
 */
import { describe, expect, it } from "vitest";

import * as gateSubmit from "../hitl-gate-submit";

type Reading =
  | { kind: "not-object" }
  | { kind: "bare" }
  | { kind: "malformed" }
  | { kind: "fields"; fields: string[]; renderSchema: Record<string, unknown> };

function read(schema: unknown): Reading {
  const fn = (gateSubmit as unknown as { readSchemaFieldGate: (s: unknown) => Reading })
    .readSchemaFieldGate;
  return fn(schema);
}

function payload(args: { schema: unknown; next: unknown; now?: string }): Record<string, unknown> {
  return gateSubmit.buildSchemaFieldGatePayload(args);
}

const NOW = "2026-11-12T00:00:00.000Z";

const BRAND_SCHEMA = {
  type: "object",
  properties: { brandVoice: { type: "string", title: "Brand voice" } },
};

describe("readSchemaFieldGate (cinatra#4244)", () => {
  it("reads a bare object confirmation as asking for nothing", () => {
    expect(read({ type: "object" })).toEqual({ kind: "bare" });
    expect(read({ type: "object", properties: {} })).toEqual({ kind: "bare" });
    expect(
      read({
        type: "object",
        properties: { approved: { type: "boolean" }, approvedAt: { type: "string" } },
      }),
    ).toEqual({ kind: "bare" });
    expect(
      read({ type: "object", properties: { secret: { type: "string", "x-hidden": true } } }),
    ).toEqual({ kind: "bare" });
  });

  it("reads a schema that is not an object schema as not this road", () => {
    for (const schema of [null, undefined, "x", [], { type: "string" }]) {
      expect(read(schema)).toEqual({ kind: "not-object" });
    }
  });

  it("refuses a malformed object schema instead of reading it as a bare confirmation", () => {
    const malformed: unknown[] = [
      { type: "object", properties: [] },
      { type: "object", properties: null },
      { type: "object", properties: "brandVoice" },
      { type: "object", properties: { brandVoice: null } },
      { type: "object", properties: { brandVoice: [] } },
      { type: "object", properties: { brandVoice: "string" } },
      { type: "object", properties: { approved: null } },
      { type: "object", properties: { brandVoice: { type: "string" } }, required: "brandVoice" },
      { type: "object", properties: { brandVoice: { type: "string" } }, required: [1] },
      { type: "object", properties: { brandVoice: { type: "string", "x-hidden": "yes" } } },
      { type: "object", properties: { brandVoice: { type: "string", "x-required": "yes" } } },
    ];
    for (const schema of malformed) {
      expect(read(schema), JSON.stringify(schema)).toEqual({ kind: "malformed" });
    }
  });

  it("reads the declared fields of an input gate, in order, without hidden or bookkeeping ones", () => {
    const reading = read({
      type: "object",
      properties: {
        title: { type: "string" },
        approved: { type: "boolean" },
        secret: { type: "string", "x-hidden": true },
        tags: { type: "array" },
        approvedAt: { type: "string" },
      },
    });
    expect(reading.kind).toBe("fields");
    if (reading.kind !== "fields") return;
    expect(reading.fields).toEqual(["title", "tags"]);
    // The bookkeeping keys are never drawn as fields.
    expect(Object.keys(reading.renderSchema.properties as object)).toEqual([
      "title",
      "secret",
      "tags",
    ]);
    expect(reading.renderSchema.type).toBe("object");
  });

  it("folds x-required into the drawn required list and leaves a value with a default unheld", () => {
    const reading = read({
      type: "object",
      "x-renderer": "@cinatra-ai/agent-builder:schema-field-fallback",
      properties: {
        brandVoice: { type: "string", "x-required": true },
        tags: { type: "array" },
        tone: { type: "string", default: "plain" },
        note: { type: "string" },
      },
      required: ["tags", "tone", "missing"],
    });
    expect(reading.kind).toBe("fields");
    if (reading.kind !== "fields") return;
    expect(reading.renderSchema.required).toEqual(["tags", "brandVoice"]);
    expect(reading.renderSchema["x-renderer"]).toBeUndefined();
  });
});

describe("readSchemaFieldGate - fold2 admission (cinatra#4244)", () => {
  it("refuses a schema with no properties whose required list is not empty or not names", () => {
    expect(read({ type: "object", required: [] })).toEqual({ kind: "bare" });
    expect(read({ type: "object", required: [1] })).toEqual({ kind: "malformed" });
    expect(read({ type: "object", required: ["brandVoice"] })).toEqual({ kind: "malformed" });
  });

  it("refuses a malformed declaration at any depth", () => {
    const nested: unknown[] = [
      { type: "object", properties: { config: { type: "object", properties: { child: null } } } },
      { type: "object", properties: { config: { type: "object", properties: [] } } },
      { type: "object", properties: { config: { type: "object", properties: {}, required: "child" } } },
      {
        type: "object",
        properties: { config: { type: "object", properties: { a: { type: "string", "x-hidden": 1 } } } },
      },
      {
        type: "object",
        properties: { config: { type: "object", properties: { a: { type: "string", "x-required": "y" } } } },
      },
      { type: "object", properties: { tags: { type: "array", items: null } } },
      { type: "object", properties: { tags: { type: "array", items: { type: "object", properties: { x: 3 } } } } },
    ];
    for (const schema of nested) {
      expect(read(schema), JSON.stringify(schema)).toEqual({ kind: "malformed" });
    }
    const deep = read({
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: { tone: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
          required: ["tone"],
        },
      },
    });
    expect(deep.kind).toBe("fields");
  });

  it("keeps a declared field named __proto__ as an own field of the drawn schema", () => {
    const reading = read(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'));
    expect(reading.kind).toBe("fields");
    if (reading.kind !== "fields") return;
    expect(reading.fields).toEqual(["__proto__"]);
    const props = reading.renderSchema.properties as object;
    expect(Object.prototype.hasOwnProperty.call(props, "__proto__")).toBe(true);
    expect(Object.keys(props)).toEqual(["__proto__"]);
  });
});

describe("buildSchemaFieldGatePayload (cinatra#4244)", () => {
  it("sends the bare approval for a blank optional answer", () => {
    expect(payload({ schema: BRAND_SCHEMA, next: undefined, now: NOW })).toEqual({
      approved: true,
      approvedAt: NOW,
    });
    expect(payload({ schema: BRAND_SCHEMA, next: {}, now: NOW })).toEqual({
      approved: true,
      approvedAt: NOW,
    });
  });

  it("carries one filled text field as the WayFlow resume text", () => {
    expect(
      payload({ schema: BRAND_SCHEMA, next: { brandVoice: "Warm and plain." }, now: NOW }),
    ).toEqual({
      brandVoice: "Warm and plain.",
      approved: true,
      approvedAt: NOW,
      userResponse: "Warm and plain.",
    });
  });

  it("adds no resume text for a blank answer", () => {
    expect(payload({ schema: BRAND_SCHEMA, next: { brandVoice: "  " }, now: NOW })).toEqual({
      brandVoice: "  ",
      approved: true,
      approvedAt: NOW,
    });
  });

  it("carries a non-string answer to WayFlow as a JSON object of the declared answers", () => {
    const out = payload({
      schema: { type: "object", properties: { tags: { type: "array" } } },
      next: { tags: ["warm", "plain"] },
      now: NOW,
    });
    expect(out.tags).toEqual(["warm", "plain"]);
    expect(JSON.parse(out.userResponse as string)).toEqual({ tags: ["warm", "plain"] });
    const counted = payload({
      schema: { type: "object", properties: { count: { type: "number" } } },
      next: { count: 0 },
      now: NOW,
    });
    expect(JSON.parse(counted.userResponse as string)).toEqual({ count: 0 });
  });

  it("carries several answers to WayFlow as one JSON object, without the bookkeeping keys", () => {
    const out = payload({
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          approved: { type: "boolean" },
        },
      },
      next: { title: "T", body: "B", approved: false },
      now: NOW,
    });
    expect(out.approved).toBe(true);
    expect(out.approvedAt).toBe(NOW);
    expect(JSON.parse(out.userResponse as string)).toEqual({ title: "T", body: "B" });
    const partial = payload({
      schema: {
        type: "object",
        properties: { title: { type: "string" }, body: { type: "string" } },
      },
      next: { title: "T", body: "" },
      now: NOW,
    });
    expect(JSON.parse(partial.userResponse as string)).toEqual({ title: "T" });
  });

  it("keeps a resume text the answer already carries", () => {
    expect(
      payload({
        schema: BRAND_SCHEMA,
        next: { brandVoice: "Warm.", userResponse: "kept" },
        now: NOW,
      }),
    ).toEqual({ brandVoice: "Warm.", userResponse: "kept", approved: true, approvedAt: NOW });
  });
  it("carries an answer to a field named __proto__ to WayFlow", () => {
    const one = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}');
    expect(payload({ schema: one, next: JSON.parse('{"__proto__":"warm"}'), now: NOW }).userResponse).toBe(
      "warm",
    );
    const two = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"},"note":{"type":"string"}}}',
    );
    const sent = payload({ schema: two, next: JSON.parse('{"__proto__":"warm","note":"n"}'), now: NOW });
    const parsed = JSON.parse(sent.userResponse as string) as object;
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(true);
    expect((parsed as Record<string, unknown>)["note"]).toBe("n");
    expect(Object.getOwnPropertyDescriptor(parsed, "__proto__")?.value).toBe("warm");
  });

  it("refuses a non-finite number answer instead of sending null", () => {
    const schema = { type: "object", properties: { count: { type: "number" } } };
    for (const bad of [Infinity, -Infinity, Number.NaN]) {
      expect(() => payload({ schema, next: { count: bad }, now: NOW })).toThrow();
    }
    expect(() =>
      payload({
        schema: { type: "object", properties: { cfg: { type: "object" } } },
        next: { cfg: { depth: Infinity } },
        now: NOW,
      }),
    ).toThrow();
  });

  it("sends a single text answer that reads as JSON under its declared field", () => {
    for (const text of ["42", '{"tone":"warm"}', "true", "[1]", "null"]) {
      const sent = payload({ schema: BRAND_SCHEMA, next: { brandVoice: text }, now: NOW });
      expect(JSON.parse(sent.userResponse as string), text).toEqual({ brandVoice: text });
    }
    expect(payload({ schema: BRAND_SCHEMA, next: { brandVoice: "Warm." }, now: NOW }).userResponse).toBe(
      "Warm.",
    );
  });
});
