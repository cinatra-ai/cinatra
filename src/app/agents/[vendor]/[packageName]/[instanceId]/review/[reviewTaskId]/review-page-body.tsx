/**
 * THE SCOPE HALF OF THE REVIEW PAGE'S BODY (cinatra#3693).
 *
 * The review is a sub-route of its run, and cinatra#2809 gives a run ONE
 * canonical home: "the bare route redirects anchored non-personal instances
 * after authorization; after authorization, a wrong scoped instance path
 * redirects to the canonical home and renders no instance content before the
 * redirect". The run page has done that since #2809; this is the same answer
 * for the review, which the scoped shell now mounts under every scope base.
 *
 * WHY A SIBLING AND NOT THE PAGE. `page.tsx` is a route file, and the scoped
 * shell calls its default export with the scope it resolved. The page's own
 * composition stays where the review's source-reading checks pin it; what the
 * scope ADDS to that body — the home check and the scope's crumbs — lives here.
 *
 * THE SAME-ROUTE LOOP. Both sides of the comparison are built from the SAME raw
 * instance id and task id, and the current side carries the base the page was
 * mounted under, so the home address compares equal to itself and renders.
 *
 * A PENDING REVIEW LANDS ON THE RUN PAGE (cinatra#3693). The owner retired the
 * standalone review page: "a pending review still opens in place on the run
 * page, as the run-page drawing says." So the review address of a PENDING gate
 * is the run's own address — its canonical home, with no sub-path — wherever it
 * was read, the home included, and the run page opens on the gate it is parked
 * at. A settled gate and its audit reading keep the review sub-path for now:
 * the run detail does not yet draw a chosen settled gate of its own.
 */
import "server-only";
import type React from "react";

import { readAgentRunById } from "@cinatra-ai/agents/store";

import { CrumbContributions } from "@/components/crumb-contributions";
import { buildAgentInstancePath } from "@/lib/agent-url";
import {
  canonicalRunPath,
  homeRedirectFor,
  parseLaunchScopeAnchor,
} from "@/lib/launch-scope-anchor";
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
 * The address the reader is owed, or `null` when the page is already at the
 * run's home. Called only AFTER the page's access door has cleared. A run the
 * store cannot read is left where it is: the page's own door already answered
 * for it.
 */
export async function reviewPageHomeRedirect(input: {
  agentId: string;
  rawInstanceId: string;
  rawTaskId: string;
  runId: string;
  scopeBase?: string | null;
  verificationView: boolean;
  /** The gate is PENDING (cinatra#3693): its reader belongs on the run page. */
  pendingGate?: boolean;
}): Promise<string | null> {
  const run = await readAgentRunById(input.runId).catch(() => null);
  if (!run) return null;
  const runHome = canonicalRunPath({
    agentPackageName: input.agentId,
    instanceId: input.rawInstanceId,
    anchor: parseLaunchScopeAnchor(run.launchScopeAnchor),
  });
  // Never the verification reading: that is an audit view of a decided gate.
  if (input.pendingGate && !input.verificationView) return runHome;
  const subPath = `/review/${input.rawTaskId}`;
  const home = homeRedirectFor(
    `${buildAgentInstancePath(input.agentId, input.rawInstanceId, {
      scopeBase: input.scopeBase ?? null,
    })}${subPath}`,
    `${runHome}${subPath}`,
  );
  // The audit reading is a view of this same route, so it goes home with it.
  return home && input.verificationView ? `${home}?view=verification` : home;
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
