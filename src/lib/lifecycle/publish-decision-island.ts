import "server-only";

// ---------------------------------------------------------------------------
// THE PUBLISH-DECISION ISLAND LOADER (cinatra#4150 W4 C1b).
//
// The publish card's `artifacts` row draws the artifact revisions a publishing
// stop surfaced (a WordPress or Drupal page's proposed revision) through the SAME
// review-target island a review gate uses, so the person deciding sees "published
// vs proposed" through the one ladder, with no second renderer. A review gate's
// island draws a set the gate pinned; a publish decision has no gate, and its
// targets were surfaced by the pack. So this loader is the authorization a gate
// would otherwise have supplied, and it runs in this order, every refusal the
// one `refused` answer the island draws as its one empty document:
//
//   1. THE ROW (`readPublishDecisionIslandSubject`): the reader may read the run
//      (the card's own access door), the named decision is the run's NEWEST and
//      still a card, the template declares an artifacts row over the named input
//      on the decision's own node, and the decision's FROZEN value for it is a
//      valid target list. The targets are never a caller's.
//   2. THE READER'S ORGANIZATION is the run's.
//   3. EVERY TARGET BELONGS TO THE RUN: its revision row exists in the run's
//      organization, for that artifact, and was created by THIS run
//      (`representation.created_by_run_id`, an append-only table). One target
//      the run did not make refuses the whole set, as a gate's substitution
//      check does: a pack cannot put another run's, or another organization's,
//      work on a card.
//   4. THE ONE CORE prepares the proven set: run access again with the same
//      organization check the gate binder applies, the proven set as the pinned
//      set (nothing can be substituted), the reader's own `object.read` on each
//      artifact (a target this reader may not read draws the never-blank floor
//      for that target alone), the renderer from the artifact's type.
//
// Any port that throws is a refusal. The island stays display-only: the card's
// Publish and Do not publish are drawn outside the frame.
// ---------------------------------------------------------------------------

import {
  readPublishDecisionIslandSubject,
  readRevisionsMadeByRun,
  type PublishDecisionIslandSubject,
} from "@cinatra-ai/agents/publish-decision-island-subject";

import {
  bindReviewRunGatePorts,
  streamReviewTargets,
  type ReviewActorContext,
} from "@/app/artifacts/[id]/review-gate-ports";
import { beginArtifactReviewTargets } from "@/app/artifacts/[id]/review-target-prepare";
import type { ReviewSurfaceRoads } from "@/app/artifacts/[id]/review-surface-roads";
import type { BeginReviewResult } from "@/lib/artifacts/artifact-review-preparation";
import type { ArtifactReviewTarget } from "@/lib/artifacts/artifact-review-target";
import type { ReviewTargetStream } from "@/lib/artifacts/review-surface-model";
import { buildActorContextFromPrimitive } from "@/lib/authz/build-actor-context";
import { publishDecisionIslandSubjectKey } from "@/lib/lifecycle/lifecycle-card-ref";

/** What the island draws for one artifacts row: the proven targets, streaming, or nothing at all. */
export type PublishDecisionIslandSurface =
  | { kind: "ready"; decided: boolean; targets: ReviewTargetStream[] }
  | { kind: "refused" };

const REFUSED: PublishDecisionIslandSurface = Object.freeze({ kind: "refused" });

export type PublishDecisionIslandArgs = {
  runId: string;
  decisionId: string;
  input: string;
  actorCtx: ReviewActorContext;
  roads?: ReviewSurfaceRoads | null;
};

