import "server-only";

/**
 * email-outreach campaign-recipients-review passthrough seam shaper (cinatra#1960).
 *
 * Pure, zero-dependency, unit-tested (the recipients analogue of
 * ./drafts-review-seam). The passthrough route wires this into its per-tool
 * input-shaper table for `email_outreach_recipients_update` so the CERTIFIED
 * persist primitive (packages/agents recipients-persist-handler.ts) stays
 * byte-identical.
 *
 * The re-entrant campaign-recipients review gate's post-resume `apply` ApiNode
 * forwards the gate's `userResponse` (a JSON STRING — string-forwarded because
 * wayflowcore renders array/object templates to Python-repr) as
 * `resumePayloadJson`. This seam parses it and projects ONLY the operator's
 * EXPLICIT `removedRecipients[]` the persist primitive consumes; run scope + the
 * declaring package come from the run-bound frame, never the payload, so
 * campaignId / recipients (the kept set) / approvedRecipientIds are informational
 * and dropped here. The primitive's EXPLICIT-REMOVAL semantics make an empty
 * `removedRecipients` a non-destructive no-op — so the failure mode below is NOT
 * accidental deletion, it is a corrupt/unrecognized resume envelope.
 *
 * FAIL-CLOSED (the #1959 finding-3 posture): a present-but-unparseable /
 * unrecognized / wrong-typed payload THROWS (the shaper-throw contract -> HTTP
 * 400, the apply ApiNode fails visibly). The renderer ALWAYS emits a present
 * `removedRecipients` array (even `[]` on a clean approval or an empty snapshot),
 * so an absent/non-array `removedRecipients` is a genuine wiring/tamper fault, not
 * a valid resume.
 */

/**
 * Parse the resume payload string into its object form, unwrapping the canonical
 * attachment envelope (`{ text: <renderer JSON string>, attachments }`, produced
 * by wayflow-user-response-envelope.ts when the operator paperclipped a file).
 * Throws on any invalid/unrecognized/wrong-typed shape.
 */
export function unwrapRecipientsResumePayload(json: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(
      "email_outreach_recipients_update: resumePayloadJson is not valid JSON — refusing to resume on a corrupt recipients-review envelope.",
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
        "email_outreach_recipients_update: the wrapped resume envelope's `text` payload is not valid JSON.",
      );
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "email_outreach_recipients_update: resumePayloadJson did not resolve to a recipients-review resume payload object.",
    );
  }
  const obj = parsed as Record<string, unknown>;
  // The `removedRecipients` key MUST be a present array (the pack renderer ALWAYS
  // emits it — `buildResumePayload` sets `removedRecipients: [...]`, `[]` when the
  // operator removed nothing). An ABSENT / non-array `removedRecipients` is an
  // unrecognized payload (a wiring or tamper fault), NOT a valid resume — it fails
  // closed rather than being coerced.
  if (!Array.isArray(obj.removedRecipients)) {
    throw new Error(
      "email_outreach_recipients_update: resume payload `removedRecipients` must be a present array (an absent/non-array `removedRecipients` is an unrecognized recipients-review envelope).",
    );
  }
  return obj;
}

/**
 * INPUT shaper: parse the apply ApiNode's `resumePayloadJson` and project the
 * operator's EXPLICIT `removedRecipients[]` PLUS the kept `approvedRecipientIds`.
 * The kept ids are the surfaced-snapshot signal the primitive uses to tell a
 * legitimate zero-recipient run (empty surfaced snapshot) apart from a missing
 * bundle whose surfaced snapshot was NON-empty (a persistence gap — codex #1960
 * round-2 finding 3). An absent `resumePayloadJson` is a wiring fault (the apply
 * node ALWAYS wires it from the gate output) — so it fails visibly.
 */
export function shapeRecipientsReviewResumeInput(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const json = typeof raw.resumePayloadJson === "string" ? raw.resumePayloadJson : "";
  if (!json) {
    throw new Error(
      "email_outreach_recipients_update: resumePayloadJson is required (the gate's resume payload).",
    );
  }
  // unwrapRecipientsResumePayload guarantees `removedRecipients` is a present array (or throws).
  const payload = unwrapRecipientsResumePayload(json);
  return {
    removedRecipients: payload.removedRecipients,
    // The kept ids the renderer forwarded (the surfaced-snapshot minus removals);
    // default [] when a legacy/degenerate payload omits it.
    approvedRecipientIds: Array.isArray(payload.approvedRecipientIds) ? payload.approvedRecipientIds : [],
  };
}

/**
 * Predicate for the passthrough's fail-closed output extraction (mirrors the
 * #1959 drafts gate #2): a recipients_update handler result is a FAILURE envelope
 * when it carries an `error` or an explicit `ok:false`. The route surfaces such a
 * result as a non-2xx so the apply ApiNode (which has an unconditional edge to the
 * EndNode) FAILS the run instead of completing it after a known persist failure.
 * Pure + exported so the 422-vs-2xx decision is unit-tested without the route.
 */
export function isRecipientsReviewFailureResult(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const r = result as { ok?: unknown; error?: unknown };
  return r.ok === false || "error" in r;
}
