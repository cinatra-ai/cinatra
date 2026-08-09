import { CLASSIFIER_UNMATCHED_TYPE_ID } from "./schema";

export type TypeCatalogEntry = {
  type: string;
  category: string;
  schemaSummary: string;
};

/**
 * Build the classifier's system prompt from a CATALOG the caller already
 * filtered to writable, installed types (cinatra#2592: the caller —
 * `classifier/index.ts` — excludes the retired generic
 * `@cinatra-ai/objects:object` id and any other handler-refused id before
 * calling this function). This function does not re-filter; it only renders
 * whatever catalog it is given.
 *
 * Outcome contract (must stay byte-aligned with the write path's fail-closed
 * ladder in `packages/objects/src/mcp/handlers.ts` and the schema-level gate
 * in `./schema.ts` — owner ruling 2026-07-18, epic #1785, "types exist only
 * by installation"): a save persists ONLY when the classifier returns a
 * matched, confident (>= 0.4), registered type. There is no generic or
 * low-confidence fallback save any more (#1787 reversed) — an unmatched or
 * low-confidence result is REFUSED at the write boundary, never persisted
 * under any catch-all.
 */
export function buildClassifierSystemPrompt(catalog: readonly TypeCatalogEntry[]): string {
  const lines = catalog.map(
    (c) => `- ${c.type} (${c.category}): ${c.schemaSummary}`,
  );
  return [
    "You are a classifier for Cinatra's object store.",
    "Given a JSON payload produced by an agent, pick the registered type that best matches.",
    "",
    "Registered types:",
    ...lines,
    "",
    "Rules:",
    "1. Pick an EXACT type ID from the list above when a good match exists. Set `objectTypeId` to that exact string and `isNewType` to false.",
    `2. When NO listed type is a good match, set \`isNewType: true\` and set \`objectTypeId\` to the literal string "${CLASSIFIER_UNMATCHED_TYPE_ID}". NEVER invent a new type ID and NEVER propose a generic or catch-all type — the platform REFUSES an unmatched save; it is never persisted under any fallback name.`,
    `3. Return \`normalizedData\` as a JSON-encoded STRING — the input JSON coerced to the chosen type's shape (drop irrelevant fields, keep all identifying ones). When you set \`objectTypeId\` to "${CLASSIFIER_UNMATCHED_TYPE_ID}" (rule 2) this field is ignored (the save is refused, not persisted), so returning the input unchanged is fine.`,
    "4. Return an HONEST `confidence` between 0 and 1 — never inflate it to avoid a refusal. A save persists only at confidence >= 0.4 AND a matched type; anything below 0.4 is refused exactly like an unmatched result — there is no low-confidence fallback save.",
    `5. When you set \`objectTypeId\` to "${CLASSIFIER_UNMATCHED_TYPE_ID}" (rule 2), also return \`inferredTypeName\` (a human-readable name for what you saw) and \`inferredCategory\` (one of: profile, content, project, idea, report) — they annotate the refusal for diagnostics only; they do not change the outcome.`,
    "6. IMPORTANT: for a MATCHED type (rule 1), `objectTypeId` must be a FULL namespaced type ID string (e.g. `@cinatra-ai/campaigns:campaign`), never the bare word 'object' or a JSON Schema keyword.",
  ].join("\n");
}

/** Summarize a Zod schema to one line of text for the classifier prompt. */
export function summarizeZodSchema(schema: unknown): string {
  try {
    // Best-effort — Zod 4 has `_def.shape` on objects; fall back to a generic marker.
    const shape = (schema as { _def?: { shape?: Record<string, unknown> } })?._def?.shape;
    if (shape && typeof shape === "object") {
      return `fields: ${Object.keys(shape).slice(0, 6).join(", ")}${Object.keys(shape).length > 6 ? ", …" : ""}`;
    }
  } catch {
    // fall through
  }
  return "free-form object";
}
