// ---------------------------------------------------------------------------
// ActorContext to objects MCP envelope.
// ---------------------------------------------------------------------------
//
// Pure, leaf module (TYPE-only imports, NO `server-only`) so it is unit-testable
// without the Next bundle context or the `@/` runtime alias. `objects-client.ts`
// consumes it for the session-aware client.
//
// The translator stamps the envelope EXACTLY as the objects handlers read it:
//   - `enforceResourceAccess` → `deriveRoleHints` derives platform/org role
//     ONLY from `actor.roles` (string[]), team roles from `actor.teamRoles`, org
//     from `actor.organizationId ?? actor.orgId`. So platform/org role is encoded
//     into `roles` here (loose `platformRole`/`orgRole` fields would be dropped).
//   - `objects_list` / `objects_get` sealed-room filter reads `actor.projectGrants`
//     directly off `request.actor`.
//   - `getActorExt` reads `actor.orgId` + `actor.userId`.

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import type { ActorContext } from "@/lib/authz/actor-context";

/** Envelope shape consumed by the objects MCP handlers (extension fields on top
 * of the MCP `PrimitiveActorContext`). */
export type ObjectsActorEnvelope = PrimitiveActorContext & {
  orgId: string | null;
  organizationId?: string;
  roles?: string[];
  teamRoles?: Record<string, "team_admin" | "member">;
  teamIds?: string[];
  projectGrants?: ActorContext["projectGrants"];
  projectIds?: string[];
};

/**
 * Translate the authorization kernel `ActorContext` into the MCP envelope the
 * objects handlers read. Role hints are encoded into the `roles` string[]
 * (`deriveRoleHints` parses: "platform_admin" → platformRole; "owner" →
 * org_owner; "admin" → org_admin; "member" → member).
 */
export function actorContextToObjectsEnvelope(actor: ActorContext): ObjectsActorEnvelope {
  const roles: string[] = [];
  if (actor.platformRole === "platform_admin") roles.push("platform_admin");
  if (actor.orgRole === "org_owner") roles.push("owner");
  else if (actor.orgRole === "org_admin") roles.push("admin");
  else if (actor.orgRole === "member") roles.push("member");

  const actorType: PrimitiveActorContext["actorType"] =
    actor.principalType === "HumanUser"
      ? "human"
      : actor.principalType === "ExternalA2AAgent"
        ? "a2a"
        : "system";

  const source: PrimitiveActorContext["source"] =
    actor.authSource === "worker"
      ? "worker"
      : actor.authSource === "agent"
        ? "agent"
        : "ui";

  return {
    actorType,
    source,
    // userId only for human principals — System/worker actors are user-less, so
    // `deriveSaveDefaults` correctly defaults them to org-level ownership.
    ...(actor.principalType === "HumanUser" ? { userId: actor.principalId } : {}),
    orgId: actor.organizationId ?? null,
    ...(actor.organizationId !== undefined ? { organizationId: actor.organizationId } : {}),
    ...(roles.length > 0 ? { roles } : {}),
    ...(actor.teamRoles !== undefined ? { teamRoles: actor.teamRoles } : {}),
    ...(actor.teamIds !== undefined ? { teamIds: actor.teamIds } : {}),
    ...(actor.projectGrants !== undefined ? { projectGrants: actor.projectGrants } : {}),
    ...(actor.projectIds !== undefined ? { projectIds: actor.projectIds } : {}),
  } as ObjectsActorEnvelope;
}
