import "server-only";

// ---------------------------------------------------------------------------
// Per-CONNECTION use-gate (cinatra#952 W2).
//
// The package-level `enforceConnectorPolicy` (connector-policy.ts) STAYS and
// keeps guarding the connector PACKAGE. This gate decides whether an actor
// may USE one specific saved connection — the `nango_connection` identity row
// W1 introduced — under the polymorphic `connection` resource kind, honoring
// the connector's declared access ceiling (`cinatra/config.json`, read from
// the W1 registration CACHE, never the file).
//
// Decision pipeline (codex-converged design, lane-952 rounds 1-3):
//   1. OWN short-circuit on an explicit `subjectUserId` — the uniform
//      evaluator owner-matches HumanUser principals ONLY, so a worker/agent
//      principal acting for a human would never owner-match; the caller
//      resolves the subject from TRUSTED context (session / run binding),
//      never from request input.
//   2. mode:"default" (or NULL declaration cache): the uniform gate with an
//      EXPLICIT `fallbackPolicy` = the connection kind's OWNER_DEFAULT.
//      Without it, `resolveDecision`'s module default fallback is WORKSPACE
//      visibility — every backfilled/no-policy connection would be org-usable
//      by omission (auto-share). Regression-tested.
//   3. mode:"only": the declared scope is a CEILING on the STORED grant
//      material. The gate loads policy + co-owners + installer itself and
//      runs the PURE evaluator with clamped inputs so ALL grant material
//      passes through the ceiling: out-of-ceiling visibility evaluates as
//      "owner"; person-grants (co-owners / installer) are stripped where the
//      declaration's collective dimension cannot be verified for a person;
//      and the platform_admin kernel-parity bypass is neutralized unless the
//      ceiling itself is "admin" (a vendor-declared "only" ceiling means MAY
//      ONLY be used within this scope). The gate-level own short-circuit runs
//      first, so an owner (platform admin or not) is never locked out.
//   4. The decision is AUDITED before any throw — the DENY row is a DURABLE
//      write (strict, flood-controlled via the denied-cooldown) awaited
//      BEFORE the AuthzError; nothing can fetch after an un-audited deny.
//
// The gate NEVER touches credentials — it authorizes an identity row; the
// caller then uses the unchanged connection-addressed fetch primitives.
// ---------------------------------------------------------------------------

import { AuthzError } from "@/lib/authz";
import type { ActorContext } from "@/lib/authz";
import {
  logAuditEvent,
  logDeniedAuditEventStrictWithCooldown,
} from "@/lib/authz/audit";
import type { AgentAuthPolicy, AgentAuthPolicyVisibility } from "@cinatra-ai/agents/auth-policy";
import type { NangoConnectionIdentity } from "@cinatra-ai/extensions/connection-identity-store";
import {
  evaluateExtensionAccess,
  canExtensionAccess,
  type ExtensionAccessDecision,
  type ExtensionOwnerContext,
} from "@cinatra-ai/extensions/enforce-extension-access";
import { defaultAccessPolicyForKind } from "@cinatra-ai/extensions/install-access-contract";
import {
  readExtensionAccessPolicy,
  readExtensionCoOwners,
  readExtensionInstalledBy,
} from "@cinatra-ai/extensions/permissions-store";
import { readInstalledExtensionsByPackageName } from "@cinatra-ai/extensions/canonical-store";
import type { ResolvedConnectorAccessDeclaration } from "@cinatra-ai/sdk-extensions/access-config";
import { isResolvedConnectorAccessDeclaration } from "@cinatra-ai/sdk-extensions/access-config";

// ---------------------------------------------------------------------------
// Subject resolution (design §B2): agent runs resolve as their human subject.
// ---------------------------------------------------------------------------

/**
 * The human SUBJECT an actor acts for: the human principal itself, or the
 * `runAsUserId` binding of a worker/agent principal. Callers MUST derive the
 * actor from trusted context (session lineage / run binding) — never from
 * request input — for the own short-circuit to be sound.
 */
export function connectionSubjectUserId(actor: ActorContext): string | undefined {
  if (actor.principalType === "HumanUser") return actor.principalId;
  return actor.runAsUserId;
}

// ---------------------------------------------------------------------------
// Declaration resolution (W1 cache; never the file).
// ---------------------------------------------------------------------------

/** Sentinel `connector_package_id` for external-MCP identity rows — external
 * MCP servers are host rows, not marketplace connector packages, so they have
 * no canonical `installed_extension` row and NO access declaration (default
 * semantics; grants govern). */
export const EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL = "@cinatra-ai/host:external-mcp";

