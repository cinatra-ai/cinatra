import "server-only";

// ---------------------------------------------------------------------------
// SINGLE-TENANT identity resolver for host-initiated content-editor dispatch.
//
// WHY THIS EXISTS
// The CMS content-editor write (WordPress / Drupal) is dispatched HOST-side via
// `dispatchContentEditorViaA2A` (src/lib/host-content-editor-dispatch.ts). That
// path has NO user session — it is triggered by the connector's MCP primitive,
// not by an authenticated browser request. To authorize the downstream
// `/api/mcp` write through the PRODUCTION agent-run OBO path (NOT the
// dev-admin bypass), the dispatcher must pre-create a real `agent_run` row
// bound to a concrete {orgId, runBy}. The bridge (`/api/llm-bridge`) then
// resolves that run and mints an on-behalf-of actor token via
// `resolveAgentRunMcpActor` → `buildLlmMcpServerToolForAgentRun`. Without a
// resolved {orgId, runBy}, the bridge falls back to the anonymous
// machine `client_credentials` token and `enforceMcpBoundary` denies the
// write with `not_org_member`.
//
// ⚠️ SINGLE-TENANT FALLBACK — HONEST ONLY FOR SINGLE-ORG DEPLOYMENTS.
// This resolver answers "which org + which user should own a host-initiated
// content-editor run?" by picking:
//   • orgId  = the OLDEST organization (`resolveDefaultOrgId`, createdAt ASC)
//   • runBy  = the OLDEST owner/admin MEMBER of that org (createdAt ASC)
// That is correct for a single-org install (the one org IS the tenant, and its
// founding admin is the legitimate write actor). It is NOT correct for a
// multi-tenant deployment: there, the org/user that owns a given CMS instance
// must be derived from the instance↔tenant binding, not from "oldest org".
// Multi-tenant identity resolution is tracked separately in cinatra#274 and is
// intentionally NOT implemented here.
//
// FAIL-SOFT: returns `null` when no org or no owner/admin member can be
// resolved. The caller then preserves the pre-fix behavior (anonymous A2A
// dispatch, no agent_run) — the write fails closed at the MCP boundary exactly
// as it did before this fix. This resolver NEVER elevates: it only ever names
// a real owner/admin member that already exists in the database.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { resolveDefaultOrgId } from "@cinatra-ai/agents";
import { betterAuthDb, betterAuthMembers } from "@/lib/better-auth-db";

export type SingleTenantContentEditorIdentity = {
  /** Oldest organization id (the single tenant). */
  orgId: string;
  /** User id of that org's oldest owner/admin member — the OBO write actor. */
  runBy: string;
};

/** Better Auth stores membership role as comma-joined text ("owner,admin");
 * treat a row as admin-capable when it carries either "owner" or "admin". */
function isAdminCapable(roleField: string | null | undefined): boolean {
  const tokens = String(roleField ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  return tokens.includes("owner") || tokens.includes("admin");
}

/**
 * Resolve the {orgId, runBy} that a host-initiated (session-less)
 * content-editor run should execute as, using the single-tenant fallback
 * documented at the top of this file.
 *
 * Returns `null` when the default org or an owner/admin member of it cannot be
 * found — the caller MUST fall back to the anonymous dispatch path in that
 * case (never elevate, never block).
 */
export async function resolveSingleTenantContentEditorIdentity(): Promise<SingleTenantContentEditorIdentity | null> {
  const orgId = await resolveDefaultOrgId();
  if (!orgId) return null;

  // Oldest owner/admin member of the default org. We order by createdAt ASC and
  // filter for admin-capable roles in JS (role is comma-joined free text, so a
  // SQL equality predicate would miss "owner,admin"). The first match is the
  // founding admin of a single-org install.
  const members = await betterAuthDb
    .select({
      userId: betterAuthMembers.userId,
      role: betterAuthMembers.role,
      createdAt: betterAuthMembers.createdAt,
    })
    .from(betterAuthMembers)
    .where(eq(betterAuthMembers.organizationId, orgId))
    .orderBy(betterAuthMembers.createdAt);

  const admin = members.find((m) => isAdminCapable(m.role));
  if (!admin?.userId) return null;

  return { orgId, runBy: admin.userId };
}
