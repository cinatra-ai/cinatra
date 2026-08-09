import { z } from "zod";

/**
 * The literal `objectTypeId` value the classifier returns when NO listed type
 * is a good match (`isNewType: true`) — the schema-valid UNMATCHED branch
 * (cinatra#2592). It is NOT a real, installed type id: it never resolves in
 * `objectTypeRegistry`, and the write path
 * (`packages/objects/src/mcp/handlers.ts`) REFUSES a save carrying
 * `isNewType: true` with the stable `OBJECTS_TYPE_NOT_REGISTERED` code
 * regardless of this value (owner ruling 2026-07-18, epic #1785: "types exist
 * only by installation" — there is no generic or low-confidence fallback save
 * any more, #1787 reversed). Kept schema-valid — rather than letting an
 * honest "no match" answer fail JSON-Schema validation and fall through as an
 * opaque parse error — so the unmatched outcome is a clean, typed branch the
 * write path maps deliberately, not an accident of a thrown exception.
 * `classifier/prompt.ts` instructs the model to emit this EXACT literal, so
 * the two files cannot silently diverge (see the drift test in
 * `src/__tests__/classifier-write-path-contract.test.ts`).
 */
export const CLASSIFIER_UNMATCHED_TYPE_ID = "unmatched" as const;

/**
 * Build classifier output schema dynamically.
 *
 * - A MATCHED result (`isNewType: false`) must name a type id from
 *   `knownTypeIds` — the set of registered types the caller's catalog showed
 *   the model — preventing drift where a model returns "account" instead of
 *   "@cinatra-ai/entity-accounts:account". The classifier NO LONGER MINTS
 *   dynamic type ids (epic #1785 slice C, cinatra#1787 — "types exist only by
 *   installation"): a NEW `@dynamic/types:` id, or ANY id the catalog has
 *   never seen, is REJECTED here at parse time. Existing dynamic rows still
 *   ride `knownTypeIds` when the caller includes them, so READ/classify of
 *   already-minted ids is untouched — only the mint path is closed.
 * - An UNMATCHED result (`isNewType: true`) must carry the fixed
 *   {@link CLASSIFIER_UNMATCHED_TYPE_ID} sentinel — never a real type id, and
 *   never the retired generic `@cinatra-ai/objects:object` id (cinatra#2592:
 *   the classifier catalog excludes that id from `knownTypeIds` entirely, so
 *   a model that still proposes it fails validation here rather than being
 *   silently accepted as a "match").
 */
export function buildClassifierOutputSchema(knownTypeIds: readonly string[]) {
  return z
    .object({
      type: z.string(),
      confidence: z.number().min(0).max(1),
      normalizedData: z.record(z.string(), z.unknown()),
      isNewType: z.boolean(),
      inferredTypeName: z.string().nullish(),
      inferredCategory: z.enum(["profile", "content", "project", "idea", "report"]).nullish(),
      /** Stable key fields for layered identity resolution. */
      canonicalKeys: z.array(z.string()).nullish(),
    })
    .superRefine((val, ctx) => {
      const valid = val.isNewType
        ? val.type === CLASSIFIER_UNMATCHED_TYPE_ID
        : knownTypeIds.includes(val.type);
      if (!valid) {
        ctx.addIssue({
          code: "custom",
          path: ["type"],
          message: val.isNewType
            ? `type must be the literal "${CLASSIFIER_UNMATCHED_TYPE_ID}" sentinel when isNewType is true (the classifier never mints new type ids)`
            : "type must be an installed/known type id (the classifier never mints new type ids)",
        });
      }
    });
}

export type ClassifierOutput = ReturnType<typeof buildClassifierOutputSchema> extends z.ZodType<infer T> ? T : never;
