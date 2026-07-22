import "server-only";

/**
 * email-outreach drafts-review passthrough seam shaper (cinatra#1959).
 *
 * Pure, zero-dependency, unit-tested (mirrors ./test-delivery-seam and
 * ./blog-pipeline-seam). The passthrough route wires this into its per-tool
 * input-shaper table for `email_outreach_initial_drafts_update` so the CERTIFIED
 * persist primitive (packages/agents drafts-persist-handler.ts) stays
 * byte-identical.
 *
 * The re-entrant drafts / follow-ups review gate's post-resume `apply` ApiNode
 * forwards the gate's `userResponse` (a JSON STRING — string-forwarded because
 * wayflowcore renders array/object templates to Python-repr) as
 * `resumePayloadJson`. This seam parses it and projects ONLY the per-recipient
 * `drafts[]` the persist primitive consumes; run scope + the declaring package
 * come from the run-bound frame, never the payload, so campaignId /
 * approvedDraftIds / editedIds are informational and dropped here.
 *
 * FAIL-CLOSED (codex #1959 finding 3): a present-but-unparseable / unrecognized
 * / wrong-typed payload THROWS (the shaper-throw contract -> HTTP 400, the apply
 * ApiNode fails visibly) rather than degrading to `{ drafts: [] }` — silently
 * discarding the operator's approved edits is the exact fail-open codex flagged.
 * An intentionally-empty reviewed set (`{ drafts: [] }` in a VALID payload) is
 * preserved and passes to the primitive's benign no-op.
 */

/**
 * Parse the resume payload string into its object form, unwrapping the canonical
 * attachment envelope (`{ text: <renderer JSON string>, attachments }`, produced
 * by wayflow-user-response-envelope.ts when the operator paperclipped a file).
 * Throws on any invalid/unrecognized/wrong-typed shape.
 */
export function unwrapDraftsResumePayload(json: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(
      "email_outreach_initial_drafts_update: resumePayloadJson is not valid JSON — refusing to persist an empty edit set over the operator's approved drafts.",
    );
  }
  // Unwrap the attachment envelope: the renderer's payload string is nested in `text`.
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    typeof (parsed as Record<string, unknown>).text === "string" &&
    Array.isArray((parsed as Record<string, unknown>).attachments)
  ) {
    try {
      parsed = JSON.parse((parsed as Record<string, unknown>).text as string);
    } catch {
      throw new Error(
        "email_outreach_initial_drafts_update: the wrapped resume envelope's `text` payload is not valid JSON.",
      );
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "email_outreach_initial_drafts_update: resumePayloadJson did not resolve to a drafts-review resume payload object.",
    );
  }
  const obj = parsed as Record<string, unknown>;
  // The `drafts` key MUST be a present array (the pack renderer ALWAYS emits it —
  // `buildResumePayload` sets `drafts: [...]`). An ABSENT `drafts` key is an
  // unrecognized payload, NOT an intentional empty approval — it fails closed
  // rather than degrading to `{ drafts: [] }` and silently dropping the operator's
  // approval (the exact stage-2 finding-3 fail-open). Only an EXPLICIT `drafts: []`
  // in a valid payload is a valid empty reviewed set.
  if (!Array.isArray(obj.drafts)) {
    throw new Error(
      "email_outreach_initial_drafts_update: resume payload `drafts` must be a present array (an absent/non-array `drafts` is an unrecognized payload — refusing to persist an empty edit set over the operator's approved drafts).",
    );
  }
  return obj;
}

/**
 * INPUT shaper: parse the apply ApiNode's `resumePayloadJson` and project the
 * per-recipient `drafts[]` batch. An absent `resumePayloadJson` is a wiring
 * fault (the apply node ALWAYS wires it from the gate output), not an empty
 * approval — so it fails visibly.
 */
export function shapeDraftsReviewResumeInput(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const json = typeof raw.resumePayloadJson === "string" ? raw.resumePayloadJson : "";
  if (!json) {
    throw new Error(
      "email_outreach_initial_drafts_update: resumePayloadJson is required (the gate's resume payload).",
    );
  }
  // unwrapDraftsResumePayload guarantees `drafts` is a present array (or throws).
  const payload = unwrapDraftsResumePayload(json);
  return { drafts: payload.drafts };
}

/**
 * Predicate for the passthrough's fail-closed output extraction (cinatra#1959
 * gate #2): a drafts_update handler result is a FAILURE envelope when it carries
 * an `error` or an explicit `ok:false`. The route surfaces such a result as a
 * non-2xx so the apply ApiNode (which has an unconditional edge to the EndNode)
 * FAILS the run instead of completing it after a known persist failure. Pure +
 * exported so the 422-vs-2xx decision is unit-tested without the route.
 */
export function isDraftsReviewFailureResult(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const r = result as { ok?: unknown; error?: unknown };
  return r.ok === false || "error" in r;
}
