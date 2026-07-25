import "server-only";

import {
  listOrgDashboardRows,
  excludeProjectTemplates,
  filterRenderableDashboards,
} from "@cinatra-ai/dashboards/extension-dashboard-reads";
import type { ActorContext } from "@/lib/authz/actor-context";
import { resolveExtensionRole } from "@/lib/extension-roles";
import { resolveLiveExtensionPredicate } from "@/lib/dashboards/live-extension-oracle";

// The workspace-wide `/dashboards` directory page was retired with no redirect
// (cinatra#2058), so a would-be index link must NOT be minted. When the specific
// operator-dashboard detail row cannot be resolved, degrade to `/artifacts`,
// where dashboards are now discoverable.
const DASHBOARDS_FALLBACK_URL = "/artifacts";

// Resolves the materialized blog operator dashboard row URL for the caller.
// The dashboard-owning extension resolves from the manifest-declared
// "blog-operator-dashboard" extension role (cinatra#151 Stage 6) — when no
// present extension claims it (reduced universes), the resolver degrades to
// the artifacts surface, exactly like the no-matching-row case. Returns
// `/dashboards/{rowId}` (the preserved per-dashboard detail route) when a row
// exists matching the caller's org + (when provided) project; otherwise returns
// the `/artifacts` fallback. Caller is responsible for projecting its own actor
// (request path: `getActorContext()` from `@/lib/auth-session`; worker path: the
// ALS actor from `@cinatra-ai/llm/actor-context`, or the actor it was enqueued
// with).
export async function resolveBlogDashboardUrl(
  actor: ActorContext,
  projectId?: string,
): Promise<string> {
  const organizationId = actor.organizationId;
  if (!organizationId) return DASHBOARDS_FALLBACK_URL;

  const blogDashboardOwner = resolveExtensionRole("blog-operator-dashboard");
  if (!blogDashboardOwner) return DASHBOARDS_FALLBACK_URL;

  const rows = await listOrgDashboardRows(organizationId);
  // Exclude project-scope TEMPLATE rows — those never render directly (the
  // dashboard detail page 404s them); only their per-project instances are
  // operational. Then apply the ALL-READER liveness/status gate (cinatra#1628):
  // never resolve a deep-link to an orphaned/archived extension dashboard whose
  // detail route would 404 anyway — degrade to the artifacts surface instead.
  const isPackageLive = await resolveLiveExtensionPredicate(organizationId);
  const blogRows = filterRenderableDashboards(excludeProjectTemplates(rows), isPackageLive).filter(
    (r) => r.extensionId === blogDashboardOwner,
  );

  // Project-scoped instance first.
  if (projectId) {
    const match = blogRows.find((r) => r.projectId === projectId);
    if (match) return `/dashboards/${match.id}`;
  }

  // Org-level fallback — the org-scope dashboard if any.
  const orgMatch = blogRows.find((r) => r.projectId === null);
  if (orgMatch) return `/dashboards/${orgMatch.id}`;

  return DASHBOARDS_FALLBACK_URL;
}
