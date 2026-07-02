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

// cinatra#408 — run source types whose actor must NEVER resolve to
// `platform_admin`. The public-site widget path carries a logged-in END USER's
// identity (`runBy = userId`); a platform admin who is ALSO a widget user must
// be gated by their per-user/per-connector rights (cinatra#409), NOT waved
// through by the platform-admin immediate-allow at the MCP boundary
// (mcp-boundary.ts:207). Suppressing the bypass HERE — at the single mint-time
// resolver — means the actor never carries `platform_admin` for this path, so
// the boundary's immediate-allow is never reached (resolver-only suppression,
// codex-converged O2; the load-bearing proof is the end-to-end actor assertion).
const PLATFORM_ADMIN_SUPPRESSED_SOURCE_TYPES = new Set<string>(["public_site_widget"]);

/**
 * Live-resolve the AgentRunMcpActor for a (runBy, orgId, runId) triple.
 *
 * Returns:
 * - actor with `platformRole: "platform_admin"` when the user row carries
 *   the admin role (irrespective of membership) — UNLESS `sourceType` is in
 *   `PLATFORM_ADMIN_SUPPRESSED_SOURCE_TYPES` (the public-site widget path),
 *   in which case the admin short-circuit is suppressed and resolution falls
 *   through to the live `member`-row check (cinatra#408)
 * - actor with `platformRole: "member"` when a `public.member` row exists
 *   for (userId = runBy, organizationId = orgId)
 * - `null` otherwise (caller falls back to the machine token; boundary
 *   denies with `not_org_member` — never elevates). For a suppressed source
 *   type, an admin who is NOT a live org member also resolves to `null` →
 *   denied (never an elevation).
 */
export async function resolveAgentRunMcpActor(input: {
  runId: string;
  runBy: string;
  orgId: string;
  /**
   * The carrier run's `source_type`. When it is a platform-admin-suppressed
   * source (`public_site_widget`), the `platform_admin` short-circuit is
   * skipped so a widget user can never resolve to `platform_admin` (cinatra#408).
   * Absent / any other value → unchanged behavior.
   */
  sourceType?: string | null;
}): Promise<AgentRunMcpActor | null> {
  if (!input.runBy || !input.orgId || !input.runId) return null;
  const suppressPlatformAdmin =
    typeof input.sourceType === "string" &&
    PLATFORM_ADMIN_SUPPRESSED_SOURCE_TYPES.has(input.sourceType);
  const [userRow] = await betterAuthDb
    .select({ id: betterAuthUsers.id, role: betterAuthUsers.role })
    .from(betterAuthUsers)
    .where(eq(betterAuthUsers.id, input.runBy))
    .limit(1);
  if (!userRow) return null;
  if (!suppressPlatformAdmin && rolesIncludeAdmin(userRow.role)) {
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
