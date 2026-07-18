import { z } from "zod";

/**
 * Build classifier output schema dynamically. The `type` field is enum-
 * constrained to the set of KNOWN, INSTALLED type ids the caller passes in —
 * the registered static/host types plus the ACTIVE dynamic rows that already
 * exist — preventing LLM output drift where a model would return "account"
 * instead of "@cinatra-ai/entity-accounts:account".
 *
 * The classifier NO LONGER MINTS dynamic type ids (epic #1785 slice C,
 * cinatra#1787 — "types exist only by installation"): a NEW `@dynamic/types:`
 * id, or ANY id the catalog has never seen, is REJECTED here at parse time.
 * An unmatched payload comes back as the generic `@cinatra-ai/objects:object`
 * id with `isNewType: true` (the host then persists it losslessly as a plain
 * object). Existing dynamic rows still ride `knownTypeIds`, so READ/classify
 * of already-minted ids is untouched — only the mint path is closed.
 */
export function buildClassifierOutputSchema(knownTypeIds: readonly string[]) {
  return z.object({
    type: z.string().refine(
      // Only ids the catalog already knows are valid — the classifier can no
      // longer propose a fresh dynamic-type id (the generic fallback id rides
      // knownTypeIds because it is a registered host type).
      (v) => knownTypeIds.includes(v),
      { message: "type must be an installed/known type id (the classifier never mints new type ids)" },
    ),
    confidence: z.number().min(0).max(1),
    normalizedData: z.record(z.string(), z.unknown()),
    isNewType: z.boolean(),
    inferredTypeName: z.string().nullish(),
    inferredCategory: z.enum(["profile", "content", "project", "idea", "report"]).nullish(),
    /** Stable key fields for layered identity resolution. */
    canonicalKeys: z.array(z.string()).nullish(),
  });
}

export type ClassifierOutput = ReturnType<typeof buildClassifierOutputSchema> extends z.ZodType<infer T> ? T : never;
