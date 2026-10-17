"use server";

import "server-only";

import { resolveCrmListReader } from "@/lib/crm-integration-providers";
import { requireActorContext, requireAuthSession } from "@/lib/auth-session";
import { actorFromSession, type ActorRoleHints } from "@/lib/authz/build-actor-context";
import { enforceRunAccess } from "./auth-policy";
import { readAgentRunById } from "./store";

// The picker still exposes the legacy `AvailableListSummary` shape so its
// downstream consumers (orchestrator panels, list-curator scrape renderer,
// agent-builder steppers) don't need to migrate in the same slice. The
// source of truth is the CRM list-read capability surface — registered by the
// crm-connector's `register(ctx)` over the Twenty Views provider — resolved
// at call time instead of value-importing the connector package
// (cinatra#151 Stage 4); the outward shape is preserved.
//
// Field mapping from CrmList -> AvailableListSummary:
//   id          : CrmList.id
//   name        : CrmList.name
//   memberCount : NOT available from `crm_list_search` (Twenty Views are
//                 filter-defined, not materialized). Until the resolver
//                 wires per-view membership counts, this surfaces as null.
//   lastUpdated : not part of the CrmList shape; surfaces as null.
//   memberType  : derived from CrmList.objectType ("contact" / "account").
//                 The legacy "mixed" branch is gone — Twenty Views are
//                 single-type. Downstream `mixed` consumers fall back to
//                 the "contact" branch (the picker's only callers today
//                 work with contact lists).

export type AvailableListSummary = {
  id: string;
  name: string;
  /** null when the CRM provider does not expose a materialized member count. */
  memberCount: number | null;
  /** null when the CRM provider does not expose a last-updated timestamp. */
  lastUpdated: string | null;
  memberType: "account" | "contact" | "mixed";
};

/**
 * Authorize the CALLER against the RUN whose step is being drawn, for the
 * `read` operation — the canonical run-access rule (`enforceRunAccess`), the
 * same one the run page itself is drawn behind.
 *
 * Why this replaced the platform-administrator gate (cinatra#3050): drawing a
 * step of a run is not a platform-administration act. The picker's loader used
 * to open with `requireAdminSession()`, which REDIRECTS a caller without the
 * `admin` role to `/not-authorized` — so the ordinary owner of a run was thrown
 * off their own run the moment it reached the step this renderer draws. The
 * run, not the platform role, is the authority.
 *
 * `readAgentRunById(id, actor, roles)` is the canonical read seam: it resolves
 * the run's effective policy and its co-owner list and hands them to
 * `enforceRunAccess(..., "read", roles)`. That yields exactly the refusal shape
 * the run page gives — AuthzError 404 "hidden" for a run the caller may not
 * know exists, AuthzError 403 "forbidden" for a policy denial — and never a
 * redirect to an administrator screen.
 *
 * A missing or non-string run identifier takes the SAME hidden-run refusal as
 * an unknown one (`enforceRunAccess(null, …)`), so a caller cannot tell a
 * malformed id from a foreign run, and no CRM capability is resolved on the way
 * out.
 *
 * The role hints mirror `requireHitlActor` (actions.ts): the kernel context
 * carries the org role, team memberships and project grants that let a
 * non-administrator member reach their own run, and `actorOrganizationId` is
 * the actor's ACTIVE org — never `run.orgId`, which would weaken the cross-org
 * guard.
 */
async function requireRunReadAccess(runId: unknown): Promise<void> {
  const session = await requireAuthSession();
  const kernel = await requireActorContext();
  const actor = actorFromSession(session);
  const roleHints: ActorRoleHints = {
    ...(kernel.platformRole ? { platformRole: kernel.platformRole } : {}),
    ...(kernel.orgRole ? { orgRole: kernel.orgRole } : {}),
    ...(kernel.teamRoles ? { teamRoles: kernel.teamRoles } : {}),
    ...(kernel.teamIds ? { teamIds: kernel.teamIds } : {}),
    ...(kernel.projectGrants ? { projectGrants: kernel.projectGrants } : {}),
    actorOrganizationId: kernel.organizationId ?? null,
  };

  if (typeof runId !== "string" || runId.trim() === "") {
    // Same hidden-run absence as an unknown id — no DB round-trip needed.
    await enforceRunAccess(null, actor, "read", roleHints);
    return;
  }

  await readAgentRunById(runId, actor, roleHints);
}

/** The class name of a thrown value (its `name`, set explicitly by the CRM
 *  error classes), never its message. */
function errorClassOf(err: unknown): string {
  if (err instanceof Error) return err.name || "Error";
  return typeof err;
}

/** ", code <n>" for an error that carries a numeric code (an HTTP status or a
 *  JSON-RPC code), else "". */
function errorCodeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" && Number.isFinite(code) ? `, code ${code}` : "";
}

/**
 * @param runId - the `agent_run` this step belongs to, threaded by the
 *   renderer from `context.runId` (the shared field-renderer contract).
 */
export async function fetchAvailableLists(
  runId: string,
): Promise<AvailableListSummary[]> {
  // Run-access gate FIRST — no CRM capability is resolved or called before it.
  await requireRunReadAccess(runId);

  // Capability absent (crm-connector not installed/active — it is
  // acquirable-on-demand, not required) degrades to "no lists available".
  // It is logged with fixed words, so a reading can tell an absent reader
  // from a CRM that holds no list (cinatra#4159).
  const reader = resolveCrmListReader();
  if (!reader) {
    console.warn("[list-picker] no crm-list-reader capability is registered; the picker offers no lists");
    return [];
  }

  let lists;
  try {
    // Picker shows contact-eligible lists. Twenty's `get_views` is
    // workspace-scoped; the crm-connector surface post-filters by objectType
    // when the per-type object-metadata cache has resolved (lazy-loaded by
    // the connector on first call).
    //
    // SCOPE IS UNCHANGED by the run-access gate (cinatra#3050): the call and
    // its arguments are byte-identical to what the administrator-gated loader
    // issued, so an admitted caller sees exactly the set an administrator saw
    // — no widening. The reader contract takes only `query` + `objectType`
    // (packages/sdk-extensions/src/crm-list-reader-contract.ts), so it carries
    // no actor; per-actor list scoping is a separate change.
    lists = await reader.searchLists({ query: "", objectType: "contact" });
  } catch (err) {
    // No CRM provider registered, no Twenty row yet, no bearer attached, or
    // upstream unreachable. A refused search is NOT an empty CRM (cinatra#4159):
    // it is logged with fixed words and rethrown, so the renderer shows its
    // "Could not load lists." toast instead of the empty state. SECRET
    // BOUNDARY: only the error's class name and numeric code are logged, never
    // its message or data, which may quote an upstream answer. The error the
    // browser receives carries fixed words too; the original stays as `cause`
    // on the server.
    console.warn(
      `[list-picker] the CRM list search failed (${errorClassOf(err)}${errorCodeOf(err)}); the picker shows the load error`,
    );
    throw new Error("the CRM list search failed", { cause: err });
  }

  return lists.map((l) => ({
    id: l.id,
    name: l.name,
    memberCount: null,
    lastUpdated: null,
    memberType: l.objectType,
  }));
}