export type ConnectionDeclarationResolution =
  | { kind: "declaration"; declaration: ResolvedConnectorAccessDeclaration | null }
  | { kind: "package_unresolved" };

/**
 * Resolve the connector's access declaration from the W1 registration CACHE
 * (`installed_extension.access_declaration`). NULL cache = pre-reader row =
 * `default` semantics. A connector whose canonical package row cannot be
 * resolved at all yields `package_unresolved` — the gate fails CLOSED for
 * non-owner use (the row could carry an `only` ceiling we cannot read).
 */
export async function resolveConnectionAccessDeclaration(
  identity: NangoConnectionIdentity,
): Promise<ConnectionDeclarationResolution> {
  if (identity.connectorPackageId === EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL) {
    return { kind: "declaration", declaration: null };
  }
  const rows = await readInstalledExtensionsByPackageName(identity.connectorPackageId);
  if (rows.length === 0) return { kind: "package_unresolved" };
  const row =
    rows.find((r) => r.organizationId != null && r.organizationId === identity.organizationId) ??
    rows[0];
  const cached = row.accessDeclaration ?? null;
  if (cached !== null && !isResolvedConnectorAccessDeclaration(cached)) {
    // A corrupt cache must never silently resolve to default semantics.
    return { kind: "package_unresolved" };
  }
  return { kind: "declaration", declaration: cached };
}

// ---------------------------------------------------------------------------
// The `only` clamp (ceiling algorithm — design §B4 + convergence amendments
// 2 and 3).
// ---------------------------------------------------------------------------

type ClampedMaterial = "visibility" | "coOwner" | "installer" | "platformAdminBypass";

/** Is the STORED visibility token within the declared ceiling?
 *
 * EXPORTED (cinatra#953 W3): the write path (`saveExtensionAccessPolicy`'s
 * `connection` kind hook) rejects out-of-ceiling grants with the SAME rule the
 * read-side clamp applies — one source of truth for "within the `only`
 * ceiling" on both the read clamp and the write rejection. */
export function visibilityWithinCeiling(
  visibility: AgentAuthPolicyVisibility,
  scope: ResolvedConnectorAccessDeclaration["scope"],
  owningOrganizationId: string | null,
): boolean {
  if (visibility === "owner") return true; // owner is within every ceiling
  switch (scope) {
    case "user":
      return false;
    case "project":
      return typeof visibility === "string" && visibility.startsWith("project:");
    case "team":
      return typeof visibility === "string" && visibility.startsWith("team:");
    case "organization":
      if (visibility === "org") return true;
      return (
        typeof visibility === "string" &&
        visibility.startsWith("org:") &&
        owningOrganizationId != null &&
        visibility.slice("org:".length) === owningOrganizationId
      );
    case "workspace":
      return (
        visibility === "workspace" ||
        visibility === "org" ||
        (typeof visibility === "string" &&
          (visibility.startsWith("org:") ||
            visibility.startsWith("team:") ||
            visibility.startsWith("project:")))
      );
    case "admin":
      return visibility === "admin";
    default:
      return false; // unknown scope vocabulary — fail closed
  }
}

/** Do person-grants (co-owners / installer pointer) survive the ceiling?
 * Fail-closed where the declaration's collective dimension cannot be verified
 * for a bare person-grant (user/team/project); admitted where an explicit
 * same-org individual is strictly narrower than the declared scope
 * (organization/workspace); admin-ceiling admits only admin-strength actors. */
function personGrantsWithinCeiling(
  scope: ResolvedConnectorAccessDeclaration["scope"],
  actor: ActorContext,
  owner: ExtensionOwnerContext,
): boolean {
  switch (scope) {
    case "user":
    case "team":
    case "project":
      return false;
    case "organization":
    case "workspace":
      return true;
    case "admin":
      return (
        owner.organizationId != null &&
        actor.organizationId === owner.organizationId &&
        (actor.orgRole === "org_owner" || actor.orgRole === "org_admin")
      );
    default:
      return false;
  }
}

function clampVisibility(
  visibility: AgentAuthPolicyVisibility,
  scope: ResolvedConnectorAccessDeclaration["scope"],
  owningOrganizationId: string | null,
): AgentAuthPolicyVisibility {
  return visibilityWithinCeiling(visibility, scope, owningOrganizationId)
    ? visibility
    : "owner";
}

// ---------------------------------------------------------------------------
// Decision (no audit, no throw) — shared by the gate AND the resolver's
// candidate DISCOVERY so a candidate the gate would deny can never inflate
// the shared-candidate count into a spurious ambiguity hard-fail.
// ---------------------------------------------------------------------------

