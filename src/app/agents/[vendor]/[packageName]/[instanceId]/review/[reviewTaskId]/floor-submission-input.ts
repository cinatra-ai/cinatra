import "server-only";

import { z } from "zod";

import {
  MAX_SUGGESTION_ID_CHARS,
  MAX_SUGGESTION_PARTITION_IDS,
  type SuggestionDecisionPartition,
} from "@/lib/artifacts/artifact-review-decision";

/**
 * THE ONE INPUT VALIDATOR for a review-floor submission (cinatra#3080).
 *
 * The decision helper (`submitReviewDecisionAction`) has two client-facing
 * entries: the gate-scoped decide route (`/api/lifecycle-views/decide`) and the
 * review page's route-bound server action. Both are reachable by a client that
 * writes its own request, so both parse THIS schema before the helper runs. A
 * bound lives here once; neither entry carries a number of its own, so the two
 * cannot drift into a stronger and a weaker door to the same action.
 */

/** The note (section VI) and the Regenerate prompt are each at most this long. */
export const REVIEW_FLOOR_TEXT_MAX_CHARS = 10_000;

const floorText = z.string().max(REVIEW_FLOOR_TEXT_MAX_CHARS).nullable().optional();

/**
 * The submission's own fields, as a shape the decide route spreads into its
 * request body (beside `kind` and `ref`) and the page parses on its own.
 */
export const REVIEW_FLOOR_SUBMISSION_FIELDS = {
  // The review floor (cinatra#3080): Comment, Regenerate and Continue. Continue
  // keeps approve persistence; `approve` stays the compatibility alias and
  // `reject` is answered by the one entry with the platform's sentence. The
  // card's composer posts `conversation-comment`, the conversation's own
  // submission, which keeps the change road the typed words had before.
  disposition: z.enum(["comment", "regenerate", "continue", "conversation-comment", "approve", "reject"]),
  // The note (section VI) - optional on Continue, the words a Regenerate works from,
  // and the substance of a comment. Bounded so a card cannot post an essay.
  comment: floorText,
  // The recorded prompt a Regenerate sends back with the note (cinatra#3080
  // item 5); every other action ignores it.
  regeneratePrompt: floorText,
  // The reviewer's per-item SUGGESTION choices (cinatra#2571, epic #2564 S6b),
  // carried ON the one terminal decision - there is deliberately no per-item
  // endpoint (#2047 row 8). Bounded here on SHAPE only: which ids are legitimate
  // is decided against the gate's PINNED snapshot inside the decision core, and
  // a request that sends more ids than a snapshot can hold is rejected before
  // any store is touched.
  suggestionDecisions: z
    .object({
      accepted: z.array(z.string().min(1).max(MAX_SUGGESTION_ID_CHARS)).max(MAX_SUGGESTION_PARTITION_IDS).optional(),
      dismissed: z.array(z.string().min(1).max(MAX_SUGGESTION_ID_CHARS)).max(MAX_SUGGESTION_PARTITION_IDS).optional(),
    })
    .strict()
    .nullable()
    .optional(),
};

/** The page action's whole input: the submission fields and nothing else. */
export const reviewFloorSubmissionInputSchema = z.object(REVIEW_FLOOR_SUBMISSION_FIELDS).strict();

/** The sentence a malformed or over-long submission is answered with. */
export const REVIEW_FLOOR_SUBMISSION_INVALID = `This decision could not be sent: the note and the prompt are each limited to ${REVIEW_FLOOR_TEXT_MAX_CHARS.toLocaleString("en-US")} characters.`;

/**
 * The partition the decision helper takes, from a parsed submission: absent
 * stays absent (`null`); a supplied one gets both lists, so the helper sees one
 * shape whichever entry it came through.
 */
export function partitionFromFloorSubmissionInput(input: {
  suggestionDecisions?: { accepted?: string[]; dismissed?: string[] } | null;
}): SuggestionDecisionPartition | null {
  const partition = input.suggestionDecisions ?? null;
  return partition ? { accepted: partition.accepted ?? [], dismissed: partition.dismissed ?? [] } : null;
}