/** The loader's seams, injected so every rung is testable without a database. */
export type PublishDecisionIslandPorts = {
  readSubject(input: {
    runId: string;
    decisionId: string;
    input: string;
    who: { actor: ReviewActorContext["actor"]; roleHints?: ReviewActorContext["roleHints"] };
  }): Promise<PublishDecisionIslandSubject | null>;
  /** True only when EVERY target's revision was created by this run, in this organization, for that artifact. */
  revisionsMadeByRun(input: { orgId: string; runId: string; targets: readonly ArtifactReviewTarget[] }): Promise<boolean>;
  begin(input: {
    runId: string;
    subjectKey: string;
    targets: ArtifactReviewTarget[];
    actorCtx: ReviewActorContext;
    roads: ReviewSurfaceRoads | null;
  }): Promise<BeginReviewResult>;
  stream(input: {
    orgId: string;
    started: Extract<BeginReviewResult, { ok: true }>["targets"];
    roads: ReviewSurfaceRoads | null;
  }): ReviewTargetStream[];
};

/** The island's surface for one artifacts row, through the given ports. */
export async function loadPublishDecisionIslandSurfaceWith(
  args: PublishDecisionIslandArgs,
  ports: PublishDecisionIslandPorts,
): Promise<PublishDecisionIslandSurface> {
  const roads = args.roads ?? null;
  try {
    // 1. The row, through the card's own access door.
    const subject = await ports.readSubject({
      runId: args.runId,
      decisionId: args.decisionId,
      input: args.input,
      who: { actor: args.actorCtx.actor, roleHints: args.actorCtx.roleHints },
    });
    if (!subject || subject.runId !== args.runId || subject.targets.length === 0) return REFUSED;
    // 2. The reader's organization is the run's.
    if (subject.orgId !== args.actorCtx.orgId) return REFUSED;
    // 3. Every target was made by this run, in this organization.
    if ((await ports.revisionsMadeByRun({ orgId: subject.orgId, runId: subject.runId, targets: subject.targets })) !== true) {
      return REFUSED;
    }
    // 4. The one core, over exactly the proven set.
    const begun = await ports.begin({
      runId: subject.runId,
      subjectKey: publishDecisionIslandSubjectKey({ decisionId: args.decisionId, input: args.input }),
      targets: subject.targets,
      actorCtx: args.actorCtx,
      roads,
    });
    if (!begun.ok) return REFUSED;
    return {
      kind: "ready",
      decided: subject.decided,
      targets: ports.stream({ orgId: subject.orgId, started: begun.targets, roads }),
    };
  } catch {
    return REFUSED;
  }
}

/** The bound ports: the real subject read, the real revision read, the one core and the review surface's streaming. */
export const PUBLISH_DECISION_ISLAND_PORTS: PublishDecisionIslandPorts = {
  readSubject: (input) => readPublishDecisionIslandSubject(input),
  revisionsMadeByRun: (input) => readRevisionsMadeByRun(input),
  begin: ({ runId, subjectKey, targets, actorCtx, roads }) =>
    beginArtifactReviewTargets({
      input: { runId, reviewTaskId: subjectKey, targets },
      orgId: actorCtx.orgId,
      actor: buildActorContextFromPrimitive(actorCtx.actor, actorCtx.orgId, actorCtx.roleHints),
      runGatePorts: {
        // The gate binder's own run check: read access, and the run's organization is the reader's.
        verifyRunAccess: bindReviewRunGatePorts(actorCtx).verifyRunAccess,
        // The proven set IS the pinned set: every target the core is handed was proven above.
        readGatePinnedTargets: () => ({ status: "pending", targets }),
      },
      byteMinter: roads?.byteMinter,
      buildContent: roads?.buildContent,
      dataRoad: roads?.dataRoad,
      dashboardLiveAddress: roads?.dashboardLiveAddress,
      // The decision is the card's, not this frame's: no display offers the live navigation.
      reading: "pending",
    }),
  // An ordinary pairing: a publish target's pinned pictures are read by the target itself (published vs proposed).
  stream: ({ orgId, started, roads }) =>
    streamReviewTargets(orgId, started, () => Promise.resolve({ kind: "ordinary" as const }), roads),
};

/** The island's surface for one artifacts row of a publish card. */
export function loadPublishDecisionIslandSurface(
  args: PublishDecisionIslandArgs,
): Promise<PublishDecisionIslandSurface> {
  return loadPublishDecisionIslandSurfaceWith(args, PUBLISH_DECISION_ISLAND_PORTS);
}
