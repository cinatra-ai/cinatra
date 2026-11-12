/**
 * cinatra#4244 - the pure readings behind a schema-drawn gate that asks for
 * fields of its own: which fields it asks for, and the approval it sends.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/hitl-gate-submit-schema-field-gate-4244.test.ts
 */
import { describe, expect, it } from "vitest";

import { buildSchemaFieldGatePayload, gateSchemaFieldNames } from "../hitl-gate-submit";

const NOW = "2026-11-12T00:00:00.000Z";

const BRAND_SCHEMA = {
  type: "object",
  properties: { brandVoice: { type: "string", title: "Brand voice" } },
};

describe("gateSchemaFieldNames (cinatra#4244)", () => {
  it("reads a bare object confirmation as asking for nothing", () => {
    expect(gateSchemaFieldNames({ type: "object" })).toEqual([]);
    expect(gateSchemaFieldNames({ type: "object", properties: {} })).toEqual([]);
    expect(
      gateSchemaFieldNames({
        type: "object",
        properties: { approved: { type: "boolean" }, approvedAt: { type: "string" } },
      }),
    ).toEqual([]);
  });

  it("reads the declared fields of an input gate, in order, without hidden ones", () => {
    expect(gateSchemaFieldNames(BRAND_SCHEMA)).toEqual(["brandVoice"]);
    expect(
      gateSchemaFieldNames({
        type: "object",
        properties: {
          title: { type: "string" },
          approved: { type: "boolean" },
          secret: { type: "string", "x-hidden": true },
          tags: { type: "array" },
        },
      }),
    ).toEqual(["title", "tags"]);
  });

  it("reads anything that is not an object schema with properties as asking for nothing", () => {
    for (const schema of [null, undefined, "x", [], { type: "string" }, { type: "object", properties: [] }]) {
      expect(gateSchemaFieldNames(schema)).toEqual([]);
    }
  });
});

describe("buildSchemaFieldGatePayload (cinatra#4244)", () => {
  it("sends the bare approval for a blank optional answer", () => {
    expect(buildSchemaFieldGatePayload({ schema: BRAND_SCHEMA, next: undefined, now: NOW })).toEqual({
      approved: true,
      approvedAt: NOW,
    });
  });

  it("carries one filled text field as the WayFlow resume text", () => {
    expect(
      buildSchemaFieldGatePayload({
        schema: BRAND_SCHEMA,
        next: { brandVoice: "Warm and plain." },
        now: NOW,
      }),
    ).toEqual({
      brandVoice: "Warm and plain.",
      approved: true,
      approvedAt: NOW,
      userResponse: "Warm and plain.",
    });
  });

  it("adds no resume text for a blank text, a non-string field or several fields", () => {
    expect(
      buildSchemaFieldGatePayload({ schema: BRAND_SCHEMA, next: { brandVoice: "  " }, now: NOW }),
    ).toEqual({ brandVoice: "  ", approved: true, approvedAt: NOW });
    expect(
      buildSchemaFieldGatePayload({
        schema: { type: "object", properties: { count: { type: "number" } } },
        next: { count: 3 },
        now: NOW,
      }),
    ).toEqual({ count: 3, approved: true, approvedAt: NOW });
    expect(
      buildSchemaFieldGatePayload({
        schema: {
          type: "object",
          properties: { title: { type: "string" }, body: { type: "string" } },
        },
        next: { title: "T", body: "B" },
        now: NOW,
      }),
    ).toEqual({ title: "T", body: "B", approved: true, approvedAt: NOW });
  });

  it("keeps a resume text the answer already carries", () => {
    expect(
      buildSchemaFieldGatePayload({
        schema: BRAND_SCHEMA,
        next: { brandVoice: "Warm.", userResponse: "kept" },
        now: NOW,
      }),
    ).toEqual({ brandVoice: "Warm.", userResponse: "kept", approved: true, approvedAt: NOW });
  });
});