export type ConnectionUseDecision = ExtensionAccessDecision & {
  /** Grant material the `only` ceiling clamped when it changed the outcome. */
  clampApplied?: ClampedMaterial[];
  /** True when the actor was admitted as the connection's owner (subject match). */
  asOwner?: boolean;
};

export async function decideConnectionUse(input: {
  identity: NangoConnectionIdentity;
  actor: ActorContext | undefined | null;
  subjectUserId: string | undefined;
}): Promise<ConnectionUseDecision> {
  const { identity, actor, subjectUserId } = input;

  // 1. Gate-level OWN short-circuit (round-2 finding 1): the evaluator
  // owner-matches HumanUser principals only; the explicit subject covers
  // worker/agent principals acting for their human.
  if (subjectUserId != null && identity.ownerUserId === subjectUserId) {
    return { allowed: true, asOwner: true };
  }

  if (!actor) return { allowed: false, reason: "no_actor" };

  const owner: ExtensionOwnerContext = {
    ownerLevel: "user",
    ownerId: identity.ownerUserId,
    organizationId: identity.organizationId,
  };

  const resolution = await resolveConnectionAccessDeclaration(identity);
  if (resolution.kind === "package_unresolved") {
    // Cannot read the ceiling → owner-only for non-owner use (fail closed).
    return { allowed: false, reason: "not_visible", clampApplied: ["visibility"] };
  }
  const declaration = resolution.declaration;

  if (declaration === null || declaration.mode === "default") {
    // `default` only pre-selects at connect time — grants govern. The
    // EXPLICIT fallback is load-bearing: the module default is WORKSPACE.
    return canExtensionAccess(
      {
        kind: "connection",
        resourceId: identity.id,
        owner,
        fallbackPolicy: defaultAccessPolicyForKind("connection"),
      },
      actor,
      "use",
    );
  }

  // mode:"only" — clamped evaluation via the PURE evaluator so ALL grant
  // material (visibility AND person-grants AND the platform_admin bypass)
  // passes through the ceiling.
  const scope = declaration.scope;
  const [storedPolicy, coOwners, installedBy] = await Promise.all([
    readExtensionAccessPolicy("connection", identity.id),
    readExtensionCoOwners("connection", identity.id),
    readExtensionInstalledBy("connection", identity.id),
  ]);
  const basePolicy: AgentAuthPolicy =
    storedPolicy ?? defaultAccessPolicyForKind("connection");
  const coOwnerUserIds = coOwners.map((c) => c.userId);

  // TRANSITIONAL (multi-scope W1): fields are token arrays. The ceiling clamp
  // is applied to the FIRST token of each field, re-wrapped as a single-token
  // array; the per-token clamp (clamp every token, drop those outside the
  // ceiling) is the enforcement-lift issue (W2). Writers are single-token until
  // the multi-select picker (W3), so this matches the pre-array behavior.
  const clampedPolicy: AgentAuthPolicy = {
    ...basePolicy,
    runListVisibility: [clampVisibility(basePolicy.runListVisibility[0], scope, identity.organizationId)],
    runDataVisibility: [clampVisibility(basePolicy.runDataVisibility[0], scope, identity.organizationId)],
    runExecuteVisibility: [clampVisibility(basePolicy.runExecuteVisibility[0], scope, identity.organizationId)],
  };
  const personGrantsSurvive = personGrantsWithinCeiling(scope, actor, owner);
  const clampedCoOwners = personGrantsSurvive ? coOwnerUserIds : [];
  const clampedInstaller = personGrantsSurvive ? installedBy : null;
  // Amendment 3: the kernel-parity platform_admin bypass is neutralized
  // unless the ceiling itself admits admin-strength access.
  const stripPlatformAdmin = scope !== "admin" && actor.platformRole === "platform_admin";
  const actorForEval: ActorContext = stripPlatformAdmin
    ? { ...actor, platformRole: undefined }
    : actor;

  const clamped = evaluateExtensionAccess({
    kind: "connection",
    policy: clampedPolicy,
    coOwnerUserIds: clampedCoOwners,
    installedByUserId: clampedInstaller,
    owner,
    actor: actorForEval,
    op: "use",
  });
  if (clamped.allowed) return clamped;

  // Deny: report which clamped material WOULD have admitted the actor (pure
  // re-evaluation with the raw inputs — no extra I/O) for the actionable
  // error + audit metadata.
  const raw = evaluateExtensionAccess({
    kind: "connection",
    policy: basePolicy,
    coOwnerUserIds,
    installedByUserId: installedBy,
    owner,
    actor,
    op: "use",
  });
  if (!raw.allowed) return clamped; // denied either way — no clamp involved
  const clampApplied: ClampedMaterial[] = [];
  if (stripPlatformAdmin) clampApplied.push("platformAdminBypass");
  if (
    // Compare the clamped token (arrays are single-token in W1).
    basePolicy.runDataVisibility[0] !== clampedPolicy.runDataVisibility[0]
  ) {
    clampApplied.push("visibility");
  }
  if (!personGrantsSurvive && coOwnerUserIds.length > 0) clampApplied.push("coOwner");
  if (!personGrantsSurvive && installedBy != null) clampApplied.push("installer");
  return { ...clamped, clampApplied };
}

