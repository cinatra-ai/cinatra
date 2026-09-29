/**
 * THE REVIEW ADDRESS IS THE RUN'S ADDRESS (cinatra#3693).
 *
 * The owner retired the standalone review page: "a pending review still opens in
 * place on the run page, as the run-page drawing says." The drawings say it of
 * every reading, not only the pending one: "a pending review renders the review
 * gate in the run detail, under the same rail, never as a standalone document",
 * and "there is no review page view outside the run's route".
 *
 * So this module is the review route's one answer: whatever reading was asked
 * for, the reader is sent to the RUN, at the run's own canonical home, with the
 * gate's rail selection named on the address — the ONE address form for "this
 * run, this step selected" (`src/lib/agent-url.ts`, `buildRunStepPath`). The run
 * detail opens on that step at first render, so nothing about the reading is
 * lost by the move.
 *
 * WHY THE ROUTE STILL ANSWERS AT ALL. Notifications already sent, and bookmarks
 * already taken, carry the old `/review/<taskId>` address. They keep working
 * because this route redirects them, and they land where the reading now lives.
 *
 * AFTER THE ACCESS DOOR, NEVER BEFORE IT. The redirect names the run's home
 * scope, which is something about the run; a reader the page refuses learns
 * nothing, so `page.tsx` calls this only once its own door has cleared.
 *
 * WHY A SIBLING AND NOT THE PAGE. `page.tsx` is a route file, and the scoped
 * shell calls its default export with the scope it resolved. The page's own
 * composition stays where the review's source-reading checks pin it; the
 * redirect and the scope's crumbs live here.
 */
import "server-only";
import type React from "react";

import { readAgentRunById } from "@cinatra-ai/agents/store";

import {
  runReviewAuditStepKey,
  runReviewGateStepKey,
} from "@cinatra-ai/agents/run-surface-rail-step";

import { CrumbContributions } from "@/components/crumb-contributions";
import { buildRunStepPath } from "@/lib/agent-url";
import { canonicalRunPath, parseLaunchScopeAnchor } from "@/lib/launch-scope-anchor";
import { scopeSurfaceCrumbEntries, type ScopeSurfaceRef } from "@/lib/scope-surfaces";

/** What the scoped shell hands the review page; absent on the bare route. */
export type ReviewPageScopeProps = {
  /** The scope base the page is mounted under, e.g. `/teams/<id>`. */
  scopeBase?: string | null;
  /** The scope itself, for the trail's head. */
  launchScope?: ScopeSurfaceRef | null;
  /** The scope's resolved name, read behind the scope's own gate. */
  scopeTitle?: string | null;
};

/**
 * The run address this review reading belongs at, or `null` for a run the store
 * cannot read. Called only AFTER the page's access door has cleared.
 *
 * TWO READINGS, TWO STEPS. The gate itself is the run detail's `review:<task>`
 * step; the `?view=verification` audit is its `audit:<task>` step. Both are rail
 * selections the run page already draws, so the address names the step and the
 * run page does the rest.
 *
 * THE RUN'S CANONICAL HOME IS THE BASE, whatever base the review was read under.
 * A run has one home (cinatra#2809), and an anchored run read at the bare address
 * or under another scope belongs at that home — which is what the run page's own
 * check has always answered, and what this redirect gives the review's readers
 * in one hop instead of two.
 */
export async function reviewAddressRedirect(input: {
  agentId: string;
  rawInstanceId: string;
  rawTaskId: string;
  runId: string;
  verificationView: boolean;
}): Promise<string | null> {
  const run = await readAgentRunById(input.runId).catch(() => null);
  if (!run) return null;
  const runHome = canonicalRunPath({
    agentPackageName: input.agentId,
    instanceId: input.rawInstanceId,
    anchor: parseLaunchScopeAnchor(run.launchScopeAnchor),
  });
  const taskId = decodeURIComponent(input.rawTaskId);
  return buildRunStepPath(
    runHome,
    input.verificationView ? runReviewAuditStepKey(taskId) : runReviewGateStepKey(taskId),
  );
}

/** The scope's own crumbs — its name, then Agents — on a scoped review. */
export function reviewPageScopeCrumbs({
  launchScope,
  scopeTitle,
}: Pick<ReviewPageScopeProps, "launchScope" | "scopeTitle">): React.ReactNode {
  if (!launchScope) return null;
  return (
    <CrumbContributions
      entries={scopeSurfaceCrumbEntries(launchScope, "agents", scopeTitle ?? undefined)}
    />
  );
}
