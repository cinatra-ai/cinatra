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
