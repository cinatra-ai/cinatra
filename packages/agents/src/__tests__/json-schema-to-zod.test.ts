/**
 * Unit tests for jsonSchemaToZod converter.
 *
 * Pure-logic tests for the JSON-Schema → Zod converter used at
 * agent-execution validation boundaries. No DB, no React, no server-only.
 *
 * Vitest's default include glob is tests/ (recursive), so this file is
 * picked up via the src/__tests__ (recursive) entry in vitest.config.ts.
 * Invoke explicitly with:
 *   pnpm vitest run src/__tests__/json-schema-to-zod.test.ts
 * from `packages/agent-builder/`.
 */
import { describe, it, expect } from "vitest";
import { jsonSchemaToZod } from "../json-schema-to-zod";

describe("jsonSchemaToZod", () => {
  it("converts string", () => {
    const s = jsonSchemaToZod({ type: "string" });
    expect(s.parse("hello")).toBe("hello");
    expect(() => s.parse(42)).toThrow();
  });

  it("converts number", () => {
    const s = jsonSchemaToZod({ type: "number" });
    expect(s.parse(3.14)).toBe(3.14);
    expect(() => s.parse("x")).toThrow();
  });

  it("converts integer as number", () => {
    const s = jsonSchemaToZod({ type: "integer" });
    expect(s.parse(5)).toBe(5);
  });

  it("converts boolean", () => {
    const s = jsonSchemaToZod({ type: "boolean" });
    expect(s.parse(true)).toBe(true);
    expect(() => s.parse(0)).toThrow();
  });

  it("converts array of strings", () => {
    const s = jsonSchemaToZod({ type: "array", items: { type: "string" } });
    expect(s.parse(["a", "b"])).toEqual(["a", "b"]);
    expect(() => s.parse([1])).toThrow();
  });

  it("converts object with required properties", () => {
    const s = jsonSchemaToZod({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    expect(s.parse({ name: "x" })).toEqual({ name: "x" });
    expect(() => s.parse({})).toThrow();
  });

  it("marks non-required properties as optional", () => {
    const s = jsonSchemaToZod({
      type: "object",
      properties: { age: { type: "number" } },
    });
    expect(s.parse({})).toEqual({});
    expect(() => s.parse({ age: "x" })).toThrow();
  });

  it("falls back to record(unknown) for unknown types", () => {
    const s = jsonSchemaToZod({ type: "unknownType" } as Record<string, unknown>);
    expect(s.parse({ foo: 1 })).toEqual({ foo: 1 });
  });

  it("falls back for empty schema", () => {
    const s = jsonSchemaToZod({});
    expect(s.parse({ foo: 1 })).toEqual({ foo: 1 });
  });

  it("falls back for null / undefined input without throwing", () => {
    expect(() => jsonSchemaToZod(null)).not.toThrow();
    expect(() => jsonSchemaToZod(undefined)).not.toThrow();
    const s = jsonSchemaToZod(null);
    expect(s.parse({ foo: 1 })).toEqual({ foo: 1 });
  });

  it("handles nested objects", () => {
    const s = jsonSchemaToZod({
      type: "object",
      properties: {
        meta: {
          type: "object",
          properties: { tag: { type: "string" } },
          required: ["tag"],
        },
      },
      required: ["meta"],
    });
    expect(s.parse({ meta: { tag: "x" } })).toEqual({ meta: { tag: "x" } });
    expect(() => s.parse({ meta: { tag: 42 } })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Empty-properties object schema handling keeps object schemas without declared
// properties permissive. This supports email-outreach's accountScope.
// ---------------------------------------------------------------------------
describe("empty-properties object schema handling", () => {
  it('returns a permissive z.record schema for { type: "object" } with no declared properties', () => {
    const zod = jsonSchemaToZod({ type: "object" });
    const result = zod.safeParse({ any: "shape", nested: { a: 1 } });
    expect(result.success).toBe(true);
  });

  it('returns a permissive z.record schema for { type: "object", properties: {} }', () => {
    const zod = jsonSchemaToZod({ type: "object", properties: {} });
    const result = zod.safeParse({
      scope: "all_contacts",
      agentCampaignIds: [],
    });
    expect(result.success).toBe(true);
  });

  it('uses strict z.object for { type: "object" } WITH declared properties (no regression)', () => {
    const zod = jsonSchemaToZod({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    const result = zod.safeParse({ name: "Alice" });
    expect(result.success).toBe(true);
    const fail = zod.safeParse({}); // missing required field
    expect(fail.success).toBe(false);
  });

  it("passes the email-outreach accountScope schema through jsonSchemaToZod without rejecting extra keys", () => {
    // Simulate the accountScope schema shape from the email-outreach OAS. The
    // x-renderer is the list-picker (the contact-source-selector was retired
    // with the lists_* / segment surface); the converter must pass extra keys
    // (x-renderer + any operator-supplied scope payload) through untouched.
    const zod = jsonSchemaToZod({
      type: "object",
      title: "Contact source",
      "x-renderer": "@cinatra-ai/email-outreach-agent:list-picker",
    });
    const result = zod.safeParse({
      listId: "list-123",
      listName: "Beta Prospects",
    });
    expect(result.success).toBe(true);
  });
});
