// THE LIST MODE of the deterministic `artifact_materialize` passthrough tool
// (cinatra#3089). Pure module (zero project deps), same posture as
// ./artifact-materialize-shaper. The members are filed as ONE UNIT by the
// materializer (`materializeToolArtifactSet`): every member is checked, then all
// are written in one transaction with the ledger finalized for all, so there is
// no partial state to review, reuse or repair. This module holds what the route
// needs around that: the answer, the size rule and the Regenerate rule.

export type MaterializeListFiled = { artifactId: string; representationRevisionId: string };

/** The answer of a list call: one entry per member in member order, and the same pairs as JSON text for a
 *  marked gate's `targetsInput`. */
export function materializeListAnswer(artifacts: readonly MaterializeListFiled[]): {
  artifacts: MaterializeListFiled[];
  reviewTargets: string;
} {
  const list = artifacts.map((a) => ({ artifactId: a.artifactId, representationRevisionId: a.representationRevisionId }));
  return { artifacts: list, reviewTargets: JSON.stringify(list) };
}

// THE RAW SIZE OF A LIST CALL (cinatra#3089). The shaper parses the whole list
// and keeps only each member's title and content, and the argument check of the
// host's preparation then measures that reduced call. A list with small filed
// fields and large unused ones would pass that check, be parsed whole and, when
// the call asks for its inputs back, be echoed whole. So the route measures the
// call AS RECEIVED, before the shaper parses anything: its `content` text and
// its whole input as JSON text, each against the limit the argument check uses
// (the route passes it in; this module keeps no project imports). With the raw
// input bounded, the echo of it is bounded too.

export const MATERIALIZE_LIST_INPUT_TOO_LARGE = "materialize_list_input_too_large";

export function materializeListInputTooLargeError(maxBytes: number): string {
  return (
    `artifact_materialize: a list call's input is larger than ${maxBytes} bytes as JSON text ` +
    "(the limit of a run tool call's arguments); nothing was filed"
  );
}

/** Whether a list call's input, as received, is larger than `maxBytes`: its
 *  `content` text in UTF-8, or the whole input as JSON text. An input that
 *  cannot be written as JSON text (nested too deep for the serializer, or a
 *  value JSON does not hold) cannot be measured, so it counts as too large. */
export function isMaterializeListInputTooLarge(rawInput: Record<string, unknown>, maxBytes: number): boolean {
  const content = rawInput.content;
  if (typeof content === "string" && Buffer.byteLength(content, "utf8") > maxBytes) return true;
  let text: string | undefined;
  try {
    text = JSON.stringify(rawInput);
  } catch {
    return true;
  }
  return typeof text !== "string" || Buffer.byteLength(text, "utf8") > maxBytes;
}

// THE REGENERATE RUN (cinatra#3089). A Regenerate re-runs one filing node and
// takes exactly one production (`claimSegmentProduction` in
// packages/agents/src/regenerate-segment.ts). A list call in such a run would
// file every member again, the repair would not be applied, and the filed
// artifacts would stay. The compile refuses a `regenerate` entry that names a
// list filing; this refuses the call too (an older compiled template, a
// hand-made flow), before anything is filed.
//
// Whether a run is a Regenerate run is read by the route from the DURABLE repair row, by the classifier the
// run executor uses (`isRegenerateSegmentRun` in packages/agents/src/regenerate-segment.ts): a repair run whose
// row names an intent, whose row is missing or whose row cannot be read counts as one (it fails closed). The
// run's own request payload is no authority.

export const MATERIALIZE_LIST_IN_REGENERATE_RUN = "materialize_list_in_regenerate_run";

export const MATERIALIZE_LIST_IN_REGENERATE_RUN_ERROR =
  "artifact_materialize: a list call files one artifact per member, and a Regenerate run files exactly one " +
  "artifact; nothing was filed. Regenerating one member needs its own regenerate entry";
