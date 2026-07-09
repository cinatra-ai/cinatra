// ---------------------------------------------------------------------------
// Scope containment
//
// A run-time access policy must be a subset of the parent extension
// (agent_template) policy. This module owns the pure subset relation and
// the lookup-driven helpers that resolve team→org and project→org parentage.
//
// Subset rule for `AgentAuthPolicyVisibility` (v1):
//
//   owner            ⊆ ANY                     (narrowest)
//   team:X           ⊆ team:X                  (exact)
//   team:X           ⊆ org:A    iff team X belongs to org A  (lookup)
//   project:P        ⊆ project:P               (exact)
//   project:P        ⊆ org:A    iff project P belongs to org A (lookup)
//   org:A            ⊆ org:A                   (exact)
//   org:A            ⊆ workspace
//   workspace        ⊆ workspace               (widest)
//   admin            ⊆ admin                   (peer of org — cross-org)
//   admin            ⊆ workspace
//   legacy "org"     ⇒ resolve to org:<resourceOrgId> before applying rule
//
//   team:X and project:P are PEERS in v1 — neither contains the other.
//
// Defense-in-depth note: this module is referenced from
// `permissions-actions.ts` for the canonical write path. Direct store
// callers do not run this check; if a future caller bypasses the
// server-action layer, add a second call site at the store boundary.
// ---------------------------------------------------------------------------

import type { AgentAuthPolicy, AgentAuthPolicyVisibility } from "@cinatra-ai/agents/auth-policy";

/**
 * Lookup primitives that the subset rule depends on.
 *
 * Injected so the pure rule can be tested without DB access, and the
 * production caller can wire them to Better Auth + projects helpers.
 */
export interface ContainmentLookups {
  /** Returns the org id this team belongs to (Better Auth `team.organizationId`). */
  teamOrg(teamId: string): Promise<string | null>;
  /** Returns the org id this project belongs to (`cinatra.projects` joined to actor scope). */
  projectOrg(projectId: string): Promise<string | null>;
  /**
   * Returns the org id for the "legacy org" visibility — typically the
   * resource's own org (run.orgId or template.ownerOrgId). Returns null when
   * the resource has no resolved org, which forces the rule to reject any
   * scoped parent.
   */
  resolveLegacyOrg(): Promise<string | null>;
}

/**
 * Resolve a legacy `"org"` visibility (no id) to its `org:<id>` form, or
 * to a sentinel object that the rule can fail-closed against.
 */
async function resolveLegacyOrgVisibility(
  v: AgentAuthPolicyVisibility,
  lookups: ContainmentLookups,
): Promise<{ tag: "literal"; v: AgentAuthPolicyVisibility } | { tag: "unknown_org" }> {
  if (v === "org") {
    const id = await lookups.resolveLegacyOrg();
    if (id) return { tag: "literal", v: `org:${id}` };
    return { tag: "unknown_org" };
  }
  return { tag: "literal", v };
}

/**
 * Core subset predicate: is `child` ⊆ `parent`?
 *
 * Returns `true` iff every actor admitted by `child` is also admitted by
 * `parent`. Both sides may require lookups.
 *
 * `owner` is treated as the narrowest scope (always contained).
 */
