export type TypeCatalogEntry = {
  type: string;
  category: string;
  schemaSummary: string;
};

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
    "1. Pick an EXACT type ID from the list above when a good match exists. Set `objectTypeId` to that exact string.",
    "2. When no listed type is a good match, set `isNewType: true` and set `objectTypeId` to the generic type `@cinatra-ai/objects:object`. NEVER invent a new type ID — types exist only by installation; the host saves an unmatched payload losslessly as a generic object.",
    "3. Return `normalizedData` as a JSON-encoded STRING — the input JSON coerced to the chosen type's shape (drop irrelevant fields, keep all identifying ones). For the generic `@cinatra-ai/objects:object` fallback this field is ignored (the host persists the original payload), so returning the input unchanged is fine.",
    "4. Return a `confidence` between 0 and 1. Use < 0.4 only when truly uncertain; a low-confidence payload is also saved losslessly as a generic object.",
    "5. When you set the generic fallback (rule 2), also return `inferredTypeName` (a human-readable name for what you saw) and `inferredCategory` (one of: profile, content, project, idea, report) — they annotate the fallback warning.",
    "6. IMPORTANT: `objectTypeId` must be a FULL namespaced type ID string (e.g. `@cinatra-ai/objects:object`), never the bare word 'object' or a JSON Schema keyword.",
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
