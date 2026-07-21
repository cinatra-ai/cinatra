import "server-only";

/**
 * email-test-delivery passthrough seam shapers (#1625).
 *
 * Pure, zero-dependency, unit-tested (mirrors ./blog-pipeline-seam and
 * ./artifact-materialize-shaper). The passthrough route wires these into its
 * per-tool input-shaper table and its post-handler response path so the
 * CERTIFIED send primitive (packages/agents handlers.ts) stays byte-identical.
 *
 * WHY a seam is required (both directions):
 * wayflowcore 26.1.2 renders EVERY ApiNode json_body template value to a STRING
 * (`render_nested_object_template` -> `render_str_template`; a dict value that is
 * exactly `"{{ x }}"` with a list becomes the Python repr `"['a','b']"`, never a
 * native array) and the `| tojson` filter breaks OAS deserialization; AND it
 * extracts each declared ApiNode output `X` via the fixed jq query `.X` (no
 * per-output query). So the perform_test_send node can neither SEND the parsed id
 * arrays natively nor RECEIVE the renderer's nested `{lastSendResult, gateCycle}`
 * contract from the primitive's flat `{ok, sentTo, message, seq, ...}` return.
 * Both gaps are bridged here.
 */

/**
 * INPUT: the perform_test_send ApiNode forwards the gate's `testResult` envelope
 * (a JSON STRING already carrying recipientEmail / selectionMode / the two id
 * arrays) verbatim as `envelopeJson` (a string survives wayflowcore templating;
 * native arrays cannot). Parse it and PROJECT the send fields the handler reads.
 *
 * Fields are projected VERBATIM (no coercion) so the send handler's own guards
 * remain the authority: a malformed / unparseable envelope projects no
 * recipientEmail, which the handler records as an `invalid_recipient`
 * failure-as-data (it never strands the gate).
 */
export function shapeTestDeliverySendInput(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const envelopeJson = typeof raw.envelopeJson === "string" ? raw.envelopeJson : "";
  let parsed: Record<string, unknown> = {};
  if (envelopeJson.trim() !== "") {
    try {
      const p = JSON.parse(envelopeJson);
      if (p && typeof p === "object" && !Array.isArray(p)) {
        parsed = p as Record<string, unknown>;
      }
    } catch {
      // leave parsed empty — the handler's recipient guard surfaces the failure.
    }
  }
  const out: Record<string, unknown> = {};
  for (const field of [
    "recipientEmail",
    "selectionMode",
    "specificInitialDraftIds",
    "specificFollowUpDraftIds",
  ] as const) {
    if (field in parsed) out[field] = parsed[field];
  }
  return out;
}

/**
 * OUTPUT: the perform_test_send ApiNode declares the outputs its gate renderer
 * (`@cinatra-ai/email-test-delivery-agent:input`) reads back on re-entry —
 * `lastSendResult` (OBJECT `{ok, message, sentTo?}` driving the result banner)
 * and `gateCycle` (INTEGER rehydration token) — plus the sticky-form defaults.
 * The primitive returns a FLAT `{ok, sentTo, sentCount, message, deliveredDraftIds, seq}`
 * (or a failed ledger row `{ok:false, reason, message, seq}`); wayflowcore's
 * `.title` jq extraction cannot build the nested object nor rename `seq` ->
 * `gateCycle`. Reshape here.
 *
 * Returns the reshaped object ONLY for a well-formed ledger-backed result (every
 * one carries a boolean `ok`, an integer `seq`, and a string `message`). For an
 * unexpected `{error}` fault or any malformed shape it returns `null` so the
 * caller passes the raw result through UNSHAPED and the node fails visibly —
 * nothing is manufactured (no `gateCycle:0`, no empty message).
 *
 * `input` is the already-shaped request input (post `shapeTestDeliverySendInput`);
 * the sticky-form defaults echo the user's submitted selections.
 */
export function shapeTestDeliverySendResult(
  input: Record<string, unknown>,
  result: unknown,
): Record<string, unknown> | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const r = result as Record<string, unknown>;
  if (
    typeof r.ok !== "boolean" ||
    typeof r.seq !== "number" ||
    !Number.isInteger(r.seq) ||
    typeof r.message !== "string"
  ) {
    return null;
  }
  const lastSendResult: Record<string, unknown> = { ok: r.ok, message: r.message };
  if (typeof r.sentTo === "string") lastSendResult.sentTo = r.sentTo;
  return {
    lastSendResult,
    gateCycle: r.seq,
    recipientEmail: typeof input.recipientEmail === "string" ? input.recipientEmail : "",
    selectionMode:
      typeof input.selectionMode === "string" ? input.selectionMode : "random_initial",
    specificInitialDraftIds: Array.isArray(input.specificInitialDraftIds)
      ? input.specificInitialDraftIds
      : [],
    specificFollowUpDraftIds: Array.isArray(input.specificFollowUpDraftIds)
      ? input.specificFollowUpDraftIds
      : [],
  };
}
