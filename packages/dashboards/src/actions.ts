"use server";
/**
 * Server Actions for the dashboards package.
 *
 * `saveAgentsDashboardAction` is invoked from the /agents screen via the
 * `AnalyticsPortletView` `onSave` prop (cinatra#328). It funnels every
 * save through the mutation service's `upsertDashboardConfig`, which
 * is the single writer (audit-event row written inside the
 * same TX; advisory-lock serializes concurrent writers).
 *
 * Invariants:
 *   - Dashboard id is per-org-per-user (cross-org isolation; users in
 *     different orgs see different rows).
 *   - ownerLevel "user" + ownerId=userId + visibility "private" means
 *     `canWrite` is satisfied by `row.ownerId === actor.userId` —
 *     no org role required. Every user can edit + save THEIR /agents
 *     layout, regardless of their Better Auth org role.
 *
 * First save materializes the user's row. Second save just updates.
 * Race-freedom + auth checks live in the mutation service.
 */
import { getAuthSession } from "@/lib/auth-session";

import { buildSecurityContextFromSession } from "./auth/security-context";
import { upsertDashboardConfig } from "./mutation-service";
import { DASHBOARD_CONFIG_V12_VERSION } from "./extension/dashboard-config-v12";
import { buildAgentsDashboardId } from "./components/seed-configs/agents-default";
import { buildProjectsDashboardId } from "./components/seed-configs/projects-default";
import { buildTeamsDashboardId } from "./components/seed-configs/teams-default";
import { buildOrganizationsDashboardId } from "./components/seed-configs/organizations-default";
import { buildArtifactsDashboardId } from "./components/seed-configs/artifacts-default";
import type { DashboardActor } from "./permissions";

export async function saveAgentsDashboardAction(config: unknown): Promise<void> {
  const session = await getAuthSession();
  const ctx = buildSecurityContextFromSession(session);
  if (!ctx) {
    throw new Error("saveAgentsDashboardAction: no authenticated session");
  }
  const actor: DashboardActor = {
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    teamIds: ctx.teamIds,
  };
  await upsertDashboardConfig(
    buildAgentsDashboardId(ctx.organizationId, ctx.userId),
    {
      // The grid hands back a bare drizzle-cube config; the mutation service
      // wraps it into the apiVersion 1.2 analytics envelope (cinatra#326 §3b),
      // re-enveloping against the existing row so a re-save preserves scope.
      config,
      configVersion: DASHBOARD_CONFIG_V12_VERSION,
      name: "Agents",
      ownerLevel: "user",
      ownerId: ctx.userId,
      visibility: "private",
    },
    actor,
  );
}

/**
 * Save actions for the four additional dashboards. Same shape as the
 * agents action — per-org-per-user dashboard id, ownerLevel "user",
 * ownerId = caller's userId, visibility "private" — so each user
 * customises their own dashboard layout independently.
 */

async function saveCinatraDashboardAction(
  buildDashboardId: (organizationId: string, userId: string) => string,
  name: string,
  config: unknown,
): Promise<void> {
  const session = await getAuthSession();
  const ctx = buildSecurityContextFromSession(session);
  if (!ctx) {
    throw new Error(`save${name}DashboardAction: no authenticated session`);
  }
  const actor: DashboardActor = {
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    teamIds: ctx.teamIds,
  };
  await upsertDashboardConfig(
    buildDashboardId(ctx.organizationId, ctx.userId),
    {
      // Bare drizzle-cube config in; the mutation service wraps it into the
      // apiVersion 1.2 analytics envelope (cinatra#326 §3b).
      config,
      configVersion: DASHBOARD_CONFIG_V12_VERSION,
      name,
      ownerLevel: "user",
      ownerId: ctx.userId,
      visibility: "private",
    },
    actor,
  );
}

export async function saveProjectsDashboardAction(config: unknown): Promise<void> {
  await saveCinatraDashboardAction(buildProjectsDashboardId, "Projects", config);
}

export async function saveTeamsDashboardAction(config: unknown): Promise<void> {
  await saveCinatraDashboardAction(buildTeamsDashboardId, "Teams", config);
}

export async function saveOrganizationsDashboardAction(config: unknown): Promise<void> {
  await saveCinatraDashboardAction(
    buildOrganizationsDashboardId,
    "Organizations",
    config,
  );
}

export async function saveArtifactsDashboardAction(config: unknown): Promise<void> {
  await saveCinatraDashboardAction(buildArtifactsDashboardId, "Artifacts", config);
}
