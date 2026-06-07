import { z } from "zod";

/**
 * Build classifier output schema dynamically. The `type` field is enum-
 * constrained to the set of registered static types PLUS any string starting
 * with `@cinatra-ai/dynamic:` — preventing LLM output drift where a model would
 * return "account" instead of "@cinatra-ai/entity-accounts:account".
 */
export function buildClassifierOutputSchema(knownTypeIds: readonly string[]) {
  const dynamicTypePattern = /^@cinatra-ai\/dynamic:[a-z0-9-]+$/;
  return z.object({
    type: z.string().refine(
      (v) => knownTypeIds.includes(v) || dynamicTypePattern.test(v),
      { message: "type must be a registered ID or @cinatra-ai/dynamic:<slug>" },
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
