/**
 * Narrow JSON-Schema → Zod converter used only by `mcp-tools.ts` to bridge
 * drizzle-cube/mcp's `MCPToolDefinition.inputSchema` (plain JSON Schema)
 * into the `ZodObject` shape that Cinatra's MCP server registry expects.
 *
 * Scope is intentionally tight — we only need to handle the shapes that
 * `drizzle-cube/mcp` 0.5.6 emits for the `discover`, `validate`, and
 * `load` tools. Empty / description-only / properties-less schemas
 * collapse to `z.unknown()` so drizzle-cube's downstream validation can
 * do the strict work; Cinatra's MCP layer is just a pass-through for
 * unknown shapes.
 *
 * If drizzle-cube changes its inputSchema shape on a minor bump, the
 * `json-schema-to-zod.test.ts` regression test will fail at build time
 * before the LLM ever sees a mis-typed tool definition.
 */
import { z, type ZodTypeAny } from "zod";

export type JsonSchemaNode = {
  readonly type?: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: ReadonlyArray<string>;
  readonly items?: JsonSchemaNode;
  readonly enum?: ReadonlyArray<string | number>;
  readonly additionalProperties?: JsonSchemaNode | boolean;
  readonly oneOf?: ReadonlyArray<JsonSchemaNode>;
  readonly anyOf?: ReadonlyArray<JsonSchemaNode>;
  readonly description?: string;
  // drizzle-cube includes `pattern` on string children of `load.query`. We
  // accept it for forward-compat but don't translate to a Zod `.regex()` —
  // the regex is LLM-facing guidance; drizzle-cube re-validates server-side.
  readonly pattern?: string;
};

function isEmptyShape(node: JsonSchemaNode): boolean {
  if (!node || typeof node !== "object") return true;
  const keys = Object.keys(node);
  if (keys.length === 0) return true;
  // description-only / annotation-only nodes collapse to z.unknown().
  const meaningful = keys.filter((k) => k !== "description" && k !== "pattern");
  return meaningful.length === 0;
}

/**
 * Whether we are at the ROOT of the inputSchema (depth 0).
 * drizzle-cube's documented `filters` DSL accepts BOTH the
 * per-filter shape (`{ member, operator, values }`, required member +
 * operator) AND grouped wrappers (`{ and: [...] }`, `{ or: [...] }`).
 * The JSON Schema doesn't express the alternation, so strict enforcement
 * at inner depths would silently reject valid drizzle-cube queries
 * before `cubeTools.handle()` saw them.
 *
 * Policy: only the ROOT object validates `required`. Every nested object
 * is treated as advisory — open (`passthrough`), all fields optional.
 * drizzle-cube does the real query-shape validation downstream. This
 * preserves Cinatra's vanilla integration promise.
 */
function convertNode(node: JsonSchemaNode | undefined, path: string, depth: number): ZodTypeAny {
  if (node === undefined || node === null || isEmptyShape(node ?? {})) {
    // {} or { description: "..." } → z.unknown(). drizzle-cube uses this
    // for filter `values`, `dateRange`, `compareDateRange`, and inner
    // filter shapes — pass-through is the correct semantics here.
    return z.unknown();
  }

  if (node.enum && node.enum.length > 0 && (node.type === "string" || node.type === undefined)) {
    // Zod's enum requires `string[]` literally — narrow accordingly.
    const values = node.enum.filter((v): v is string => typeof v === "string");
    if (values.length === 0) {
      throw new Error(`json-schema-to-zod: empty/non-string enum at ${path}`);
    }
    return z.enum(values as [string, ...string[]]);
  }

  switch (node.type) {
    case "string":
      return z.string();
    case "integer":
      return z.number().int();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      // Array `items` are nested — depth + 1.
      return z.array(convertNode(node.items, `${path}[]`, depth + 1));
    case "object": {
      if (!node.properties || Object.keys(node.properties).length === 0) {
        // `{ type: "object", description: "..." }` with no `properties` —
        // drizzle-cube uses this for the top-level `query` in `validate`.
        // Treat as opaque object; drizzle-cube validates downstream.
        return z.record(z.string(), z.unknown());
      }
      // ROOT (depth 0): honour `required`, use closed shape — this is the
      // top-level inputSchema that the MCP SDK uses to brief the LLM
      // about which keys the tool actually expects.
      //
      // NESTED (depth > 0): all fields optional, `.passthrough()` extra
      // keys. Inner shapes are advisory hints — drizzle-cube validates
      // the full query DSL (including alternative shapes the JSON
      // Schema doesn't express, like `{and:[...]}` filter wrappers).
      const enforceRequired = depth === 0;
      const required = new Set(node.required ?? []);
      const shape: Record<string, ZodTypeAny> = {};
      for (const [key, child] of Object.entries(node.properties)) {
        const inner = convertNode(child, `${path}.${key}`, depth + 1);
        shape[key] = enforceRequired && required.has(key) ? inner : inner.optional();
      }
      const obj = z.object(shape);
      return depth === 0 ? obj : obj.passthrough();
    }
    case undefined: {
      // description-only or annotation-only — already handled by isEmptyShape
      // above, but keep an explicit fallback for forward-compat.
      if (node.oneOf?.length || node.anyOf?.length) {
        const branches = (node.oneOf ?? node.anyOf ?? []).map((branch, idx) =>
          convertNode(branch, `${path}|${idx}`, depth + 1),
        );
        if (branches.length < 2) {
          throw new Error(`json-schema-to-zod: oneOf/anyOf needs ≥2 branches at ${path}`);
        }
        return z.union(branches as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
      }
      return z.unknown();
    }
    default:
      throw new Error(
        `json-schema-to-zod: unsupported type "${String(node.type)}" at ${path}. ` +
          `If drizzle-cube added a new schema shape on a minor bump, extend this converter.`,
      );
  }
}

/**
 * Convert a JSON-Schema root (must be an object schema) to a `z.ZodObject`.
 * The MCP SDK's `registerTool` expects a Zod object as `inputSchema`, so we
 * fail fast if the root isn't an object schema.
 */
export function jsonSchemaToZod(root: JsonSchemaNode): z.ZodObject<z.ZodRawShape> {
  if (root?.type !== "object") {
    throw new Error(
      `jsonSchemaToZod: root schema must be type "object", got ${JSON.stringify(root?.type)}`,
    );
  }
  const converted = convertNode(root, "$", 0);
  // Convert root via `convertNode` may have widened the empty-object case to
  // `z.record(...)`; ensure we return an actual `z.object(...)` instance for
  // the MCP SDK's type contract.
  if (converted instanceof z.ZodObject) {
    return converted;
  }
  // Object with no properties — promote to an empty ZodObject preserving
  // the passthrough behavior so unknown keys aren't stripped.
  return z.object({}).passthrough();
}
