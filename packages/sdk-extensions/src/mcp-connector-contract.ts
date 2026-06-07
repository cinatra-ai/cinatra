// Shared cross-extension MCP tool/primitive STRUCTURAL contract.
//
// Lives in the SDK so a connector that registers MCP tools (or invokes host
// primitives) depends ONLY on `@cinatra-ai/sdk-extensions` for these shapes and
// never imports the internal host packages `@cinatra-ai/mcp-server` /
// `@cinatra-ai/mcp-client`. These are deliberately STRUCTURAL (no host-internal
// type imports) and modelled to be structurally EQUIVALENT to the host's real
// types: the real `McpRuntimeToolServer.registerTool` and
// `PrimitiveInvocationRequest<TInput>` are assignable to the shapes below (host
// → connector), AND a value that satisfies these shapes also satisfies the real
// host contract (connector → host). Both directions are asserted by type-level
// tests in the host so a drift in either fails the build.
//
// Consumed by apollo, crm, drupal, gmail, google-calendar, linkedin,
// media-feeds, twenty, wordpress connectors.

/**
 * Vendor-neutral Standard Schema v1 core (https://standardschema.dev) — the leaf
 * shape Zod v4 / Valibot / ArkType all carry on `~standard`, and the structural
 * subset the host MCP server's `StandardSchemaWithJSON` extends. Modelling
 * `inputSchema`/`outputSchema` as this (rather than `unknown` or a bare marker)
 * means a non-schema value (a number) AND a marker-only fake
 * (`{ "~standard": { version: 2, vendor } }`, no `validate`, wrong `version`)
 * both fail to type-check — without coupling the SDK to the MCP SDK's schema
 * machinery.
 */
/**
 * Standard Schema v1 `validate` result — the success/failure union the host's
 * `~standard.validate` returns. Typing the return as this (not `unknown`) rejects
 * a fake whose `validate` returns a scalar.
 */
export type ExtensionStandardSchemaResult =
  | { readonly value: unknown; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string }> };

/** Faithful copy of the vendored `StandardSchemaV1.Options`. */
export type ExtensionStandardSchemaOptions = {
  readonly libraryOptions?: Record<string, unknown> | undefined;
};

/** Faithful copy of the vendored `StandardJSONSchemaV1.Options` (carries `target`). */
export type ExtensionStandardJsonSchemaOptions = {
  readonly target: "draft-2020-12" | "draft-07" | "openapi-3.0" | (object & string);
  readonly libraryOptions?: Record<string, unknown> | undefined;
};

export type ExtensionStandardSchema = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
      options?: ExtensionStandardSchemaOptions | undefined,
    ) => ExtensionStandardSchemaResult | Promise<ExtensionStandardSchemaResult>;
    // The host's `StandardSchemaWithJSON` additionally requires `jsonSchema` (a
    // `{ input, output }` converter pair taking the JSON-schema `Options`) —
    // `tools/list` advertises the argument shape through it. Requiring it here,
    // with the faithful option shapes, rejects a "validate-only" fake AND a fake
    // whose converters take a narrower options param. Zod v4 / Valibot / ArkType
    // all carry it.
    readonly jsonSchema: {
      readonly input: (options: ExtensionStandardJsonSchemaOptions) => Record<string, unknown>;
      readonly output: (options: ExtensionStandardJsonSchemaOptions) => Record<string, unknown>;
    };
  };
};

/**
 * One MCP content block — the discriminated union the host's `CallToolResult`
 * uses. Modelling `type` as a literal union (not `string`) rejects an unknown
 * block type, and each member requires its mandatory fields (e.g. a `"text"`
 * block must carry `text`).
 */
export type ExtensionMcpContentBlock =
  | { type: "text"; text: string; _meta?: Record<string, unknown> }
  | { type: "image"; data: string; mimeType: string; _meta?: Record<string, unknown> }
  | { type: "audio"; data: string; mimeType: string; _meta?: Record<string, unknown> }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      mimeType?: string;
      _meta?: Record<string, unknown>;
    }
  | {
      type: "resource";
      resource:
        | { uri: string; mimeType?: string; text: string }
        | { uri: string; mimeType?: string; blob: string };
      _meta?: Record<string, unknown>;
    };

/** Faithful copy of the vendored `_meta` shape on `CallToolResult` (loose: extra keys allowed). */
export type ExtensionMcpMeta = {
  progressToken?: string | number;
  "io.modelcontextprotocol/related-task"?: { taskId: string };
  [k: string]: unknown;
};

/**
 * Structural mirror of the MCP `CallToolResult` the host returns from a tool
 * handler. `content` is REQUIRED (the real `registerTool` callback requires it);
 * `structuredContent` is a `Record` (rejects a scalar); `content` items are the
 * block union above (rejects an unknown block type / a text block missing `text`);
 * `_meta` matches the vendored shape (`progressToken: string | number`).
 */
export type ExtensionMcpToolResult = {
  content: ExtensionMcpContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: ExtensionMcpMeta;
};

/**
 * The config object accepted by `registerTool`. `inputSchema` is OPTIONAL, which
 * covers BOTH input-bearing tools (pass a Standard Schema) and no-input tools
 * (omit it) without a discriminated overload.
 */
/** Faithful copy of the vendored `ToolAnnotations` (all hints, typed). */
export type ExtensionToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type ExtensionMcpToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: ExtensionStandardSchema;
  outputSchema?: ExtensionStandardSchema;
  annotations?: ExtensionToolAnnotations;
  _meta?: Record<string, unknown>;
};

/**
 * The minimal tool-registration surface a connector's `registerCapabilities`
 * needs from the host MCP server. The host passes its real `McpRuntimeToolServer`
 * (whose `registerTool` is the MCP SDK's overloaded generic method); this
 * structural shape captures the `(name, config, handler)` call connectors make,
 * tight enough that an invalid `inputSchema` or handler-result is rejected.
 */
export type ExtensionMcpToolServer = {
  registerTool(
    name: string,
    config: ExtensionMcpToolConfig,
    handler: (
      input: unknown,
      extra: unknown,
    ) => ExtensionMcpToolResult | Promise<ExtensionMcpToolResult>,
  ): unknown;
};

/**
 * Structural mirror of `@cinatra-ai/mcp-client`'s `PrimitiveInvocationRequest`.
 * `actor` is `unknown` (the SDK does not enumerate the host actor shape) and
 * `mode` is the `PrimitiveInvocationMode` string union widened to `string` so
 * the contract carries no host-internal dependency. The key set MUST match the
 * real request (asserted by a drift check in the host test).
 */
export type ExtensionPrimitiveRequest<TInput = unknown> = {
  primitiveName: string;
  input: TInput;
  actor: unknown;
  mode: string;
  idempotencyKey?: string;
};
