import { describe, it, expect } from "vitest";
import { z } from "zod";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { admitToolInputSchema, isStandardSchemaWithJson } from "../runtime-server";

// cinatra#2218 L1 — the @cfworker/json-schema migration.
//
// `@modelcontextprotocol/server@2.0.0` dropped `@cfworker/json-schema` and moved
// JSON-Schema validation behind the `./validators/ajv` / `./validators/cf-worker`
// subpath exports. cinatra imports NEITHER: every in-repo registration passes a
// zod Standard Schema, and the retired alpha's runtime tolerance of a raw JSON
// Schema was not working validation (it produced a broken tool and a -32603 on
// tools/list). These tests pin BOTH halves of that decision:
//   (1) 2.0.0 rejects a raw JSON Schema at registration — so nothing silently
//       skips validation;
//   (2) the admission guard refuses such a value at the extension boundary
//       BEFORE it reaches registerTool, so one bad extension cannot fail the
//       whole per-request capability build.

describe("Standard Schema admission (tool inputSchema)", () => {
  it("admits a zod v4 schema", () => {
    expect(isStandardSchemaWithJson(z.object({ a: z.string() }))).toBe(true);
    expect(admitToolInputSchema(z.object({ a: z.string() })).admitted).toBe(true);
  });

  it("admits an absent schema (the caller substitutes its own default)", () => {
    expect(admitToolInputSchema(undefined).admitted).toBe(true);
    expect(admitToolInputSchema(null).admitted).toBe(true);
  });

  it("refuses a raw JSON Schema and names it as such", () => {
    const admission = admitToolInputSchema({
      type: "object",
      properties: { a: { type: "string" } },
    });
    expect(admission.admitted).toBe(false);
    expect(admission.admitted === false && admission.reason).toContain("raw JSON Schema");
  });

  it("refuses a validate-only fake with no JSON Schema converter", () => {
    const admission = admitToolInputSchema({
      "~standard": { version: 1, vendor: "fake", validate: () => ({ value: {} }) },
    });
    expect(admission.admitted).toBe(false);
  });

  it("refuses a PRESENT-but-empty jsonSchema (the SDK calls jsonSchema.input())", () => {
    const admission = admitToolInputSchema({
      "~standard": { version: 1, vendor: "fake", validate: () => ({ value: {} }), jsonSchema: {} },
    });
    expect(admission.admitted).toBe(false);
  });

  it("REFUSES a schema whose jsonSchema.input THROWS — it would kill tools/list, not registration", () => {
    const throwing = {
      "~standard": {
        version: 1,
        vendor: "fake",
        validate: () => ({ value: {} }),
        jsonSchema: {
          input: () => {
            throw new Error("converter exploded");
          },
        },
      },
    };
    const admission = admitToolInputSchema(throwing);
    expect(admission.admitted).toBe(false);
    expect(admission.admitted === false && admission.reason).toContain("converter threw");
  });

  it("REFUSES a schema whose jsonSchema.input returns a non-object root", () => {
    const badRoot = {
      "~standard": {
        version: 1,
        vendor: "fake",
        validate: () => ({ value: {} }),
        jsonSchema: { input: () => 42 },
      },
    };
    expect(admitToolInputSchema(badRoot).admitted).toBe(false);
  });

  it("refuses scalars", () => {
    for (const value of [42, "schema", true]) {
      expect(admitToolInputSchema(value).admitted).toBe(false);
    }
  });
});

// NOTE: locals are named `srv`, never `server` — see the scanner note in
// supported-revisions-inbound.test.ts.
describe("SDK behaviour the admission guard exists for", () => {
  it("server@2.0.0 THROWS when registerTool is handed a raw JSON Schema", () => {
    const srv = new McpServer({ name: "guard", version: "0.0.1" });
    expect(() =>
      (srv.registerTool as (...args: unknown[]) => unknown)(
        "raw_schema_tool",
        { description: "d", inputSchema: { type: "object", properties: { a: { type: "string" } } } },
        async () => ({ content: [] }),
      ),
    ).toThrow(/Standard Schema/);
  });

  it("a throwing converter registers CLEANLY and then fails the WHOLE tools/list with -32603", async () => {
    // This is the failure the admission probe exists to prevent: nothing throws
    // at registration, so no try/catch at the call site can catch it — the
    // outage appears the first time the list is served, for EVERY tool.
    const throwing = {
      "~standard": {
        version: 1,
        vendor: "fake",
        validate: () => ({ value: {} }),
        jsonSchema: {
          input: () => {
            throw new Error("converter exploded");
          },
        },
      },
    };
    const srv = new McpServer({ name: "guard", version: "0.0.1" });
    srv.registerTool("healthy_tool", { description: "ok", inputSchema: z.object({}) }, async () => ({
      content: [],
    }));
    expect(() =>
      (srv.registerTool as (...args: unknown[]) => unknown)(
        "throwing_converter_tool",
        { description: "d", inputSchema: throwing },
        async () => ({ content: [] }),
      ),
    ).not.toThrow();

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await srv.connect(transport);
    const res = await transport.handleRequest(
      new Request("https://cinatra.test/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    const body = (await res.json()) as { error?: { code?: number }; result?: unknown };
    expect(body.error?.code).toBe(-32603);
    expect(body.result).toBeUndefined();
    await transport.close();
  });

  it("a zod-registered tool still advertises a JSON Schema in tools/list", () => {
    const srv = new McpServer({ name: "guard", version: "0.0.1" });
    srv.registerTool(
      "zod_tool",
      { description: "d", inputSchema: z.object({ a: z.string() }) },
      async () => ({ content: [] }),
    );
    const advertised = srv.toolInputSchemaJson("zod_tool");
    expect(advertised).toMatchObject({ type: "object", properties: { a: { type: "string" } } });
  });
});
