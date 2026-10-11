"use server";
/**
 * Server actions for the WORKSPACE Dashboards tab (cinatra#2811, per-scope
 * surfaces S5; the amended drawing §IX.1 to §IX.4). None takes a scope: the
 * workspace is one scope, and the viewer is re-resolved from the LIVE session
 * on every call, so a client can neither forge a viewer nor carry a stale one
 * across an organization switch. Every mutation re-authorizes in the service;
 * a missing session is a denial, never a widen.
 */
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import {
  addWorkspaceReference,
  buildWorkspaceViewer,
  listWorkspaceReferenceCandidates,
  removeWorkspaceReference,
  setWorkspaceEveryoneGrant,
  viewerCuratesAnyReference,
  type WorkspaceViewer,
} from "@/lib/dashboards/workspace-dashboards.server";
import type {
  AddPickerCandidateView,
  ScopeListingMutation,
} from "@/components/dashboards/scope-dashboards-contract";

/** The live viewer, or null without a session (fail-closed). */
async function liveViewer(): Promise<WorkspaceViewer | null> {
  const session = await getAuthSession();
  const userId = session?.user?.id;
  if (!session || !userId) return null;
  return buildWorkspaceViewer({
    userId,
    platformAdmin: isPlatformAdmin(session),
    activeOrganizationId:
      (session.session as { activeOrganizationId?: string | null } | undefined)
        ?.activeOrganizationId ?? null,
  });
}

/** The reference picker's pool, or null for a viewer who curates nothing. */
export async function workspaceListReferenceCandidatesAction(): Promise<
  AddPickerCandidateView[] | null
> {
  const viewer = await liveViewer();
  if (!viewer || !viewerCuratesAnyReference(viewer)) return null;
  return listWorkspaceReferenceCandidates(viewer);
}

export async function workspaceAddReferenceAction(
  dashboardId: string,
): Promise<ScopeListingMutation> {
  const viewer = await liveViewer();
  if (!viewer) return { ok: false, reason: "denied" };
  return addWorkspaceReference(viewer, dashboardId);
}

/** The workspace has no promotion recourse (§IX.1): nothing is widened to make
 *  a reference addable, so this answer is always a plain refusal. */
export async function workspaceRequestPromotionAction(
  dashboardId: string,
): Promise<ScopeListingMutation> {
  void dashboardId;
  return { ok: false, reason: "invalid" };
}

export async function workspaceRemoveReferenceAction(
  dashboardId: string,
): Promise<ScopeListingMutation> {
  const viewer = await liveViewer();
  if (!viewer) return { ok: false, reason: "denied" };
  return removeWorkspaceReference(viewer, dashboardId);
}

export async function workspaceSetEveryoneGrantAction(
  dashboardId: string,
  granted: boolean,
): Promise<ScopeListingMutation> {
  const viewer = await liveViewer();
  if (!viewer) return { ok: false, reason: "denied" };
  return setWorkspaceEveryoneGrant(viewer, dashboardId, granted === true);
}
