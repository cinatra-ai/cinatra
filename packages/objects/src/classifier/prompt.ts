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
    "2. When no registered type matches, set `isNewType: true` and set `objectTypeId` to a new ID of the form `@cinatra-ai/dynamic:<slug>` (lowercase, kebab-case).",
    "3. Return `normalizedData` as a JSON-encoded STRING — the input JSON coerced to the chosen type's shape (drop irrelevant fields, keep all identifying ones).",
    "4. Return a `confidence` between 0 and 1. Use < 0.4 only when truly uncertain.",
    "5. When proposing a new type, also return `inferredTypeName` (human-readable) and `inferredCategory` (one of: profile, content, project, idea, report).",
    "6. IMPORTANT: the `objectTypeId` field must contain the type identifier string, NOT the word 'object'.",
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