export async function visibilityContainedBy(
  child: AgentAuthPolicyVisibility,
  parent: AgentAuthPolicyVisibility,
  lookups: ContainmentLookups,
): Promise<boolean> {
  // Narrow → anything.
  if (child === "owner") return true;

  // Resolve any legacy "org" on either side.
  const c = await resolveLegacyOrgVisibility(child, lookups);
  const p = await resolveLegacyOrgVisibility(parent, lookups);
  if (c.tag === "unknown_org" || p.tag === "unknown_org") {
    // Can't resolve a side → fail-closed (reject as "exceeds parent").
    return false;
  }
  const cv = c.v;
  const pv = p.v;

  // Widest target on the parent admits anything below workspace + owner +
  // admin (admin is treated as ⊆ workspace because workspace is the
  // deployment-instance level above org).
  if (pv === "workspace") {
    return cv === "workspace" || cv === "admin" ||
      cv.startsWith("org:") || cv.startsWith("team:") || cv.startsWith("project:");
  }

  // admin is cross-org. v1: only admin ⊆ admin (peer of org, not contained
  // by it).
  if (cv === "admin") {
    return pv === "admin";
  }
  if (pv === "admin") {
    // admin parent admits admin and owner only; both handled above.
    return false;
  }

  // Both literal "workspace" already handled — fall through to scoped tier.

  // org:X ⊆ org:X
  if (cv.startsWith("org:") && pv.startsWith("org:")) {
    return cv === pv;
  }

  // team:X ⊆ team:X OR (team:X ⊆ org:A iff team X is in org A)
  if (cv.startsWith("team:")) {
    if (cv === pv) return true;
    if (pv.startsWith("org:")) {
      const teamId = cv.slice("team:".length);
      const orgId = pv.slice("org:".length);
      const teamOrgId = await lookups.teamOrg(teamId);
      return teamOrgId === orgId;
    }
    return false;
  }

  // project:P ⊆ project:P OR (project:P ⊆ org:A iff project P is in org A)
  if (cv.startsWith("project:")) {
    if (cv === pv) return true;
    if (pv.startsWith("org:")) {
      const projectId = cv.slice("project:".length);
      const orgId = pv.slice("org:".length);
      const projectOrgId = await lookups.projectOrg(projectId);
      return projectOrgId === orgId;
    }
    return false;
  }

  // org:X under team or project parent — rejects (team/project are narrower
  // than org).
  if (cv.startsWith("org:")) {
    return false;
  }

  // workspace child only ⊆ workspace parent (already handled above).
  if (cv === "workspace") {
    return false;
  }

  // Exhaustive — unknown shape is fail-closed.
  return false;
}

/**
 * Subset predicate at the AgentAuthPolicy level. Returns `{ ok: true }` on
 * success or `{ ok: false, ... }` with the offending field on rejection.
 *
 * Checks:
 *   - All three visibility fields (runListVisibility, runDataVisibility,
 *     runExecuteVisibility) independently — each must be ⊆ parent's same field.
 *   - `allowRunSharing`: a child can disable sharing
 *     freely (true → false is fine), but can NOT enable sharing if the
 *     parent has it disabled (false → true is a widening). Encoded as
 *     `child.allowRunSharing ⇒ parent.allowRunSharing`.
 */
export async function policyContainedBy(
  child: AgentAuthPolicy,
  parent: AgentAuthPolicy,
  lookups: ContainmentLookups,
): Promise<
  | { ok: true }
  | { ok: false; field: "runListVisibility" | "runDataVisibility" | "runExecuteVisibility" | "allowRunSharing"; child: AgentAuthPolicyVisibility | boolean; parent: AgentAuthPolicyVisibility | boolean }
> {
  for (const field of ["runListVisibility", "runDataVisibility", "runExecuteVisibility"] as const) {
    // TRANSITIONAL (multi-scope W1): fields are token arrays. Containment is
    // checked on the FIRST token to preserve today's single-token subset
    // relation; the pointwise lift (every child token ⊆ SOME parent token) is
    // the enforcement-lift issue (W2). Writers are single-token until the
    // multi-select picker (W3), so `[0]` matches the pre-array behavior.
    const c = child[field][0];
    const p = parent[field][0];
    if (!(await visibilityContainedBy(c, p, lookups))) {
      return { ok: false, field, child: c, parent: p };
    }
  }
  if (child.allowRunSharing && !parent.allowRunSharing) {
    return {
      ok: false,
      field: "allowRunSharing",
      child: child.allowRunSharing,
      parent: parent.allowRunSharing,
    };
  }
  return { ok: true };
}
