import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import type { PrimitiveInvocationRequest } from "@cinatra-ai/mcp-client";
import type {
  ExtensionMcpToolServer,
  ExtensionPrimitiveRequest,
} from "@cinatra-ai/sdk-extensions/mcp-contract";

// The structural SDK `mcp-contract` types exist so connectors
// (apollo, crm, drupal, gmail, google-calendar, linkedin, media-feeds, twenty,
// wordpress) can register MCP tools / invoke host primitives WITHOUT importing the
// internal host packages `@cinatra-ai/mcp-server` / `@cinatra-ai/mcp-client`. These
// type-level assertions PROVE the host's real types satisfy the structural SDK
// shapes AND that the structural shapes are tight enough to reject invalid calls —
// a drift in either direction fails `pnpm typecheck`, de-risking every consumer PR.

// NOTE: the mock tool-server param is named `srv` (not `server`) on purpose — the
// authz-inventory scanner (scripts/build-authz-inventory.mjs) inventories REAL MCP
// primitives by matching a registerTool call on a variable literally named server.
// These are type-assertion calls, not real registrations, so the mock stays `srv`
// to avoid polluting the generated inventory.

// (a) concrete → structural: the host's real overloaded tool server must be usable
// where a connector expects the minimal `ExtensionMcpToolServer`.
const _serverAssignable: ExtensionMcpToolServer = {} as McpRuntimeToolServer;

// (b) concrete → structural: the host's real primitive request must be usable where
// a connector expects the structural `ExtensionPrimitiveRequest`, for any TInput.
type ProbeInput = { channelUrl: string };
const _requestAssignable: ExtensionPrimitiveRequest<ProbeInput> =
  {} as PrimitiveInvocationRequest<ProbeInput>;

// (c) drift guard: the structural request must not invent a key the real request
// lacks (a typo'd/extra key would silently let a connector build an invalid request).
type _ExtraKeys = Exclude<
  keyof ExtensionPrimitiveRequest<unknown>,
  keyof PrimitiveInvocationRequest<unknown>
>;
const _noExtraRequestKeys: _ExtraKeys extends never ? true : false = true;

// (d) consumer-call: the real registration pattern connectors use must type-check
// against the structural server (a Standard Schema inputSchema + a tool-result handler).
function exerciseConsumerCall(srv: ExtensionMcpToolServer): void {
  srv.registerTool(
    "media_feed_youtube_list",
    {
      title: "YouTube list",
      description: "List uploads from a YouTube channel.",
      inputSchema: z.object({ channelUrl: z.string() }),
    },
    async (input: unknown) => ({
      content: [{ type: "text", text: JSON.stringify(input) }],
      structuredContent: { ok: true },
    }),
  );
  // a no-input tool (inputSchema omitted) must also type-check.
  srv.registerTool(
    "thing_ping",
    { description: "no input" },
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );
}

// (e) tightness: invalid `inputSchema` values MUST be rejected. If any of these
// stops erroring, the structural contract has regressed and consumers could compile
// calls the real host cannot accept.
function rejectsGarbageInputSchema(srv: ExtensionMcpToolServer): void {
  srv.registerTool(
    "bad_tool_number",
    // @ts-expect-error — inputSchema must be a Standard Schema, not a number.
    { description: "bad", inputSchema: 42 },
    async () => ({ content: [] }),
  );
  srv.registerTool(
    "bad_tool_marker",
    // @ts-expect-error — a validate-only fake (no jsonSchema) is not a host-acceptable Standard Schema.
    { description: "bad", inputSchema: { "~standard": { version: 1, vendor: "fake", validate: () => ({ value: {} }) } } },
    async () => ({ content: [] }),
  );
  srv.registerTool(
    "bad_validate_return",
    // @ts-expect-error — `~standard.validate` must return a Standard Schema result, not a scalar.
    { description: "bad", inputSchema: { "~standard": { version: 1, vendor: "fake", validate: () => 123, jsonSchema: { input: (_o: any) => ({}), output: (_o: any) => ({}) } } } },
    async () => ({ content: [] }),
  );
  srv.registerTool(
    "bad_narrow_options",
    // @ts-expect-error — converter options param must accept the host's wider Options (with `target`), not a narrower shape.
    { description: "bad", inputSchema: { "~standard": { version: 1, vendor: "fake", validate: (_v: unknown, _o?: { required: string }) => ({ value: {} }), jsonSchema: { input: (_o: { required: string }) => ({}), output: (_o: { required: string }) => ({}) } } } },
    async () => ({ content: [] }),
  );
  srv.registerTool(
    "bad_annotations",
    // @ts-expect-error — a ToolAnnotations hint must be the typed shape (readOnlyHint is boolean, not string).
    { description: "bad", annotations: { readOnlyHint: "yes" } },
    async () => ({ content: [] }),
  );
}

// (f) tightness: a malformed handler result MUST be rejected — missing content, a
// scalar structuredContent, an unknown content block type, and a text block missing `text`.
function rejectsMalformedResult(srv: ExtensionMcpToolServer): void {
  srv.registerTool(
    "bad_missing_content",
    { description: "no content" },
    // @ts-expect-error — content is required on a tool result.
    async () => ({ structuredContent: { ok: true } }),
  );
  srv.registerTool(
    "bad_struct",
    { description: "scalar structuredContent" },
    // @ts-expect-error — structuredContent must be an object record, not a scalar.
    async () => ({ content: [], structuredContent: 7 }),
  );
  srv.registerTool(
    "bad_block_type",
    { description: "unknown block type" },
    // @ts-expect-error — content block `type` must be a known literal.
    async () => ({ content: [{ type: "totally_made_up" }] }),
  );
  srv.registerTool(
    "bad_text_block",
    { description: "text block missing text" },
    // @ts-expect-error — a "text" content block must carry `text`.
    async () => ({ content: [{ type: "text" }] }),
  );
  srv.registerTool(
    "bad_meta_progress",
    { description: "bad _meta progressToken" },
    // @ts-expect-error — _meta.progressToken must be string | number, not a boolean.
    async () => ({ content: [], _meta: { progressToken: true } }),
  );
}

describe("extension mcp-contract assignability", () => {
  it("keeps the structural SDK types in sync with the host mcp-server/mcp-client types", () => {
    // Compile-time is the real assertion; this keeps vitest happy and references
    // the bindings so they are not tree-shaken out of the type-check.
    expect(typeof _serverAssignable).toBe("object");
    expect(typeof _requestAssignable).toBe("object");
    expect(_noExtraRequestKeys).toBe(true);
    expect(typeof exerciseConsumerCall).toBe("function");
    expect(typeof rejectsGarbageInputSchema).toBe("function");
    expect(typeof rejectsMalformedResult).toBe("function");
  });
});
