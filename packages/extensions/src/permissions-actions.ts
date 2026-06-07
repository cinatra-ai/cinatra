"use server";

// ---------------------------------------------------------------------------
// Generic Extension Permissions server actions.
//
// Single kind-discriminated API binding the PermissionsForm widget on every
// resource kind, covering:
//   - packages/agents/src/permissions-actions.ts (run policy)
//   - packages/agents/src/run-sharing-actions.ts (run co-owners + search)
//   - packages/skills/src/permissions-actions.ts (skill_package)
//   - packages/skills/src/skill-permissions-actions.ts (skill)
//
// All call sites pass (kind, resourceId). Per-kind divergences live in
// permissions-kind-hooks.ts; this file is intentionally kind-agnostic
// beyond delegating to those hooks.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { and, eq, ilike, isNull, notInArray, or } from "drizzle-orm";

import { isPlatformAdmin, requireAuthSession } from "@/lib/auth-session";
import { betterAuthDb, betterAuthUsers } from "@/lib/better-auth-db";

import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";
// Never trust the TS-typed `policy` argument at runtime. Every save path
// zod-parses the payload before any write or after-write hook fires.
// auth-policy.ts treats unknown visibility strings as the fallthrough
// "org" case, so malformed input could otherwise widen access rather
// than fail closed.
import { AgentAuthPolicySchema } from "@cinatra-ai/agents/auth-policy";

import {
  type ExtensionKind,
  getExtensionKindHooks,
  isExtensionKind,
} from "./permissions-kind-hooks";
import {
  addExtensionCoOwner as addExtensionCoOwnerStore,
  readExtensionAccessPolicy,
  readExtensionCoOwners,
  readExtensionInstalledBy,
  removeExtensionCoOwner as removeExtensionCoOwnerStore,
  writeExtensionAccessPolicy,
} from "./permissions-store";

// Scope-containment validator: a pure subset rule, lookup-driven for
// team→org and project→org parentage.
import { policyContainedBy, type ContainmentLookups } from "./scope-containment";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExtensionPermissionsResult =
  | { ok: true }
  | { ok: false; error?: string };

export type ExtensionSharingCandidate = {
  id: string;
  name: string;
  email: string;
  image: string | null;
};

export type ExtensionPermissionsSearchResult =
  | { ok: true; results: ExtensionSharingCandidate[]; hasMore: boolean }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

async function canEditExtension(
  kind: ExtensionKind,
  resourceId: string,
  callerUserId: string,
  isAdmin: boolean,
): Promise<boolean> {
  if (isAdmin) return true;
  const installedBy = await readExtensionInstalledBy(kind, resourceId);
  if (installedBy === callerUserId) return true;
  const coOwners = await readExtensionCoOwners(kind, resourceId);
  if (coOwners.some((c) => c.userId === callerUserId)) return true;
  // Per-kind extra editors (e.g. skill consults parent-package; agent_run
  // checks runBy; agent_template checks creator_id).
  const hooks = await getExtensionKindHooks(kind);
  const extras = (await hooks.extraEditors?.(resourceId)) ?? [];
  return extras.includes(callerUserId);
}

