import "server-only";

// Shared portlet authz helpers. Bridges the session into the EXACT actor
// shapes each layer needs: the kernel ActorContext for objects-store reads,
// and a PrimitiveActorContext + role hints for enforceResourceAccess (passing
// the kernel ActorContext directly would rebuild a default "system" actor and
// mis-gate). Mirrors restore-object-version-action.ts.
import { requireAuthSession, resolveOrgRoleForSession, getActorContext } from "@/lib/auth-session";
import { actorFromSession } from "@/lib/authz/build-actor-context";
import { normalizeOwnerLevel } from "@/lib/authz/resource-ref";
import { enforceResourceAccess } from "@/lib/authz/enforce-resource-access";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { ObjectRecord } from "@/lib/objects-store";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

export type PortletAuthz = {
  orgId: string | null;
  primitiveActor: ReturnType<typeof actorFromSession>;
  roleHints: { orgRole: "org_owner" | "org_admin" | "member" } | undefined;
  /** Kernel ActorContext for store reads that take one (e.g. the artifacts service). */
  actorContext: ActorContext | undefined;
};

/** Resolve the session into the org id + the primitive actor + role hints + the
 *  kernel ActorContext the portlet loaders need. Scope is ALWAYS session-derived
 *  (no caller override). */
export async function resolvePortletAuthz(): Promise<PortletAuthz> {
  const session = await requireAuthSession();
  const orgId = session.session?.activeOrganizationId ?? null;
  const primitiveActor = actorFromSession(session);
  const orgRole = orgId ? await resolveOrgRoleForSession(session) : null;
  const actorContext = await getActorContext();
  return { orgId, primitiveActor, roleHints: orgRole ? { orgRole } : undefined, actorContext };
}

/** A PrimitiveActorContext carrying the org/user/role/team fields the workflows
 *  + agents in-process primitive handlers read (`orgId`, `userId`, `orgRole`,
 *  `teamIds`, `projectIds`, `platformRole`). Used by the launcher/edit portlet
 *  ACTIONS (mutations). Scope is ALWAYS session-derived — the action never trusts
 *  a client-supplied actor. The handlers themselves re-gate every effect. */
export type PortletPrimitiveActor = PrimitiveActorContext & {
  orgRole?: "org_owner" | "org_admin" | "member";
  teamIds?: string[];
  projectIds?: string[];
};

export async function resolvePortletPrimitiveActor(): Promise<PortletPrimitiveActor> {
  const session = await requireAuthSession();
  const orgId = session.session?.activeOrganizationId ?? null;
  const orgRole = orgId ? await resolveOrgRoleForSession(session) : undefined;
  const ctx = await getActorContext();
  return {
    actorType: "human",
    source: "ui",
    userId: session.user.id,
    orgId,
    ...(orgRole ? { orgRole } : {}),
    ...(ctx?.teamIds ? { teamIds: [...ctx.teamIds] } : {}),
    ...(ctx?.projectIds ? { projectIds: [...ctx.projectIds] } : {}),
    ...(ctx?.platformRole ? { platformRole: ctx.platformRole } : {}),
  };
}

/** Pure object → resource-check (canonical "private" fallback for unexpected
 *  visibility; mirrors packages/objects/src/mcp/handlers.ts buildObjectResourceCheck
 *  WITHOUT importing the heavy MCP module). */
export function objectResourceCheck(row: ObjectRecord) {
  return {
    resourceType: "object" as const,
    resourceId: row.id,
    organizationId: row.orgId ?? null,
    ownerLevel: normalizeOwnerLevel(row.ownerLevel ?? "organization"),
    ownerId: row.ownerId ?? "",
    visibility:
      row.visibility === "private" || row.visibility === "team" || row.visibility === "organization" || row.visibility === "public"
        ? row.visibility
        : "private",
  };
}

/** True if the actor may read the object row (per-row gate for list portlets). */
export async function canReadObject(row: ObjectRecord, authz: PortletAuthz): Promise<boolean> {
  try {
    await enforceResourceAccess(objectResourceCheck(row), authz.primitiveActor, "object.read", authz.roleHints);
    return true;
  } catch {
    return false;
  }
}
