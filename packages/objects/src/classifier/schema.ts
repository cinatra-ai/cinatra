import { z } from "zod";
import { DYNAMIC_TYPE_ID_RE } from "../namespace";

/**
 * Build classifier output schema dynamically. The `type` field is enum-
 * constrained to the set of registered static types PLUS dynamic-type ids —
 * preventing LLM output drift where a model would return "account" instead
 * of "@cinatra-ai/entity-accounts:account". NEW dynamic ids mint ONLY under
 * the reserved `@dynamic/types:` scope (cinatra#1425); a legacy
 * `@cinatra-ai/dynamic:` id is accepted ONLY when it is already a known type
 * (the caller's catalog includes the ACTIVE dynamic rows) — existing rows
 * keep classifying, but a legacy-prefixed id the DB has never seen is
 * REJECTED, enforcing "legacy ids are never re-minted".
 */
export function buildClassifierOutputSchema(knownTypeIds: readonly string[]) {
  return z.object({
    type: z.string().refine(
      // knownTypeIds covers legacy ids that already exist as ACTIVE dynamic
      // rows; the NEW-mint pattern is the reserved scope ONLY.
      (v) => knownTypeIds.includes(v) || DYNAMIC_TYPE_ID_RE.test(v),
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