function assertKind(kind: string): kind is ExtensionKind {
  if (!isExtensionKind(kind)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Revalidation — single owner so per-call-site mount paths can't drift.
// ---------------------------------------------------------------------------

const KIND_REVALIDATE_PATHS: Record<ExtensionKind, string[]> = {
  agent_run: ["/agents"],
  agent_template: ["/configuration/extensions"],
  skill_package: ["/skills"],
  skill: ["/skills"],
  // Installed-extension-anchored kinds.
  connector: ["/connectors"],
  artifact: ["/configuration/extensions"],
  workflow: ["/configuration/extensions"],
};

// ---------------------------------------------------------------------------
// Scope-containment helpers
//
// `saveExtensionAccessPolicy` for `kind="agent_run"` must verify the
// proposed policy is ⊆ the parent agent_template's policy. Pure subset
// logic lives in scope-containment.ts; this section wires it to the
// repository-level lookups (Better Auth + projects).
// ---------------------------------------------------------------------------

async function buildContainmentLookupsForRun(runId: string): Promise<{
  lookups: ContainmentLookups;
  resolvedRunOrgId: string | null;
}> {
  const { readAgentRunById } = await import("@cinatra-ai/agents/store");
  const run = await readAgentRunById(runId);
  const runOrgId = run?.orgId ?? null;

  const lookups: ContainmentLookups = {
    async teamOrg(teamId: string): Promise<string | null> {
      const { sql } = await import("drizzle-orm");
      const result = await betterAuthDb.execute<{ organizationId: string }>(sql`
        SELECT "organizationId" FROM public."team" WHERE id = ${teamId} LIMIT 1
      `);
      const row = result.rows?.[0];
      return row?.organizationId ?? null;
    },
    async projectOrg(projectId: string): Promise<string | null> {
      // Project rows live in the cinatra schema. Use the existing readers
      // when available; for now a lightweight direct query against the
      // typed projects table.
      const { sql } = await import("drizzle-orm");
      const { db: agentsDb } = await import("@cinatra-ai/agents/db");
      const rows = await agentsDb.execute<{ owner_id: string; owner_level: string }>(sql`
        SELECT owner_id, owner_level FROM cinatra.projects WHERE id = ${projectId} LIMIT 1
      `);
      const row = rows.rows?.[0] ?? rows[0];
      if (!row) return null;
      // Project's org is the project.owner_id when owner_level='organization'.
      // For team/user-owned projects, walk up to the org via the team or user.
      if (row.owner_level === "organization") return row.owner_id;
      if (row.owner_level === "team") {
        return await lookups.teamOrg(row.owner_id);
      }
      // user-owned projects → no canonical org; return null (fail-closed).
      return null;
    },
    async resolveLegacyOrg(): Promise<string | null> {
      return runOrgId;
    },
  };

  return { lookups, resolvedRunOrgId: runOrgId };
}

/**
 * Scope-containment assertion for `agent_run` policy writes.
 *
 * Loads the run, walks to its template, fetches the template's effective
 * extension access policy (falling back to DEFAULT_AGENT_AUTH_POLICY when
 * no override exists), then verifies every visibility field of the
 * proposed run policy is ⊆ the corresponding field on the template.
 *
 * Failure modes:
 *   - Run not found / no templateId → fail-closed (caller will return
 *     not_found upstream).
 *   - Any visibility field exceeds parent → `{ ok:false, ... }`.
 */
async function assertAgentRunPolicyContainedByTemplate(
  runId: string,
  policy: AgentAuthPolicy,
): Promise<{ ok: true } | { ok: false }> {
  const { readAgentRunById, readAgentTemplateById } = await import("@cinatra-ai/agents/store");
  const run = await readAgentRunById(runId);
  if (!run?.templateId) {
    // Fail-closed: a missing template means we cannot establish the parent
    // scope, so reject any non-owner write. The caller's resourceExists
    // gate should have already short-circuited; this is defense-in-depth.
    if (
      policy.runListVisibility !== "owner" ||
      policy.runDataVisibility !== "owner" ||
      policy.runExecuteVisibility !== "owner"
    ) {
      return { ok: false };
    }
    return { ok: true };
  }

  // Parent policy source unification.
  //
  // The template's effective auth policy comes from `agent_templates.
  // agent_auth_policy` (the `template.agentAuthPolicy` column). The
  // polymorphic `extension_access_policy` row for kind='agent_template' is
  // a dual-write of that same data, NOT an independent source. Reading
  // them separately can return divergent values. Unify on
  // `template.agentAuthPolicy` so the server validator and the UX
  // pre-filter (which uses the same field) cannot disagree.
  const template = await readAgentTemplateById(run.templateId);
  const parentPolicy: AgentAuthPolicy = template?.agentAuthPolicy ?? {
    runListVisibility: "owner",
    runDataVisibility: "owner",
    runExecuteVisibility: "owner",
    allowRunSharing: false,
  };

  const { lookups } = await buildContainmentLookupsForRun(runId);
  return policyContainedBy(policy, parentPolicy, lookups);
}

function revalidateForKind(kind: ExtensionKind): void {
  for (const path of KIND_REVALIDATE_PATHS[kind] ?? []) {
    try {
      revalidatePath(path);
    } catch {
      // Best-effort; revalidatePath throws only when called outside a
      // request scope (e.g. from a script). Not fatal.
    }
  }
}

// ---------------------------------------------------------------------------
// Save access policy
// ---------------------------------------------------------------------------

export async function saveExtensionAccessPolicy(
  kind: string,
  resourceId: string,
  policy: AgentAuthPolicy,
): Promise<ExtensionPermissionsResult> {
  if (!assertKind(kind)) return { ok: false, error: "invalid_kind" };

  // Zod-validate the policy before any write or after-write hook. Server
  // actions get untyped JSON at runtime; we must not trust the call-site
  // TS type.
  const parsed = AgentAuthPolicySchema.safeParse(policy);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const validatedPolicy = parsed.data;

  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { ok: false, error: "unauthorized" };

  const hooks = await getExtensionKindHooks(kind);
  if (!(await hooks.resourceExists(resourceId))) {
    return { ok: false, error: "not_found" };
  }

  const isAdmin = isPlatformAdmin(session);
  if (!(await canEditExtension(kind, resourceId, userId, isAdmin))) {
    return { ok: false, error: "forbidden" };
  }

  // A run's policy must be ⊆ the parent agent_template's policy. Other
  // kinds (skill_package, skill, agent_template) are the parent-scope
  // themselves and have no upper bound to contain.
  if (kind === "agent_run") {
    const containment = await assertAgentRunPolicyContainedByTemplate(
      resourceId,
      validatedPolicy,
    );
    if (!containment.ok) {
      return { ok: false, error: "scope_exceeds_parent" };
    }
  }

  await writeExtensionAccessPolicy(kind, resourceId, validatedPolicy);

  // Per-kind post-write side effects (e.g. skill's compatibility projection
  // back into (level, scope)). Never throws — wrapped to keep the canonical
  // write durable. Hook failures are logged but not surfaced via this
  // action's return; install-time callers carry their own warnings[] via
  // the import action shape.
  try {
    await hooks.afterPolicyWrite?.(resourceId, validatedPolicy);
  } catch (err) {
    console.warn(
      `[extensions/permissions-actions] afterPolicyWrite hook failed for kind=${kind} id=${resourceId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  revalidateForKind(kind);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Set primary owner (used by install / create paths)
// ---------------------------------------------------------------------------

/**
 * Set or clear the primary owner (installed_by_user_id) for a resource.
 * Admin-only: this is a privileged transfer-of-ownership surface.
 * Callers from install / import flows pass the session user as
 * installedByUserId; admin tools may pass null to release the slot.
 *
 * Self-enforces authorization and target validation instead of relying on
 * caller discipline:
 *   - requireAdminSession()
 *   - hooks.resourceExists(resourceId)
 *   - betterAuth users.id existence check when installedByUserId !== null
 */
export async function setExtensionInstaller(
  kind: string,
  resourceId: string,
  installedByUserId: string | null,
): Promise<ExtensionPermissionsResult> {
  if (!assertKind(kind)) return { ok: false, error: "invalid_kind" };

  const { requireAdminSession } = await import("@/lib/auth-session");
  try {
    await requireAdminSession();
  } catch {
    return { ok: false, error: "unauthorized" };
  }

  const hooks = await getExtensionKindHooks(kind);
  if (!(await hooks.resourceExists(resourceId))) {
    return { ok: false, error: "not_found" };
  }

  if (installedByUserId !== null) {
    // Same humans-only predicate as addExtensionCoOwner.
    // setExtensionInstaller is admin-callable with an arbitrary user id, so
    // without this guard an admin could assign primary-owner permissions to
    // an assistant / service user (chatgpt, etc.).
    const [targetUser] = await betterAuthDb
      .select({ id: betterAuthUsers.id })
      .from(betterAuthUsers)
      .where(
        and(
          eq(betterAuthUsers.id, installedByUserId),
          or(
            isNull(betterAuthUsers.userType),
            eq(betterAuthUsers.userType, "human"),
          ),
        ),
      )
      .limit(1);
    if (!targetUser) return { ok: false, error: "user_not_found" };
  }

  const { setExtensionInstalledBy } = await import("./permissions-store");
  await setExtensionInstalledBy(kind, resourceId, installedByUserId);

  // Mirror to the kind-specific installer projection (e.g.
  // skill_packages.payload.installedByUserId) so readers of that projection
  // stay consistent.
  try {
    await hooks.afterInstallerSet?.(resourceId, installedByUserId);
  } catch (err) {
    console.warn(
      `[extensions/permissions-actions] afterInstallerSet hook failed for kind=${kind} id=${resourceId}:`,
      err instanceof Error ? err.message : err,
    );
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Co-owner candidate search
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export async function searchExtensionCoOwnerCandidates(
  kind: string,
  resourceId: string | null,
  query: string,
  page?: { offset?: number; limit?: number },
): Promise<ExtensionPermissionsSearchResult> {
  if (!assertKind(kind)) return { ok: false, error: "invalid_kind" };

  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { ok: false, error: "unauthorized" };

  const activeOrganizationId = session?.session?.activeOrganizationId ?? null;
  if (!activeOrganizationId) return { ok: false, error: "no_active_org" };

  const isAdmin = isPlatformAdmin(session);

  // When resourceId is null the caller is in the upload flow (the resource
  // doesn't exist yet); admin-only gate. When set, the regular edit gate.
  if (resourceId === null) {
    if (!isAdmin) return { ok: false, error: "forbidden" };
  } else {
    const hooks = await getExtensionKindHooks(kind);
    if (!(await hooks.resourceExists(resourceId))) {
      return { ok: false, error: "not_found" };
    }
    if (!(await canEditExtension(kind, resourceId, userId, isAdmin))) {
      return { ok: false, error: "forbidden" };
    }
  }

  const requestedLimit = Math.min(
    Math.max(1, Math.floor(page?.limit ?? DEFAULT_PAGE_SIZE)),
    MAX_PAGE_SIZE,
  );
  const offset = Math.max(0, Math.floor(page?.offset ?? 0));

  // Exclude the caller + existing co-owners of THIS resource (when one
  // exists). For upload-mode the resource doesn't have any yet.
  let excludeIds: string[] = [userId];
  if (resourceId !== null) {
    const existing = await readExtensionCoOwners(kind, resourceId);
    const installedBy = await readExtensionInstalledBy(kind, resourceId);
    excludeIds = [
      userId,
      ...existing.map((c) => c.userId),
      ...(installedBy ? [installedBy] : []),
    ];
  }

  const trimmed = query.trim();
  const like = trimmed.length > 0
    ? `%${trimmed.replace(/[%_]/g, "\\$&")}%`
    : null;

  const rows = await betterAuthDb
    .select({
      id: betterAuthUsers.id,
      name: betterAuthUsers.name,
      email: betterAuthUsers.email,
      image: betterAuthUsers.image,
    })
    .from(betterAuthUsers)
    .where(
      and(
        excludeIds.length > 0 ? notInArray(betterAuthUsers.id, excludeIds) : undefined,
        // Humans-only.
        or(
          isNull(betterAuthUsers.userType),
          eq(betterAuthUsers.userType, "human"),
        ),
        like !== null
          ? or(
              ilike(betterAuthUsers.name, like),
              ilike(betterAuthUsers.email, like),
            )
          : undefined,
      ),
    )
    .orderBy(betterAuthUsers.name)
    .limit(requestedLimit + 1)
    .offset(offset);

  const hasMore = rows.length > requestedLimit;
  const trimmedRows = hasMore ? rows.slice(0, requestedLimit) : rows;

  return {
    ok: true,
    results: trimmedRows.map((r) => ({
      id: r.id,
      name: r.name ?? r.email ?? "Unknown",
      email: r.email ?? "",
      image: r.image,
    })),
    hasMore,
  };
}

// ---------------------------------------------------------------------------
// Add / remove co-owner
// ---------------------------------------------------------------------------

export async function addExtensionCoOwner(
  kind: string,
  resourceId: string,
  targetUserId: string,
): Promise<ExtensionPermissionsResult> {
  if (!assertKind(kind)) return { ok: false, error: "invalid_kind" };

  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { ok: false, error: "unauthorized" };

  const hooks = await getExtensionKindHooks(kind);
  if (!(await hooks.resourceExists(resourceId))) {
    return { ok: false, error: "not_found" };
  }

  const isAdmin = isPlatformAdmin(session);
  if (!(await canEditExtension(kind, resourceId, userId, isAdmin))) {
    return { ok: false, error: "forbidden" };
  }

  // Per-kind sharing gate (e.g. agent_run.allowRunSharing).
  const sharingError = await hooks.allowSharing?.(resourceId);
  if (sharingError) return { ok: false, error: sharingError };

  // Same humans-only direct-add guard as installer assignment.
  const [targetUser] = await betterAuthDb
    .select({ id: betterAuthUsers.id })
    .from(betterAuthUsers)
    .where(
      and(
        eq(betterAuthUsers.id, targetUserId),
        or(
          isNull(betterAuthUsers.userType),
          eq(betterAuthUsers.userType, "human"),
        ),
      ),
    )
    .limit(1);
  if (!targetUser) return { ok: false, error: "user_not_found" };

  // Co-owner containment for agent_run: reject a co-owner add when the
  // parent template's runListVisibility is "owner" — by definition every
  // co-owner add at owner-scope widens beyond what the template allows.
  // A fuller per-user containment check would need membership lookups for
  // arbitrary user ids.
  if (kind === "agent_run") {
    const { readAgentRunById } = await import("@cinatra-ai/agents/store");
    const run = await readAgentRunById(resourceId);
    if (run?.templateId) {
      const parentPolicy = await readExtensionAccessPolicy("agent_template", run.templateId);
      const parentList = parentPolicy?.runListVisibility ?? "owner";
      if (parentList === "owner") {
        return { ok: false, error: "scope_exceeds_parent" };
      }
    }
  }

  await addExtensionCoOwnerStore(kind, resourceId, targetUserId, userId);

  // Mirror to the kind-specific co-owner projection.
  try {
    await hooks.afterCoOwnerAdd?.(resourceId, targetUserId, userId);
  } catch (err) {
    console.warn(
      `[extensions/permissions-actions] afterCoOwnerAdd hook failed for kind=${kind} id=${resourceId}:`,
      err instanceof Error ? err.message : err,
    );
  }
  revalidateForKind(kind);
  return { ok: true };
}

export async function removeExtensionCoOwner(
  kind: string,
  resourceId: string,
  targetUserId: string,
): Promise<ExtensionPermissionsResult> {
  if (!assertKind(kind)) return { ok: false, error: "invalid_kind" };

  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { ok: false, error: "unauthorized" };

  const hooks = await getExtensionKindHooks(kind);
  if (!(await hooks.resourceExists(resourceId))) {
    return { ok: false, error: "not_found" };
  }

  const isAdmin = isPlatformAdmin(session);
  if (!(await canEditExtension(kind, resourceId, userId, isAdmin))) {
    return { ok: false, error: "forbidden" };
  }

  await removeExtensionCoOwnerStore(kind, resourceId, targetUserId);

  // Mirror to the kind-specific co-owner projection.
  try {
    await hooks.afterCoOwnerRemove?.(resourceId, targetUserId);
  } catch (err) {
    console.warn(
      `[extensions/permissions-actions] afterCoOwnerRemove hook failed for kind=${kind} id=${resourceId}:`,
      err instanceof Error ? err.message : err,
    );
  }
  revalidateForKind(kind);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Read access policy (used by page-data loaders + post-install flows)
// ---------------------------------------------------------------------------

export async function readExtensionAccessPolicyAction(
  kind: string,
  resourceId: string,
): Promise<AgentAuthPolicy | null> {
  if (!assertKind(kind)) return null;
  await requireAuthSession();
  return readExtensionAccessPolicy(kind, resourceId);
}
