/**
 * Authorization kernel — actor context types.
 *
 * Pure types + a single runtime constant (POLICY_VERSION). No I/O, no
 * tier-restricting imports, no Better Auth imports. This module is the
 * single source of truth for ActorContext — auth-session.ts must NOT
 * re-export it.
 */

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
  authSource: "ui" | "worker" | "mcp" | "a2a" | "agent";
  runAsUserId?: string;
  delegatedBy?: string;
  tokenScopes?: string[];
  policyVersion: string;
};
