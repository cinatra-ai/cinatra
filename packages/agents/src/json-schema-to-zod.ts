/**
 * Runtime JSON-Schema → Zod converter for CinatraAgentSpec enforcement.
 *
 * Converts the narrow subset of JSON Schema used by AgentTemplateRecord.inputSchema
 * and outputSchema into a Zod schema suitable for `.parse()` at agent execution
 * boundaries. Unrecognized constructs fall back to `z.record(z.unknown())` — this
 * function MUST NEVER throw, so callers can rely on a validator that at worst
 * accepts any object rather than crashing the worker.
 *
 * No "server-only" import — this is a pure utility usable from both client and
 * worker code paths. No DB imports, no React imports.
 *
 * Supported JSON Schema types:
 *   - "string"           → z.string()
 *   - "number" | "integer" → z.number()
 *   - "boolean"          → z.boolean()
 *   - "array"            → z.array(itemsZod)
 *   - "object"           → z.object({ ...properties }) with required/optional
 *
 * Anything else (unknown type, missing type, null/undefined input) falls back
 * to `z.record(z.unknown())` so the validator accepts any object shape rather
 * than crashing callers.
 */
import { z, type ZodTypeAny } from "zod";

export function jsonSchemaToZod(
  schema: Record<string, unknown> | null | undefined,
): ZodTypeAny {
  if (!schema || typeof schema !== "object") {
    // Zod v4: z.record() requires an explicit key schema as the first argument.
    return z.record(z.string(), z.unknown());
  }

  const type = (schema as { type?: string }).type;

  if (type === "string") return z.string();
  if (type === "number" || type === "integer") return z.number();
  if (type === "boolean") return z.boolean();

  if (type === "array") {
    const items = (schema as { items?: Record<string, unknown> }).items;
    return z.array(jsonSchemaToZod(items ?? {}));
  }

  if (type === "object") {
    const properties =
      (schema as { properties?: Record<string, Record<string, unknown>> })
        .properties ?? {};
    const required = ((schema as { required?: string[] }).required ?? []) as string[];

    // An object schema with NO declared properties is "any shape" — return a
    // permissive record instead of z.object({}) which rejects all keys in zod
    // v4. This supports schemas like accountScope (type: "object" with no
    // properties) and any future agent using the same pattern.
    if (Object.keys(properties).length === 0) {
      return z.record(z.string(), z.unknown());
    }

    const shape: Record<string, ZodTypeAny> = {};
    for (const [key, propSchema] of Object.entries(properties)) {
      const isRequired = required.includes(key);
      let propZod = jsonSchemaToZod(propSchema);
      // Required string fields must be non-empty — z.string() alone accepts "".
      if (isRequired && (propSchema as { type?: string }).type === "string") {
        propZod = z.string().min(1, { message: "Required" });
      }
      shape[key] = isRequired ? propZod : propZod.optional();
    }
    return z.object(shape);
  }

  // Fallback for unknown/missing type — accept any record without throwing.
  // Zod v4: z.record() requires an explicit key schema as the first argument.
  return z.record(z.string(), z.unknown());
}
