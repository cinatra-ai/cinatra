import "server-only";

// ---------------------------------------------------------------------------
// THE PUBLISH ROW'S PINNED SET, FOR THE SEALED SERVING PATHS (cinatra#4738 round 2).
//
// A widget reader's publish-decision island gets the same sealed byte and capture roads a review gate's island gets,
// so its media and capture pairs load inside a third-party site. Those capabilities are sealed to the run and to the
// row's SUBJECT KEY (the slot a gate capability holds its review task id in), and they seal that they are a publish
// row's. Their serving paths re-prove, before a byte is read, that the sealed target is in the set this row shows:
//
//   1. the reader may read the run, and the run's NEWEST decision is still a card (`readPublishDecisionIslandRows`);
//   2. exactly one artifacts row of that decision has this subject key, so a key minted for an older decision, or for
//      another row, names nothing;
//   3. that row is proven by the island loader's own subject read, in the reader's organization, and every target was
//      made by this run (`readRevisionsMadeByRun`);
//   4. the reader may still read each target as an artifact (`object.read`, as the sealed user). Run access does not
//      carry that read: a target the panel floors as `read-denied` is not in the answer, so neither its bytes nor its
//      capture pictures serve.
//
// The answer is that row's frozen targets this reader may read, and nothing else. Every refusal, and every read that throws, is `null`.
// ---------------------------------------------------------------------------

import {
  readPublishDecisionIslandRows,
  readPublishDecisionIslandSubject,
  readRevisionsMadeByRun,
} from "@cinatra-ai/agents/publish-decision-island-subject";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

import type { ArtifactReviewTarget } from "@/lib/artifacts/artifact-review-target";
import { readIslandTargetsReadableBy } from "@/lib/lifecycle/island-target-read-access";
import { publishDecisionIslandSubjectKey } from "@/lib/lifecycle/lifecycle-card-ref";

/** The frozen targets of the publish row this subject key names that this reader may read, or `null`. */
export async function readPublishDecisionIslandPinnedTargets(input: {
  runId: string;
  subjectKey: string;
  userId: string;
  orgId: string;
}): Promise<readonly ArtifactReviewTarget[] | null> {
  try {
    // The narrowest reading of the sealed principal, the one the serving paths' run check uses: no role hints.
    const actor: PrimitiveActorContext = {
      actorType: "human",
      source: "route",
      userId: input.userId,
      orgId: input.orgId,
    };
    const rows = await readPublishDecisionIslandRows({ runId: input.runId, who: { actor } });
    if (!rows) return null;
    const named = rows.inputs.filter(
      (row) => publishDecisionIslandSubjectKey({ decisionId: rows.decisionId, input: row }) === input.subjectKey,
    );
    if (named.length !== 1) return null;
    const subject = await readPublishDecisionIslandSubject({
      runId: input.runId,
      decisionId: rows.decisionId,
      input: named[0],
      who: { actor },
    });
    if (!subject || subject.runId !== input.runId || subject.orgId !== input.orgId) return null;
    if (subject.targets.length === 0) return null;
    const made = await readRevisionsMadeByRun({ orgId: subject.orgId, runId: subject.runId, targets: subject.targets });
    if (made !== true) return null;
    const readable = await readIslandTargetsReadableBy({
      targets: subject.targets,
      userId: input.userId,
      orgId: input.orgId,
    });
    return readable && readable.length > 0 ? readable : null;
  } catch {
    return null;
  }
}
