import { z } from "zod";
import { isDynamicObjectTypeId } from "../namespace";

/**
 * Build classifier output schema dynamically. The `type` field is enum-
 * constrained to the set of registered static types PLUS any dynamic-type id
 * — preventing LLM output drift where a model would return "account" instead
 * of "@cinatra-ai/entity-accounts:account". NEW dynamic ids mint under the
 * reserved `@dynamic/types:` scope (cinatra#1425); the legacy
 * `@cinatra-ai/dynamic:` prefix stays ACCEPTED so existing DB rows keep
 * classifying (back-compat via the catalog, never re-minted).
 */
export function buildClassifierOutputSchema(knownTypeIds: readonly string[]) {
  return z.object({
    type: z.string().refine(
      (v) => knownTypeIds.includes(v) || isDynamicObjectTypeId(v),
      { message: "type must be a registered ID or @dynamic/types:<slug>" },
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
