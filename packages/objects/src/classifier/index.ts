import "server-only";
import {
  resolveConfiguredLlmRuntime,
  runResolvedDeterministicLlmTask,
  parseStructuredJson,
} from "@cinatra-ai/llm";
import { objectTypeRegistry } from "../registry";
import { readActiveDynamicObjectTypes } from "../auto-registrar";
import { buildClassifierOutputSchema, type ClassifierOutput } from "./schema";
import { buildClassifierSystemPrompt, summarizeZodSchema } from "./prompt";

/**
 * JSON Schema for structured output — passed to the LLM provider as the
 * `outputSchema` field (type: Record<string, unknown>). This is the JSON
 * Schema representation of `ClassifierOutput`; the Zod schema in schema.ts
 * is used for post-parse validation only.
 */
// normalizedData is serialized as a JSON string because OpenAI structured output
// requires additionalProperties: false on every nested object — which is incompatible
// with a free-form key/value map. The LLM outputs it as a JSON string; we parse it
// back to an object before Zod validation.
// "type" is renamed to "objectTypeId" in the JSON Schema to avoid gpt-4o-mini
// confusing the output field with the JSON Schema keyword "type":"object".
// We remap objectTypeId → type before Zod validation.
const CLASSIFIER_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["objectTypeId", "confidence", "normalizedData", "isNewType", "inferredTypeName", "inferredCategory", "canonicalKeys"],
  properties: {
    objectTypeId: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    normalizedData: { type: "string" },
    isNewType: { type: "boolean" },
    inferredTypeName: { anyOf: [{ type: "string" }, { type: "null" }] },
    inferredCategory: {
      anyOf: [
        { type: "string", enum: ["profile", "content", "project", "idea", "report"] },
        { type: "null" },
      ],
    },
    canonicalKeys: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
  },
};

/**
 * Classify raw agent output against the registered type catalog.
 *
 * - Confidence ≥ 0.8 → matched type, caller writes to Graphiti with that type.
 * - Confidence 0.4–0.8 → matched with low-confidence flag; caller writes but
 *   stores the flag.
 * - Confidence < 0.4 OR isNewType=true → caller invokes
 *   `ensureDynamicObjectType()` before write.
 *
 * Short-circuit: when typeHint exactly matches a statically registered type,
 * skip the LLM call entirely and return high-confidence (1.0). This avoids
 * the actorContext ALS requirement that blocks objects_save calls made from
 * within MCP tool handlers (which run outside the llm ALS frame).
 */
export async function classifyObject(
  rawData: unknown,
  typeHint?: string,
  options?: { model?: string },
): Promise<ClassifierOutput> {
  // ---------------------------------------------------------------------------
  // Fast-path: typeHint exactly matches a registered static type.
  // Skip LLM classification — the caller already knows the type. Normalise the
  // rawData as-is (LLM normalisation is optional for known types) and return
  // confidence=1.0 so objects_save never invokes ensureDynamicObjectType.
  // ---------------------------------------------------------------------------
  if (typeHint) {
    const staticEntry = objectTypeRegistry.resolve(typeHint);
    if (staticEntry) {
      const normalized = typeof rawData === "object" && rawData !== null
        ? rawData as Record<string, unknown>
        : {};
      return {
        type: typeHint,
        confidence: 1.0,
        normalizedData: normalized,
        isNewType: false,
        inferredTypeName: staticEntry.type,
        inferredCategory: staticEntry.category as "profile" | "content" | "project" | "idea" | "report" | null | undefined,
        canonicalKeys: null,
      };
    }
  }

  const runtime = await resolveConfiguredLlmRuntime();
  if (!runtime) {
    throw new Error(
      "[objects:classifier] No LLM provider configured. Configure OpenAI, Anthropic, or Gemini in settings.",
    );
  }

  const staticTypes = objectTypeRegistry.list();
  const dynamicTypes = await readActiveDynamicObjectTypes();
  const catalog = [
    ...staticTypes.map((t) => ({
      type: t.type,
      category: t.category,
      schemaSummary: summarizeZodSchema(t.schema),
    })),
    ...dynamicTypes.map((t) => ({
      type: t.type,
      category: t.inferredCategory,
      schemaSummary: "dynamic — free-form object",
    })),
  ];

  const knownTypeIds = catalog.map((c) => c.type);
  const zodOutputSchema = buildClassifierOutputSchema(knownTypeIds);

  const system = buildClassifierSystemPrompt(catalog);
  const user = JSON.stringify({ rawData, typeHint });

  const response = await runResolvedDeterministicLlmTask({
    runtime,
    system,
    user,
    model: options?.model,
    outputSchema: CLASSIFIER_OUTPUT_JSON_SCHEMA,
    maxSteps: 1,
    maxOutputTokens: 4096,
    logLabel: "objects-classify",
  });

  // Parse the LLM text response and validate with the Zod schema (enum constraint).
  const raw = parseStructuredJson<Record<string, unknown>>(response.text ?? "");
  if (raw == null) {
    throw new Error("[objects:classifier] LLM returned empty or non-JSON response.");
  }

  // Remap objectTypeId → type (field was renamed in JSON Schema to avoid collision
  // with JSON Schema's "type" keyword which confuses smaller models like gpt-4o-mini).
  if ("objectTypeId" in raw && !("type" in raw)) {
    raw.type = raw.objectTypeId;
    delete raw.objectTypeId;
  }

  // normalizedData was serialized as a JSON string by the LLM (see schema comment above).
  if (typeof raw.normalizedData === "string") {
    try {
      raw.normalizedData = JSON.parse(raw.normalizedData) as Record<string, unknown>;
    } catch {
      throw new Error("[objects:classifier] LLM returned non-JSON normalizedData string.");
    }
  }

  const parsed = zodOutputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `[objects:classifier] LLM output failed schema validation: ${parsed.error.message}`,
    );
  }

  return parsed.data;
}
