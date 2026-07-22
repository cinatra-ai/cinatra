/**
 * Authorization kernel — actor context types.
 *
 * Pure types + a single runtime constant (POLICY_VERSION). No I/O, no
 * tier-restricting imports, no Better Auth imports. This module is the
 * single source of truth for ActorContext — auth-session.ts must NOT
 * re-export it.
 */

// Type-only import from the PURE `obo-ceiling` subpath (no react/better-auth
// runtime) — keeps this pure-types kernel free of tier-restricting runtime deps.
import type { OboCeilingChain } from "@cinatra-ai/mcp-server/obo-ceiling";

/**
 * Stamped on every ActorContext and AuditEvent so post-incident review
 * can correlate decisions to the policy table that produced them.
 */
export const POLICY_VERSION = "v2";

export type PrincipalType =
  | "HumanUser"
  | "ServiceAccount"
  | "ExternalA2AAgent"
  | "InternalWorker"
  | "System";

/**
 * Project-grant axis.
 *
 * `ProjectRole` is the effective role a principal holds ON a project,
 * computed by the canonical resolver `readProjectGrantsForUser` as
 * `owned ∪ accessed` with role-BY-AUTHORITY (never a blanket "owner").
 *
 * `ProjectAccessSource` is a SOURCE label only — it records WHERE the grant
 * came from (implicit owner / project_access principal level / co-owner).
 * This is NEVER an `OwnerLevel`: a project is a nullable resource
 * refinement, never a 5th ownership tier. The kernel/enforce path still
 * sees exactly 4 ownership tiers.
 */
export type ProjectRole = "read" | "write" | "admin" | "owner";
export type ProjectAccessSource =
  | "owner"
  | "user"
  | "team"
  | "organization"
  | "workspace";
export type ProjectGrant = {
  projectId: string;
  effectiveRole: ProjectRole;
  accessSource: ProjectAccessSource;
};

/**
 * Discriminated union — narrow on `principalType` to access type-specific
 * fields without casts.
 */
export type Principal =
  | { principalType: "HumanUser"; principalId: string }
  | { principalType: "ServiceAccount"; principalId: string; ownerOrgId?: string }
  | { principalType: "ExternalA2AAgent"; principalId: string; agentId?: string }
  | { principalType: "InternalWorker"; principalId: string }
  | { principalType: "System"; principalId: string };

/**
 * ActorContext is JSON-serializable and BullMQ-payload-safe (no Set/Map/Date).
 * All fields except principalType, principalId, authSource, and policyVersion
 * are optional.
 */
export type ActorContext = Principal & {
  organizationId?: string;
  teamIds?: string[];
  // Canonical project-grant axis. Resolved by `readProjectGrantsForUser`:
  // owned ∪ accessed with role-by-authority, active-org-anchored access,
  // max-not-last-wins merge.
  //
  // `undefined` means "NOT resolved" for sync `buildActorContext` callers
  // that never needed project visibility. `[]` means "resolved, none".
  // Every resolved human context sets at least `[]`. The async session-lineage
  // resolvers plus MCP/A2A lineage are the only producers that resolve and set
  // this.
  projectGrants?: ProjectGrant[];
  // Projects axis. DERIVED from `projectGrants` (single derivation:
  // `projectGrants.map(g => g.projectId)`, sorted). NEVER set independently
  // of `projectGrants` in resolved code. The legacy binary membership
  // predicates (auth-policy.ts:198 / :490-491, requireResourceAccess project
  // branch) still consult this shortcut, so it is kept in lockstep:
  // `projectIds` is defined iff `projectGrants` is defined.
  projectIds?: string[];
  platformRole?: "platform_admin" | "member";
  orgRole?: "org_owner" | "org_admin" | "member";
  teamRoles?: Record<string, "team_admin" | "member">;
  /**
   * Internal-read authority (D3 follow-up, cinatra#1948 (b)). When `true`, the
   * kernel grants the READ-ONLY `internal_reader` role WITHIN the actor's own
   * org (`resolveRoles`) — a first-class, explicitly-scoped, auditable read for
   * TRUSTED internal routing resolves (e.g. the email send-routing resolver
   * reaching the org-visible default sender-identity) instead of constructing a
   * per-call member/user actor.
   *
   * Trust boundary: this is a TRUSTED field, set ONLY by server-only internal
   * call sites that own a legitimate internal read (see
   * src/lib/register-email-providers.ts). It is NOT derived from any client /
   * MCP tool input, and `resolveRoles` admits `internal_reader` ONLY from this
   * dedicated field — never from the loose `roles[]` string bag — so it cannot
   * be forged by injecting a role string. Strictly narrower than `member`.
   */
  internalRead?: boolean;
  authSource: "ui" | "worker" | "mcp" | "a2a" | "agent";
  runAsUserId?: string;
  delegatedBy?: string;
  tokenScopes?: string[];
  /**
   * Agent-run OBO scope-ceiling CHAIN — the agent's anchored-scope upper bound
   * (`invoker authority ∩ agent anchor`). Set ONLY for agent-run-OBO delegated
   * actors (carried from the signed token / the mint path); undefined for every
   * other actor. JSON-serializable (BullMQ-payload-safe). Carrier field: no
   * enforcement path consults it yet.
   */
  oboCeiling?: OboCeilingChain;
  /**
   * Trusted dependent install id — the `installed_extension` row id the run this
   * actor was built from executes AS (cinatra#1392 Gap 2). Carried from the run
   * row by `buildActorContextFromRun` so the A2A dispatch seam resolves
   * edge-bound serving against a TRUSTED dependent identity (never a
   * client-supplied one). Undefined for actors not built from a run row that
   * carries it (service-account / interactive / worker paths). JSON-serializable
   * (BullMQ-payload-safe).
   */
  dependentInstallId?: string;
  policyVersion: string;
};

/**
 * Scoped-A2A-token actor invariant (fail-closed scope enforcement).
 *
 * The ONLY producer of an `authSource:"a2a"` `ServiceAccount` is
 * `buildActorContextFromServiceAccountJwt`. That actor MUST carry a concrete
 * `tokenScopes: string[]` (empty ⇒ deny-all in `enforceRunAccess`) — never
 * `undefined`, which `enforceRunAccess` treats as "no token-scope ceiling" and
 * would let an A2A token with an absent / non-intersecting scope claim escape
 * its ceiling. This regression-guard type forbids the `undefined` shape at
 * compile time; the canonical producer's return is asserted against it.
 *
 * NOTE: this is intentionally NARROW — it does NOT constrain the internal
 * `model→ServiceAccount` MCP/agent path (authSource "mcp"/"agent"), which is an
 * internal trusted invocation with no token-scope ceiling and legitimately
 * carries `tokenScopes: undefined`.
 */
export type ScopedA2AServiceAccountContext = ActorContext & {
  principalType: "ServiceAccount";
  authSource: "a2a";
  tokenScopes: string[];
};
