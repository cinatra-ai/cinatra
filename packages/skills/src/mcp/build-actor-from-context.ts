/**
 * Pure helper that builds the actor envelope passed to skills primitive
 * handlers from a snapshot of the MCP request store.
 *
 * Lives in its own file (no transitive deps) so it can be hermetically
 * unit-tested without dragging the entire skills package import graph
 * into the test module.
 *
 * Forwarding contract: the registry pulls `userId`, `orgId`, and
 * `platformRole` from `mcpRequestContextStorage` (set by the MCP
 * transport on every request) into the actor envelope. Without this,
 * admin-gated handlers always see `platformRole: undefined` and reject
 * as `not_admin` even when the transport stamped `platform_admin`
 * (session-mode OR dev-localhost bypass).
 */
export type SkillsActorEnvelope = {
  actorType: "model";
  source: "agent";
  userId?: string;
  orgId?: string;
  platformRole?: "platform_admin" | "member";
  // Transport-resolved org-membership role, carried natively on the MCP
  // request context (resolved once at transport context-build time for the
  // SAME userId/orgId pair forwarded below) — coherent with `orgId` in this
  // envelope by construction.
  orgRole?: "org_owner" | "org_admin" | "member";
};

export function buildActorFromMcpContextWithStore(
  ctx:
    | {
        userId?: string | null;
        orgId?: string | null;
        platformRole?: "platform_admin" | "member";
        orgRole?: "org_owner" | "org_admin" | "member";
      }
    | undefined,
): SkillsActorEnvelope {
  return {
    actorType: "model",
    source: "agent",
    userId: ctx?.userId ?? undefined,
    orgId: ctx?.orgId ?? undefined,
    platformRole: ctx?.platformRole,
    orgRole: ctx?.orgRole,
  };
}
