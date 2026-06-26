/**
 * `buildActorContextFromPrimitive` translates the MCP envelope's
 * `PrimitiveActorContext` into the authz kernel's `ActorContext`.
 *
 * Keeping this bridge in `src/lib/authz/` lets generic resource-access
 * enforcement for objects and projects build kernel actors without depending
 * on the agent-builder package.
 *
 * Do not add `import "server-only"` here. Only `enforce.ts` carries the
 * server-only guard inside `src/lib/authz/`.
 *
 * The agent-builder `auth-policy.ts` re-exports this symbol to preserve
 * compatibility for existing call sites.
 */

import {
  POLICY_VERSION,
  type ActorContext,
  type ProjectGrant,
} from "./actor-context";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

/**
 * Canonical helper for translating a Better Auth session into a
 * `PrimitiveActorContext` envelope used by `enforceResourceAccess` and
 * `assertScopeRatchet` call sites under `src/app/projects/`.
 *
 * Better Auth's admin plugin encodes the platform-admin tier as the literal
 * `"admin"` on `session.user.role`, but the kernel's `deriveRoleHints` only
 * matches `"platform_admin"`. Translate at the bridge so admin status survives
 * the kernel boundary.
 */
type SessionShape = {
  user: { id: string; role?: string | null } & Record<string, unknown>;
  session?: { activeOrganizationId?: string | null } & Record<string, unknown>;
};

export type ActorFromSession = PrimitiveActorContext & {
  organizationId?: string | null;
  roles?: string[];
};

