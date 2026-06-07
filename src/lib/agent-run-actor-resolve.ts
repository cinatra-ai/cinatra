import "server-only";

// ---------------------------------------------------------------------------
// Live resolver for the AgentRunMcpActor at MCP-token mint time.
//
// Called by /api/llm-bridge when WayFlow → bridge has a resolved
// `agent_run` row carrying `orgId` and `runBy`. Looks up the LIVE
// platform role + org membership for that user and emits the actor or
// null (fall back to anonymous machine token).
//
// IMPORTANT: this MUST read fresh from the DB at every call (every LLM
// step inside the bridge). The run row carries the dispatcher's identity
// at dispatch time, but `enforceMcpBoundary` accepts {userId, orgId}
// without re-verifying the live `public.member` row. A demoted user
// could otherwise replay a stale token. The mint-time live check is the
// authority.
//
// Returns null and the caller falls back to the machine `client_credentials`
// token (preserves pre-fix behavior). The agent's MCP calls will then
// fail at the boundary with `not_org_member` — same outcome as before
// this fix, never an elevation.
// ---------------------------------------------------------------------------

import { eq, and } from "drizzle-orm";
import {
  betterAuthDb,
  betterAuthUsers,
  betterAuthMembers,
} from "@/lib/better-auth-db";
import type { AgentRunMcpActor } from "@cinatra-ai/llm";

function rolesIncludeAdmin(roleField: string | null | undefined): boolean {
  return String(roleField ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .includes("admin");
}

/**
 * Live-resolve the AgentRunMcpActor for a (runBy, orgId, runId) triple.
 *
 * Returns:
 * - actor with `platformRole: "platform_admin"` when the user row carries
 *   the admin role (irrespective of membership)
 * - actor with `platformRole: "member"` when a `public.member` row exists
 *   for (userId = runBy, organizationId = orgId)
 * - `null` otherwise (caller falls back to the machine token; boundary
 *   denies with `not_org_member` — never elevates)
 */
export async function resolveAgentRunMcpActor(input: {
  runId: string;
  runBy: string;
  orgId: string;
}): Promise<AgentRunMcpActor | null> {
  if (!input.runBy || !input.orgId || !input.runId) return null;
  const [userRow] = await betterAuthDb
    .select({ id: betterAuthUsers.id, role: betterAuthUsers.role })
    .from(betterAuthUsers)
    .where(eq(betterAuthUsers.id, input.runBy))
    .limit(1);
  if (!userRow) return null;
  if (rolesIncludeAdmin(userRow.role)) {
    return {
      delegation: "agent_run",
      userId: input.runBy,
      orgId: input.orgId,
      runId: input.runId,
      platformRole: "platform_admin",
    };
  }
  const [memberRow] = await betterAuthDb
    .select({ id: betterAuthMembers.id })
    .from(betterAuthMembers)
    .where(
      and(
        eq(betterAuthMembers.userId, input.runBy),
        eq(betterAuthMembers.organizationId, input.orgId),
      ),
    )
    .limit(1);
  if (!memberRow) return null;
  return {
    delegation: "agent_run",
    userId: input.runBy,
    orgId: input.orgId,
    runId: input.runId,
    platformRole: "member",
  };
}