// ---------------------------------------------------------------------------
// Enforcing gate — decide, AUDIT (deny rows durable + awaited BEFORE the
// throw), then throw/return. ONE decision audit per resolution: the
// resolver's discovery uses decideConnectionUse directly (unaudited).
// ---------------------------------------------------------------------------

export class ConnectionUseDeniedError extends AuthzError {
  /**
   * Stable STRUCTURAL discriminator for cross-boundary classification
   * (#975 Wave 3 / epic #978): `AuthzError`'s constructor pins `name` to
   * "AuthzError", so a name-check cannot identify a deny, and extension code
   * (which cannot import this class) classifies via the
   * `@cinatra-ai/host:instance-connection-gate` service's
   * `isConnectionUseDenied` member — implemented as a marker-field check in
   * `@/lib/instance-connection-actor` (no load-order coupling). Keep this
   * field in sync with `isConnectionUseDeniedError` there.
   */
  readonly connectionUseDenied = true as const;
}

function auditActorPrincipalType(
  actor: ActorContext | undefined | null,
): "human" | "model" | "system" | undefined {
  if (!actor) return undefined;
  if (actor.principalType === "HumanUser") return "human";
  if (actor.principalType === "System" || actor.principalType === "InternalWorker") {
    return "system";
  }
  return "model";
}

function auditAuthSource(
  actor: ActorContext | undefined | null,
): "ui" | "worker" | "agent" | "a2a" | "mcp" | undefined {
  return actor?.authSource;
}

export async function enforceConnectionUse(input: {
  identity: NangoConnectionIdentity;
  actor: ActorContext | undefined | null;
  subjectUserId: string | undefined;
  runId?: string;
  /** Attribution tag for the audit row (e.g. "resolver", "github-api"). */
  source?: string;
}): Promise<ConnectionUseDecision> {
  const { identity, actor, subjectUserId, runId, source } = input;
  const decision = await decideConnectionUse({ identity, actor, subjectUserId });

  const delegatedBy =
    decision.allowed && !decision.asOwner ? identity.ownerUserId : undefined;
  const auditBase = {
    organizationId: identity.organizationId ?? undefined,
    actorPrincipalId: actor?.principalId,
    actorPrincipalType: auditActorPrincipalType(actor),
    authSource: auditAuthSource(actor),
    delegatedBy,
    impersonatedUserId:
      subjectUserId != null && subjectUserId !== actor?.principalId ? subjectUserId : undefined,
    resourceType: "connection",
    resourceId: identity.id,
    operation: "use",
    runId,
    metadata: {
      connectorKey: identity.connectorKey,
      ...(source ? { source } : {}),
      ...(decision.allowed === false && "clampApplied" in decision && decision.clampApplied
        ? { clampApplied: decision.clampApplied }
        : {}),
      ...(decision.allowed === false ? { reason: decision.reason } : {}),
    },
  };

  if (decision.allowed) {
    await logAuditEvent({ ...auditBase, decision: "allowed" });
    return decision;
  }

  // DENY is durable + flood-controlled and AWAITED before the throw — nothing
  // can fetch after a deny that wasn't audited first.
  await logDeniedAuditEventStrictWithCooldown(auditBase);

  if (decision.reason === "no_actor") {
    throw new ConnectionUseDeniedError({
      statusCode: 401,
      reason: "no_session",
      message: "Using a connection requires an authenticated actor.",
    });
  }
  if (decision.reason === "cross_org") {
    throw new ConnectionUseDeniedError({
      statusCode: 404,
      reason: "hidden",
      message: "Connection not found.",
    });
  }
  const clampNote =
    decision.clampApplied && decision.clampApplied.length > 0
      ? ` The connector's declared access ceiling clamped the stored grant (${decision.clampApplied.join(", ")}); ask the connection's owner to narrow the grant to the declared scope.`
      : "";
  throw new ConnectionUseDeniedError({
    statusCode: 403,
    reason: "forbidden",
    message: `You are not authorized to use this ${identity.connectorKey} connection.${clampNote}`,
  });
}