export function actorFromSession(session: SessionShape): ActorFromSession {
  const userId = session.user.id;
  const orgId =
    (session.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;
  const role = (session.user as { role?: string | null }).role ?? null;
  const roles: string[] = [];
  if (role) {
    for (const r of String(role).split(",").map((s) => s.trim()).filter(Boolean)) {
      // Better Auth's `"admin"` literal becomes `"platform_admin"` so
      // `deriveRoleHints` recognises the platform tier. Org-membership
      // admin is sourced from the member-role lookup, not from
      // `user.role`.
      roles.push(r === "admin" ? "platform_admin" : r);
    }
  }
  return {
    actorType: "human",
    source: "ui",
    userId,
    organizationId: orgId,
    roles,
  } satisfies ActorFromSession;
}

/**
 * Optional resolved-role data that callers may forward into the actor
 * context. Without this, the bridge has no role information (the
 * MCP envelope only carries `userId` and `source`) and admin users
 * silently lose admin status the moment their actor crosses into the
 * kernel — the kernel can only grant `platform_admin` when
 * `actor.platformRole === "platform_admin"`.
 *
 * Defined next to its only producer and re-exported by the agent-builder
 * `auth-policy.ts` for compatibility.
 */
export type ActorRoleHints = {
  platformRole?: "platform_admin" | "member";
  orgRole?: "org_owner" | "org_admin" | "member";
  teamRoles?: Record<string, "team_admin" | "member">;
  actorOrganizationId?: string | null;
  teamIds?: string[];
  // `projectGrants` is the canonical axis, resolved by
  // `readProjectGrantsForUser` as owned plus accessed projects with
  // role-by-authority and active-org anchoring. When supplied, `projectIds`
  // is derived (`projectGrants.map(g => g.projectId)`, sorted) and the legacy
  // `roles.projectIds` field is ignored. Callers that only supply
  // `projectIds` keep working: those contexts get `projectGrants: []`
  // (resolved-empty) and the legacy `projectIds` flows through unchanged.
  projectIds?: string[];
  projectGrants?: ProjectGrant[];
};

/**
 * Extension fields exposed on top of the kernel `ActorContext`. The `roles`
 * field is the raw role list parsed from the actor envelope (Better Auth
 * comma-string OR string[]); it is informational and does not participate in
 * `can()` decisions — those still consult `platformRole`, `orgRole`, and
 * `teamRoles`.
 *
 * Carried so callers such as audit logging, debugging, and
 * `enforceResourceAccess` can introspect what the actor originally claimed.
 */
export type RelocatedActorContext = ActorContext & {
  roles?: string[];
};

function parseActorRoles(rawRoles: unknown): string[] | undefined {
  if (rawRoles == null) return undefined;
  if (Array.isArray(rawRoles)) {
    return rawRoles
      .filter((r): r is string => typeof r === "string")
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
  }
  if (typeof rawRoles === "string") {
    const parsed = rawRoles
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
    return parsed.length > 0 ? parsed : undefined;
  }
  return undefined;
}

/**
 * Translate the MCP envelope's actor descriptor into the kernel's ActorContext.
 *
 * Preserves the agent-builder bridge behavior and attaches an informational
 * `roles` field parsed from `actor.roles` when present. The kernel ignores
 * `roles` for authorization decisions.
 */
export function buildActorContextFromPrimitive(
  actor: PrimitiveActorContext,
  runOrgId?: string | null,
  roles?: ActorRoleHints,
): RelocatedActorContext {
  const principalId =
    actor.userId ?? actor.jobId ?? actor.requestId ?? "system";
  const organizationId =
    roles?.actorOrganizationId !== undefined
      ? roles.actorOrganizationId ?? undefined
      : runOrgId ?? undefined;
  const authSource = mapAuthSource(actor);
  const platformRole = roles?.platformRole;
  const orgRole = roles?.orgRole;
  const teamRoles = roles?.teamRoles;
  // A2A carrier round-trip. When the primitive actor is the trusted A2A
  // carrier shape set by `mcpRequestContextStorage` in
  // `packages/agents/src/mcp/registry.ts`, and `roles` was not resolved at
  // the handler boundary (the common A2A case with no Better Auth session),
  // the carrier-forwarded teamIds/projectGrants would be dropped without this
  // fallback. Gated on actorType === "a2a" so arbitrary primitive input is
  // never treated as trusted authorization state.
  const a2aCarrier =
    actor.actorType === "a2a"
      ? (actor as unknown as {
          teamIds?: string[];
          projectIds?: string[];
          projectGrants?: Array<{
            projectId: string;
            effectiveRole: "read" | "write" | "admin" | "owner";
            accessSource: "owner" | "user" | "team" | "organization" | "workspace";
          }>;
        })
      : undefined;
  const teamIds = roles?.teamIds ?? a2aCarrier?.teamIds;
  // When `projectGrants` is supplied via the canonical path, set both
  // `projectGrants` and a derived `projectIds` (single derivation; sorted;
  // never set independently). Default `[]` for resolved human contexts that
  // have no grants. When `projectGrants` is undefined but legacy `projectIds`
  // is present, keep the legacy `projectIds` unchanged and set
  // `projectGrants` to `undefined` ("not resolved"); `[]` would incorrectly
  // report an explicit empty resolution.
  const projectGrants = roles?.projectGrants ?? a2aCarrier?.projectGrants;
  const projectIds =
    projectGrants !== undefined
      ? projectGrants
          .map((g) => g.projectId)
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      : roles?.projectIds ?? a2aCarrier?.projectIds;

  // Informational `roles` passthrough. Parses comma-separated strings
  // (Better Auth admin plugin encoding) and string arrays alike.
  const rawRoles = (actor as unknown as { roles?: unknown }).roles;
  const parsedRoles = parseActorRoles(rawRoles);

  const base = {
    principalId,
    organizationId,
    teamIds,
    projectIds,
    // Only carry `projectGrants` when defined to preserve the kernel's
    // "undefined means not resolved" contract. Spread-undefined would set
    // the key and blur resolved-vs-unresolved state.
    ...(projectGrants !== undefined ? { projectGrants } : {}),
    platformRole,
    orgRole,
    teamRoles,
    authSource,
    tokenScopes: actor.tokenScopes,
    policyVersion: POLICY_VERSION,
    ...(parsedRoles ? { roles: parsedRoles } : {}),
  } as const;

  switch (actor.actorType) {
    case "human":
      return { principalType: "HumanUser", ...base };
    case "model":
      return { principalType: "ServiceAccount", ...base };
    case "a2a":
      return { principalType: "ExternalA2AAgent", ...base };
    case "system":
    default:
      return { principalType: "InternalWorker", ...base };
  }
}

/**
 * Narrow adapter: verified A2A/MCP `ActorContext` (from `verifyA2AAccessToken`)
 * -> `PrimitiveActorContext`, PRESERVING the verified principal classification
 * (codex seed-caution #3).
 *
 * `buildActorContextFromPrimitive` maps `actorType:"a2a" -> ExternalA2AAgent`
 * and `actorType:"model" -> ServiceAccount`. A verified service-account JWT is a
 * `ServiceAccount`; flattening it through a bare `actorType:"a2a"` primitive
 * would silently reclassify it to `ExternalA2AAgent`. Today both roles carry the
 * identical least-privilege grant set ({agent.execute, run.read}), so the
 * reclassification is benign — but to prevent future grant divergence we map the
 * verified `principalType` to the `actorType` that round-trips back to the SAME
 * kernel principal:
 *   ServiceAccount    -> "model"  (round-trips to ServiceAccount)
 *   ExternalA2AAgent  -> "a2a"    (round-trips to ExternalA2AAgent)
 * `userId` is set from the verified `principalId` (the service_accounts row PK
 * for a ServiceAccount — an id space disjoint from human `runBy`, so it cannot
 * collide with / impersonate a run owner). `tokenScopes` and `orgId` are
 * carried so the enforceRunAccess scope-ceiling + cross-org guard stay
 * load-bearing.
 */
export function primitiveActorFromVerifiedA2A(
  verified: ActorContext,
): PrimitiveActorContext {
  const actorType: PrimitiveActorContext["actorType"] =
    verified.principalType === "ServiceAccount" ? "model" : "a2a";
  return {
    actorType,
    source: "a2a",
    userId: verified.principalId,
    orgId: verified.organizationId ?? null,
    tokenScopes: verified.tokenScopes,
  };
}

function mapAuthSource(actor: PrimitiveActorContext): ActorContext["authSource"] {
  if (actor.actorType === "a2a") return "a2a";
  if (actor.actorType === "model") return "mcp";
  switch (actor.source) {
    case "ui":
      return "ui";
    case "route":
      return "ui";
    case "worker":
      return "worker";
    case "scheduler":
      return "worker";
    case "agent":
      return "agent";
    case "a2a":
      return "a2a";
    case "mcp":
      return "mcp";
    default: {
      // The actor.source field is permissive at the type boundary; legacy
      // call sites occasionally synthesize one without a matching literal.
      // Fail closed by mapping unknown sources to "ui" (interactive tier).
      return "ui";
    }
  }
}
