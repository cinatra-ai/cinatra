import "server-only";
/**
 * The WORKSPACE Dashboards tab body (cinatra#2811, per-scope surfaces S5; the
 * amended drawing §IX, §IX.1, §IX.3, §IX.4).
 *
 * "Its Dashboards tab behaves exactly like the other scopes' Dashboards tab
 * (§IX.3): the same per-user dashboard shell with its non-removable Overview
 * default, and the same single Add dashboard popup, whose Reference a
 * dashboard from the scopes below section is how a lower-scope dashboard is
 * brought up to the workspace."
 *
 * A builder FUNCTION rather than an async component: the workspace page awaits
 * it and hands the finished element to the shared shell, so the shell stays a
 * plain tree. It reuses the scope tab's own components (the row list, the Add
 * popup, the reference section) and adds only the workspace's own facts: the
 * viewer's workspace rows (the Overview is ensured first), the viewer-filtered
 * references, the curation authority and the everyone-grant.
 *
 * The viewer is built from the viewer's own memberships (the workspace
 * vantage), so the body reads the same under every active organization. The
 * installed-catalog section is federated over those same memberships.
 * Handles to the curation actions are handed down only where they apply
 * (capability minimization); every action re-authorizes server-side anyway.
 */
import type { ReactElement } from "react";

import {
  createEntityDashboardAction,
  ensureEntityOverviewAction,
} from "@cinatra-ai/dashboards/entity-dashboard-actions";
import { workspaceDashboardRef } from "@cinatra-ai/dashboards/entity-identity";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import {
  buildWorkspaceViewer,
  getWorkspaceDashboardsRows,
  viewerCuratesAnyReference,
  workspaceCatalogMemberships,
} from "@/lib/dashboards/workspace-dashboards.server";
import { buildWorkspaceCatalogNode } from "./scope-catalog-node";
import { ScopeDashboardsTab, ScopeDashboardsTabError } from "./scope-dashboards-tab";
import { WorkspaceAddDashboardButton } from "./workspace-add-dashboard-button";
import {
  workspaceAddReferenceAction,
  workspaceListReferenceCandidatesAction,
  workspaceRemoveReferenceAction,
  workspaceRequestPromotionAction,
  workspaceSetEveryoneGrantAction,
} from "./workspace-dashboards-actions";
import type { ScopeReferenceSource } from "./scope-dashboards-contract";

/** The entity the drawn caption names (the shell's own fallback noun). */
const WORKSPACE_CAPTION_ENTITY = "Workspace";

export async function buildWorkspaceDashboardsTabBody(): Promise<ReactElement> {
  try {
    const session = await getAuthSession();
    const userId = session?.user?.id;
    if (!session || !userId) return <ScopeDashboardsTabError />;
    const platformAdmin = isPlatformAdmin(session);
    const ref = workspaceDashboardRef(userId);
    // The non-removable Overview default: ensured before the list is read, so
    // the shell always carries it (an idempotent find-or-create).
    await ensureEntityOverviewAction(ref);
    const viewer = await buildWorkspaceViewer({
      userId,
      platformAdmin,
      activeOrganizationId:
        (session.session as { activeOrganizationId?: string | null } | undefined)
          ?.activeOrganizationId ?? null,
    });
    const rows = await getWorkspaceDashboardsRows(viewer);
    const curates = viewerCuratesAnyReference(viewer);
    // The installed catalog, federated over the viewer's member organizations
    // (cinatra#2811, item 4). It is NOT gated on curation: the catalog copy is
    // the viewer's own dashboard in their own collection, so a plain member is
    // offered it exactly as they are offered Create new. An empty or failed
    // read is `null`, and the popup then shows no catalog section at all.
    const catalog = await buildWorkspaceCatalogNode({
      userId,
      memberships: workspaceCatalogMemberships(viewer),
    });
    const reference: ScopeReferenceSource | null = curates
      ? {
          listCandidates: workspaceListReferenceCandidatesAction,
          addListing: workspaceAddReferenceAction,
          requestPromotion: workspaceRequestPromotionAction,
        }
      : null;
    return (
      <ScopeDashboardsTab
        data={{ scopeKind: "workspace", rows, canManage: curates }}
        removal={curates ? { removeListing: workspaceRemoveReferenceAction } : undefined}
        everyoneGrant={platformAdmin ? { setGrant: workspaceSetEveryoneGrantAction } : undefined}
        caption={{ kind: "entity", entityLabel: WORKSPACE_CAPTION_ENTITY }}
        add={
          <WorkspaceAddDashboardButton
            createDashboard={createEntityDashboardAction.bind(null, ref)}
            reference={reference}
            catalog={catalog}
          />
        }
      />
    );
  } catch (err) {
    // Contain a store failure in the DESIGNED error frame (§IX / §X), exactly as
    // the other scopes' sections do, instead of a blank 500.
    console.error("[scope-dashboards] failed to load the workspace scope:", err);
    return <ScopeDashboardsTabError />;
  }
}
