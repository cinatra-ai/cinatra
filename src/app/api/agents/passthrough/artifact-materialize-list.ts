// THE LIST MODE of the deterministic `artifact_materialize` passthrough tool
// (cinatra#3089). Pure module (zero project deps), same posture as
// ./artifact-materialize-shaper: the route hands it the shaped members and the
// one-artifact filing call it already makes, and it files the members in order.
//
// THE PARTIAL-FAILURE RULE. The members are filed one after the other, each
// through the single call and its idempotency ledger (run, node, extension,
// content hash). When member k fails, the members before it are already filed
// and stay filed, and the answer is a typed refusal that carries no artifacts
// and no review targets — so no gate downstream can receive a partial set, and
// the calling node fails. A retry of the same call is safe: each member filed
// before hits its finalized ledger row and comes back with the same ids
// (nothing is filed twice), and the filing resumes at member k.

import type { ShapedArtifactMaterializeMember } from "./artifact-materialize-shaper";

export type MaterializeListFiled = { artifactId: string; representationRevisionId: string };

/** What the single filing call answers (the materializer's own outcome shape). */
export type MaterializeListMemberOutcome =
  | ({ ok: true; deduped?: boolean } & MaterializeListFiled)
  | { ok: false; error: string };

export const MATERIALIZE_LIST_PARTIAL = "materialize_list_partial";

export type MaterializeListResult =
  | {
      ok: true;
      /** One entry per member, in member order. */
      artifacts: MaterializeListFiled[];
      /** The same pairs as JSON text, for a marked gate's `targetsInput`. */
      reviewTargets: string;
    }
  | {
      ok: false;
      code: typeof MATERIALIZE_LIST_PARTIAL;
      error: string;
      /** The 1-based member that failed. */
      failedMember: number;
      /** How many members before it are filed (and reused by a retry). */
      filedCount: number;
    };

export async function materializeArtifactList(
  members: readonly ShapedArtifactMaterializeMember[],
  fileOne: (member: ShapedArtifactMaterializeMember) => Promise<MaterializeListMemberOutcome>,
): Promise<MaterializeListResult> {
  const artifacts: MaterializeListFiled[] = [];
  for (const [index, member] of members.entries()) {
    const outcome = await fileOne(member);
    if (!outcome.ok) {
      return {
        ok: false,
        code: MATERIALIZE_LIST_PARTIAL,
        failedMember: index + 1,
        filedCount: artifacts.length,
        error:
          `artifact_materialize list member ${index + 1} of ${members.length} was not filed: ${outcome.error} — ` +
          `${artifacts.length} member(s) before it are filed; a retry of the same call files nothing twice`,
      };
    }
    artifacts.push({
      artifactId: outcome.artifactId,
      representationRevisionId: outcome.representationRevisionId,
    });
  }
  return { ok: true, artifacts, reviewTargets: JSON.stringify(artifacts) };
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
 *  `content` text in UTF-8, or the whole input as JSON text. */
export function isMaterializeListInputTooLarge(rawInput: Record<string, unknown>, maxBytes: number): boolean {
  const content = rawInput.content;
  if (typeof content === "string" && Buffer.byteLength(content, "utf8") > maxBytes) return true;
  return Buffer.byteLength(JSON.stringify(rawInput), "utf8") > maxBytes;
}

// THE REGENERATE RUN (cinatra#3089). A Regenerate re-runs one filing node and
// takes exactly one production (`claimSegmentProduction` in
// packages/agents/src/regenerate-segment.ts). A list call in such a run would
// file every member again, the repair would not be applied, and the filed
// artifacts would stay. The compile refuses a `regenerate` entry that names a
// list filing; this refuses the call too (an older compiled template, a
// hand-made flow), before anything is filed.
//
// A Regenerate run is a lifecycle repair run whose typed request carries the
// record its dispatch writes (`regenerateInput`); the run start refuses a
// Regenerate run without it. The names are those of regenerate-segment.ts
// (pinned by the route test); they are kept here so that this module stays
// free of project imports.

export const MATERIALIZE_LIST_IN_REGENERATE_RUN = "materialize_list_in_regenerate_run";

export const MATERIALIZE_LIST_IN_REGENERATE_RUN_ERROR =
  "artifact_materialize: a list call files one artifact per member, and a Regenerate run files exactly one " +
  "artifact; nothing was filed. Regenerating one member needs its own regenerate entry";

const REPAIR_RUN_SOURCE_TYPE = "lifecycle_repair";
const REPAIR_RUN_ID_PREFIX = "lifecycle-repair-run:";
const REPAIR_REQUEST_INPUT = "lifecycleRepairRequest";
const REGENERATE_RECORD_KEY = "regenerateInput";

/** Whether `run` is a Regenerate run (or a repair run whose inputs cannot be
 *  read, which counts as one: fail closed). */
export function isRegenerateRepairRun(run: {
  id: string;
  sourceType?: string | null;
  inputParams?: unknown;
}): boolean {
  if (run.sourceType !== REPAIR_RUN_SOURCE_TYPE && !run.id.startsWith(REPAIR_RUN_ID_PREFIX)) return false;
  let params: unknown = run.inputParams;
  if (typeof params === "string") {
    try {
      params = JSON.parse(params);
    } catch {
      return true;
    }
  }
  if (params === null || typeof params !== "object" || Array.isArray(params)) return true;
  const request = (params as Record<string, unknown>)[REPAIR_REQUEST_INPUT];
  if (request === null || typeof request !== "object" || Array.isArray(request)) return false;
  return Object.prototype.hasOwnProperty.call(request, REGENERATE_RECORD_KEY);
}
