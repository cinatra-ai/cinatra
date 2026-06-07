/**
 * Regression test for the JSON-Schema → Zod converter used by
 * `mcp-tools.ts` to bridge drizzle-cube/mcp's `MCPToolDefinition.inputSchema`
 * into Cinatra's MCP server registry. The cube-tool inputSchemas are
 * captured from a live `getCubeTools({ semanticLayer: <stub layer> })`
 * call, so this test would fail at build time if drizzle-cube changed
 * the shape on a minor bump.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDrizzleSemanticLayer } from "drizzle-cube/server";
import { getCubeTools } from "drizzle-cube/mcp";

import { jsonSchemaToZod } from "../json-schema-to-zod";

function snapshotCubeToolDefinitions() {
  const layer = createDrizzleSemanticLayer({
    // SemanticLayer construction accepts `null` for drizzle when no cube
    // is registered yet — we only need the tool definitions, not execution.
    drizzle: null as never,
  });
  const tools = getCubeTools({
    semanticLayer: layer,
    getSecurityContext: () => ({}),
    // `app: true` activates the `chart` tool; without it, drizzle-cube
    // returns only the 3 original tools. The Cinatra wrapper
    // (`createDrizzleCubeMcpTools`) sets this by default for production
    // registration, so the snapshot mirrors production.
    app: true,
  });
  return tools.definitions;
}

describe("jsonSchemaToZod (drizzle-cube/mcp 0.5.6 bridge)", () => {
  it("rejects a non-object root schema", () => {
    expect(() => jsonSchemaToZod({ type: "string" } as never)).toThrow(
      /root schema must be type "object"/,
    );
  });

  it("collapses {} to z.unknown via the converter", () => {
    // Internal: convert via a synthetic object wrapper since the converter
    // is called as `jsonSchemaToZod(root)` and inner nodes go via convertNode.
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { values: { items: {} as never, type: "array" } },
    });
    // `values` is optional (no required[]) — parsing an object without it
    // succeeds.
    expect(schema.parse({})).toEqual({});
    // Inner items: any element accepted.
    expect(schema.parse({ values: ["a", 1, null, { x: 1 }] })).toBeDefined();
  });

  it("collapses description-only nodes to z.unknown", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { dateRange: { description: "absolute or relative" } as never },
    });
    expect(schema.parse({ dateRange: "last 7 days" })).toEqual({ dateRange: "last 7 days" });
    expect(schema.parse({ dateRange: ["2024-01-01", "2024-01-30"] })).toEqual({
      dateRange: ["2024-01-01", "2024-01-30"],
    });
  });

  it("treats type:object without properties as opaque record", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        query: { type: "object", description: "CubeQuery to validate" },
      },
      required: ["query"],
    });
    expect(schema.parse({ query: { measures: ["A.x"] } })).toEqual({
      query: { measures: ["A.x"] },
    });
    // query is required.
    expect(() => schema.parse({})).toThrow();
  });

  it("propagates `required` to mark missing keys as missing", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { topic: { type: "string" }, limit: { type: "number" } },
    });
    expect(schema.parse({})).toEqual({});
    expect(schema.parse({ topic: "sales", limit: 10 })).toEqual({ topic: "sales", limit: 10 });
  });

  it("converts nested enums correctly (filters[].operator)", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        filters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              member: { type: "string" },
              operator: { type: "string", enum: ["equals", "notEquals"] },
            },
            required: ["member", "operator"],
          },
        },
      },
    });
    expect(
      schema.parse({
        filters: [{ member: "Sales.region", operator: "equals" }],
      }),
    ).toBeDefined();
    expect(() =>
      schema.parse({
        filters: [{ member: "Sales.region", operator: "bogus" }],
      }),
    ).toThrow();
  });

  it("fails fast on unsupported type", () => {
    expect(() =>
      jsonSchemaToZod({
        type: "object",
        properties: { weird: { type: "tuple" } as never },
      }),
    ).toThrow(/unsupported type "tuple"/);
  });

  // ─── Round-trip the real drizzle-cube 0.5.6 schemas ───────────────────
  // If drizzle-cube changes its tool schemas on a minor bump, these tests
  // are the early warning.

  describe("round-trips against live drizzle-cube/mcp definitions", () => {
    const defs = snapshotCubeToolDefinitions();

    it("emits 4 tools by default (discover, validate, load, chart)", () => {
      const names = defs.map((d) => d.name).sort();
      expect(names).toEqual([
        "drizzle_cube_chart",
        "drizzle_cube_discover",
        "drizzle_cube_load",
        "drizzle_cube_validate",
      ]);
    });

    it("each definition's inputSchema converts to a ZodObject", () => {
      for (const def of defs) {
        const converted = jsonSchemaToZod(def.inputSchema as never);
        expect(converted).toBeInstanceOf(z.ZodObject);
      }
    });

    it("`discover` accepts a representative input", () => {
      const def = defs.find((d) => d.name === "drizzle_cube_discover");
      expect(def).toBeDefined();
      const zod = jsonSchemaToZod(def!.inputSchema as never);
      expect(zod.parse({ topic: "agent runs", limit: 5 })).toBeDefined();
      expect(zod.parse({})).toBeDefined();
    });

    it("`validate` requires `query`", () => {
      const def = defs.find((d) => d.name === "drizzle_cube_validate");
      const zod = jsonSchemaToZod(def!.inputSchema as never);
      expect(() => zod.parse({})).toThrow();
      expect(zod.parse({ query: { measures: ["agent_runs.count"] } })).toBeDefined();
    });

    it("`load` accepts measures + dimensions + filters[] + timeDimensions[]", () => {
      const def = defs.find((d) => d.name === "drizzle_cube_load");
      const zod = jsonSchemaToZod(def!.inputSchema as never);
      const ok = zod.parse({
        query: {
          measures: ["agent_runs.count"],
          dimensions: ["agent_runs.status"],
          filters: [{ member: "agent_runs.status", operator: "equals", values: ["succeeded"] }],
          timeDimensions: [
            { dimension: "agent_runs.created_at", granularity: "day", dateRange: "last 7 days" },
          ],
          order: { "agent_runs.count": "desc" },
          limit: 50,
        },
      });
      expect(ok).toBeDefined();
    });

    // drizzle-cube's documented filter DSL accepts BOTH per-filter
    // `{member, operator, values}` AND grouped wrappers `{and: [...]}` /
    // `{or: [...]}`. The JSON Schema only describes the per-filter case;
    // without depth>0 advisory mode the converter would reject grouped
    // wrappers BEFORE drizzle-cube's downstream validator saw them,
    // breaking valid drizzle-cube queries the LLM would emit after reading
    // the discover response.
    it("`load` accepts grouped filter wrappers ({and:[...]}/{or:[...]})", () => {
      const def = defs.find((d) => d.name === "drizzle_cube_load");
      const zod = jsonSchemaToZod(def!.inputSchema as never);
      const ok = zod.parse({
        query: {
          measures: ["agent_runs.count"],
          filters: [
            {
              and: [
                { member: "agent_runs.status", operator: "equals", values: ["succeeded"] },
                {
                  or: [
                    { member: "agent_runs.agent_id", operator: "equals", values: ["abc"] },
                    { member: "agent_runs.agent_id", operator: "equals", values: ["def"] },
                  ],
                },
              ],
            },
          ],
        },
      });
      expect(ok).toBeDefined();
    });

    // Inner objects should NOT enforce their declared `required` keys —
    // drizzle-cube validates downstream. The JSON Schema marks
    // filters[].items.required = ["member", "operator"] but the LLM might
    // emit a `{or: [...]}` wrapper that has neither.
    it("`load` accepts filter items missing member/operator (inner required is advisory)", () => {
      const def = defs.find((d) => d.name === "drizzle_cube_load");
      const zod = jsonSchemaToZod(def!.inputSchema as never);
      const ok = zod.parse({
        query: {
          measures: ["agent_runs.count"],
          filters: [{ or: [{ member: "agent_runs.status", operator: "equals", values: ["x"] }] }],
        },
      });
      expect(ok).toBeDefined();
    });

    it("`load` STILL rejects a missing top-level `query` (root required is honored)", () => {
      const def = defs.find((d) => d.name === "drizzle_cube_load");
      const zod = jsonSchemaToZod(def!.inputSchema as never);
      expect(() => zod.parse({})).toThrow();
    });
  });
});
