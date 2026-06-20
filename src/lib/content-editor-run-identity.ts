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
import { readConnectorConfigFromDatabase } from "@/lib/database";
import { originMatchesSiteUrl } from "@/lib/widget-stream-auth";

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

// ---------------------------------------------------------------------------
// MULTI-TENANT install→org resolver (cinatra#274).
//
// Resolves the {orgId, runBy} a host-initiated content-editor run should
// execute as from the PERSISTED install→org binding on the matching
// connector_config instance row, instead of the single-tenant default. Each
// CMS install (WordPress / Drupal) that configured the widget carries the
// configuring admin's {orgId, runBy} (captured at save; see wordpress-api.ts /
// drupal-api.ts), so a multi-tenant deployment writes as the correct org per
// install.
//
// ORIGIN IS AUTHORITATIVE (codex#274 correction). The request-body `instanceId`
// is client-supplied (only sanitized) and therefore FORGEABLE — it must never
// outrank, NOR substitute for, the verified origin. `origin` is the token-bound,
// server-verified site origin (from consumeWidgetStreamToken). Matching:
//   • A verified `origin` is REQUIRED to select a per-install binding. Rows are
//     matched by origin; a supplied `instanceId` may only DISAMBIGUATE among
//     those origin-matched rows. An `instanceId` that names a DIFFERENT row is
//     ignored (never binds the id-only row), closing the cross-tenant
//     confused-deputy hole.
//   • With NO verified origin, there is NO per-install binding — a client-
//     asserted `instanceId` alone is forgeable, so we go straight to the
//     single-tenant fallback. (The connector-side dispatch path carries neither
//     origin nor instanceId and lands here too.)
//
// A matched row is used ONLY when it carries a COMPLETE binding (both orgId and
// runBy non-empty). Any miss — no row, an incomplete (pre-binding) row, or an
// id/origin disagreement — FALLS THROUGH to the single-tenant resolver, which
// itself fails soft to `null`. So this resolver preserves #246's posture
// exactly: it never elevates, and a no-binding install writes via the
// single-tenant fallback (or fails closed at the MCP boundary), never via a
// forged or borrowed identity.
// ---------------------------------------------------------------------------

type StoredInstanceRow = {
  id?: unknown;
  siteUrl?: unknown;
  orgId?: unknown;
  runBy?: unknown;
};

function completeBinding(
  row: StoredInstanceRow | undefined,
): SingleTenantContentEditorIdentity | null {
  const orgId = typeof row?.orgId === "string" ? row.orgId.trim() : "";
  const runBy = typeof row?.runBy === "string" ? row.runBy.trim() : "";
  if (!orgId || !runBy) return null;
  return { orgId, runBy };
}

export type ContentEditorInstanceContext = {
  /** `connector_config` key whose `instances[]` hold the install rows
   * ("wordpress" | "drupal"). From the widget-stream agent's `auth`. */
  instancesConfigKey: string;
  /** Token-bound, server-verified site origin (authoritative). */
  origin?: string | null;
  /** Client-supplied (sanitized) instance id — disambiguation ONLY. */
  instanceId?: string | null;
};

/**
 * Resolve the {orgId, runBy} for a host-initiated content-editor run, PREFERRING
 * the per-install persisted binding (cinatra#274) and falling back to the
 * single-tenant identity. See the block comment above for the full matching
 * contract. Returns `null` only when BOTH the per-install binding and the
 * single-tenant fallback are unavailable (caller then dispatches anonymously —
 * the write fails closed at the MCP boundary, never elevated).
 */
export async function resolveContentEditorIdentityForInstance(
  ctx: ContentEditorInstanceContext,
): Promise<SingleTenantContentEditorIdentity | null> {
  const instancesConfigKey = String(ctx.instancesConfigKey ?? "").trim();
  const origin = typeof ctx.origin === "string" ? ctx.origin.trim() : "";
  const instanceId = typeof ctx.instanceId === "string" ? ctx.instanceId.trim() : "";

  if (instancesConfigKey) {
    const config = readConnectorConfigFromDatabase<{ instances?: unknown }>(
      instancesConfigKey,
      { instances: [] },
    );
    const instances: StoredInstanceRow[] = Array.isArray(config?.instances)
      ? (config.instances.filter((r) => r && typeof r === "object") as StoredInstanceRow[])
      : [];

    // Origin is REQUIRED and authoritative. With no verified origin there is no
    // per-install binding (a client-asserted instanceId alone is forgeable) — we
    // fall through to single-tenant. Match rows by origin; an instanceId may only
    // narrow among origin-matched rows, never select a different row.
    let matched: StoredInstanceRow | undefined;
    if (origin) {
      const originMatches = instances.filter((r) =>
        originMatchesSiteUrl(origin, typeof r.siteUrl === "string" ? r.siteUrl : ""),
      );
      matched = instanceId
        ? originMatches.find((r) => typeof r.id === "string" && r.id.trim() === instanceId) ??
          // A mismatched instanceId is ignored: still bind to the verified
          // origin's row when it is unambiguous.
          (originMatches.length === 1 ? originMatches[0] : undefined)
        : originMatches.length === 1
          ? originMatches[0]
          : undefined;
    }

    const binding = completeBinding(matched);
    if (binding) return binding;
  }

  // No per-install binding (no match, incomplete row, or no anchors) → the
  // single-tenant fallback (which itself fails soft to null).
  return resolveSingleTenantContentEditorIdentity();
}
