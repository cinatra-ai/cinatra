// Platform-supplied flow inputs — the ONE definition of the flow-input titles
// the platform itself writes into an agent run's start message (cinatra#3003).
//
// WHY THIS EXISTS. Two different notions of "must be supplied" meet at dispatch:
//
//   - The RUNTIME's rule is the input declaration itself. A flow input with no
//     `default` MUST be present in the start message or `start_conversation`
//     refuses the run outright ("Cannot start conversation because of missing
//     inputs ..."), before any model call.
//   - The APP's rule is the start node's declared list: the compiled input
//     schema takes `required` from `metadata.cinatra.required`, and the setup
//     loop collects only those fields.
//
// An input can fall between them: no `default` (so the runtime demands it) and
// not in `metadata.cinatra.required` (so no setup step ever collects it). Such
// an input is satisfiable ONLY if the platform writes it unprompted. This
// module is the authoritative list of exactly which titles those are, so the
// pre-dispatch check and the dispatcher can never disagree about it.
//
// Consumed by:
//   - packages/agents/src/wayflow-dispatch-payload.ts (the dispatcher: it
//     writes PLATFORM_SUPPLIED_RUN_ID_KEY into every A2A initial message);
//   - packages/agents/src/validate-oas-runtime-invariants.ts (OAS-RUNTIME-014:
//     an input that is neither defaulted, nor app-required, nor in this set is
//     unsatisfiable and is refused before it can arm a schedule);
//   - packages/agents/src/execution.ts (the pre-dispatch guard that fails such
//     a run with a named message instead of letting the runtime refuse it).
//
// Dependency-free on purpose (imported by build scripts, TS host code via
// `allowJs`, and tests), following scripts/extensions/agent-binding-kinds.mjs.

/**
 * The dispatch-owned run-identity key. `buildWayflowInitialMessagePayload`
 * writes it into EVERY initial message, so a flow declaring it never needs a
 * default or a setup step.
 */
export const PLATFORM_SUPPLIED_RUN_ID_KEY = "cinatra_run_id";

/**
 * The legacy spelling of the same value. The container loader
 * (`docker/wayflow/agent_loader.py::_extract_start_inputs`) copies
 * `cinatra_run_id` across to `agent_run_id` when the parsed start inputs carry
 * the former but not the latter, so a flow declaring EITHER spelling is served.
 */
export const PLATFORM_SUPPLIED_RUN_ID_ALIAS = "agent_run_id";

/**
 * The reserved per-run token key. MUST equal `CINATRA_RUN_TOKEN_MESSAGE_KEY`
 * in src/lib/agent-run-token.ts — pinned by an equality assertion in
 * packages/agents/src/__tests__/platform-supplied-flow-inputs.test.ts so the
 * two spellings cannot drift.
 *
 * DELIBERATELY NOT in `PLATFORM_SUPPLIED_FLOW_INPUTS`. Dispatch writes it into
 * the message, but the container loader POPS it back out
 * (`_extract_and_scrub_run_token`) BEFORE `_extract_start_inputs` parses the
 * start inputs, so it never reaches `start_conversation(inputs=...)`. A flow
 * declaring it as an input without a default would still be refused — treating
 * it as supplied would be a false exemption, not a convenience.
 */
export const PLATFORM_SUPPLIED_RUN_TOKEN_KEY = "__cinatra_run_token__";

/**
 * Every flow-input title that SURVIVES into `start_conversation(inputs=...)`
 * without anybody being asked for it.
 *
 * The membership test is the LOADER BOUNDARY, not "dispatch wrote it": a key
 * dispatch writes and the loader then scrubs (the run token) never reaches the
 * flow, so it does not belong here. Exactly the run id and its loader-created
 * alias do.
 *
 * LOAD-BEARING: dropping a title from this set makes OAS-RUNTIME-014 and the
 * pre-dispatch guard refuse an agent whose input the platform really does
 * supply. Adding a title asserts that a product path writes it AND that it
 * survives the loader — do not add one without both.
 *
 * NOT in this set, deliberately: `packageSlug`. No product path writes it, and
 * its meaning is package-specific (for the author agent it is the package being
 * AUTHORED; for the reviewer agents the package UNDER REVIEW) — never the
 * running agent's own slug, so dispatch cannot synthesize it.
 */
export const PLATFORM_SUPPLIED_FLOW_INPUTS = Object.freeze([
  PLATFORM_SUPPLIED_RUN_ID_KEY,
  PLATFORM_SUPPLIED_RUN_ID_ALIAS,
]);

/** True when `title` is written into the start message by the platform. */
export function isPlatformSuppliedFlowInput(title) {
  return PLATFORM_SUPPLIED_FLOW_INPUTS.includes(title);
}

/**
 * Bounded, per-(package, input) exemptions from OAS-RUNTIME-014.
 *
 * NOT a widening switch: an entry names ONE input on ONE package, so a new
 * package in the same shape — and a new hidden input on a listed package —
 * is still refused. Every entry states why the shape is tolerated there.
 * Pinned verbatim by a test so it cannot grow unnoticed.
 *
 * NOTE ON WHAT AN EXEMPTION MEANS. It records that a KNOWN CALLER always
 * pre-supplies this input on the run. It is not a claim that the shape is fine:
 * naming a hidden input in `metadata.cinatra.required` does NOT make it
 * collectable (the setup loop drops every `x-hidden` field from `pendingFields`
 * whether or not it is required, and neither the `agent_run` tool nor the
 * published agent tools enforce a template's required list), so `required` is
 * deliberately NOT a door in either check — an exemption is the only way to say
 * "a specific caller supplies this", and it has to be written down.
 *
 * The three email-campaign agents below are sub-agents of the
 * `@cinatra-ai/email-outreach-agent` pipeline, which creates their runs with
 * `campaignId` (and the drafting agent's `confirmedRecipients`) already in
 * `inputParams` — `mcp/test-delivery-handlers.ts` reads
 * `run.inputParams.campaignId` straight back out. None of them is in the set a
 * fresh instance installs. Their STANDALONE mounts carry the same latent
 * refusal these entries describe, and want their own change.
 */
export const OAS_RUNTIME_014_EXEMPTIONS = Object.freeze({
  "@cinatra-ai/email-drafting-agent": Object.freeze([
    "campaignId",
    "confirmedRecipients",
  ]),
  "@cinatra-ai/email-follow-up-agent": Object.freeze(["campaignId"]),
  "@cinatra-ai/email-test-delivery-agent": Object.freeze(["campaignId"]),
  // `@cinatra-ai/context-selection-agent` is only ever INLINED: the blog and
  // email pipelines declare it as a runtime dependency and embed it as a
  // subflow, and its ApiNodes are documented as "called by the
  // context-selection-agent subflow" (src/app/api/context-resolve,
  // /context-finalize). A subflow's inputs arrive on the parent's DataFlowEdges,
  // never in an A2A start message, so its top-level Flow is not a
  // start-conversation surface. It is not in the set a fresh instance installs.
  "@cinatra-ai/context-selection-agent": Object.freeze([
    "parentPackageName",
    "parentRunId",
    "slotId",
  ]),
});

/** True when `title` is a recorded exemption for `packageName`. */
export function isExemptFromUnsatisfiableInputCheck(packageName, title) {
  const entry = OAS_RUNTIME_014_EXEMPTIONS[packageName];
  return Array.isArray(entry) && entry.includes(title);
}
