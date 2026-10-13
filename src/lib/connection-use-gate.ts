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
import type {
  AgentAuthPolicy,
  AgentAuthPolicyVisibility,
  AgentAuthPolicyVisibilitySelection,
} from "@cinatra-ai/agents/auth-policy";
import type { SavedNangoConnection } from "@/lib/nango-system";
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
import { getConnectorDescriptorBySlug } from "@cinatra-ai/connectors-catalog/descriptors.mjs";
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

/**
 * The catalog SLUG of the connector whose own Setup tab registers external MCP
 * servers ("MCP Servers"). Host vocabulary only — the package id is DERIVED
 * through the single sanctioned connector-catalog registry, the same true-IoC
 * road `connection-identity-seam`'s key→slug map takes (no extension-package
 * literal may live in a core file).
 */
const EXTERNAL_MCP_SETUP_CONNECTOR_SLUG = "mcp-server-connector";

/**
 * The connector PAGE that lists a saved connection (cinatra#3374) — the ONE
 * named mapping between a stored identity row's `connector_package_id` and the
 * package id of the setup page whose Sharing tab lists it (and whose access
 * declaration governs it there).
 *
 * Every row maps to its own package, with ONE exception. A server registered
 * on the MCP Servers connector's OWN Setup tab writes an identity row homed to
 * the sentinel above (external MCP servers are host rows, not marketplace
 * packages), yet §II of the ratified drawing says the Sharing tab "lists your
 * own saved connections for this connector" — and that form IS that
 * connector's, so the row is one of its saved connections. The function is
 * TOTAL and single-valued, so a sentinel-homed row resolves to exactly one
 * page and can never surface on a second connector's tab.
 *
 * READ-SIDE ONLY: the stored row is never rewritten, and the use-gate keeps
 * resolving the sentinel by its own documented semantics (no second sentinel).
 * An unresolvable catalog slug returns the sentinel unchanged — fail-closed,
 * i.e. listed nowhere, exactly as before this mapping.
 */
export function connectionSharingPagePackageId(
  identity: Pick<NangoConnectionIdentity, "connectorPackageId">,
): string {
  if (identity.connectorPackageId !== EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL) {
    return identity.connectorPackageId;
  }
  return (
    getConnectorDescriptorBySlug(EXTERNAL_MCP_SETUP_CONNECTOR_SLUG)?.packageId ??
    EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL
  );
}

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
  options?: {
    /**
     * Resolve the declaration of THIS package instead of the row's own home
     * package. The one caller is the Sharing tab's read (cinatra#3374), which
     * passes the page's package id: the declaration that governs a panel is
     * the declaration of the connector whose page draws it. Omitted
     * everywhere else — the use-gate resolves the row's own home package
     * exactly as before.
     */
    packageId?: string;
  },
): Promise<ConnectionDeclarationResolution> {
  const packageId = options?.packageId ?? identity.connectorPackageId;
  if (packageId === EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL) {
    return { kind: "declaration", declaration: null };
  }
  const rows = await readInstalledExtensionsByPackageName(packageId);
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

/**
 * Clamp a visibility SELECTION to the declared ceiling (multi-scope W2).
 * Filters out every token outside the ceiling; an empty result falls back to
 * the scalar clamp target `["owner"]` (fail-closed — owner is within every
 * ceiling). A single-token selection reduces exactly to the pre-array
 * `[clampVisibility(field[0])]`: an in-ceiling token stays, an out-of-ceiling
 * token collapses to `["owner"]`.
 */
function clampVisibilitySelection(
  selection: AgentAuthPolicyVisibilitySelection,
  scope: ResolvedConnectorAccessDeclaration["scope"],
  owningOrganizationId: string | null,
): AgentAuthPolicyVisibilitySelection {
  const kept = selection.filter((v) =>
    visibilityWithinCeiling(v, scope, owningOrganizationId),
  );
  return kept.length > 0
    ? (kept as AgentAuthPolicyVisibilitySelection)
    : ["owner"];
}

/** Content-equality of two visibility selections (order-preserving). */
function sameSelection(
  a: readonly AgentAuthPolicyVisibility[],
  b: readonly AgentAuthPolicyVisibility[],
): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
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

  // Multi-scope W2: fields are NON-EMPTY token arrays. The ceiling clamp is
  // PER-TOKEN — every token outside the ceiling is dropped; a field left empty
  // falls back to `["owner"]` (fail-closed). A single-token field reduces to
  // the pre-array `[clampVisibility(field[0])]`.
  const clampedPolicy: AgentAuthPolicy = {
    ...basePolicy,
    runListVisibility: clampVisibilitySelection(basePolicy.runListVisibility, scope, identity.organizationId),
    runDataVisibility: clampVisibilitySelection(basePolicy.runDataVisibility, scope, identity.organizationId),
    runExecuteVisibility: clampVisibilitySelection(basePolicy.runExecuteVisibility, scope, identity.organizationId),
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
    // The "use" op reads runDataVisibility; flag "visibility" when the
    // per-token clamp changed that selection (dropped a token or collapsed the
    // field to the ["owner"] fail-closed fallback).
    !sameSelection(basePolicy.runDataVisibility, clampedPolicy.runDataVisibility)
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

// Shared run-start presence and legacy-resolver identity/audit contracts.
export class AmbiguousSharedConnectionError extends AuthzError {}

export async function auditSentinelDeny(input: {
  connectorKey: string;
  actor: ActorContext;
  subjectUserId: string | undefined;
  runId?: string;
  reason: "no_candidate" | "ambiguous_shared_candidates";
  candidateCount?: number;
}): Promise<void> {
  const { connectorKey, actor, subjectUserId, runId, reason, candidateCount } = input;
  await logDeniedAuditEventStrictWithCooldown({
    organizationId: actor.organizationId,
    actorPrincipalId: actor.principalId,
    actorPrincipalType: actor.principalType === "HumanUser" ? "human" : "system",
    authSource: actor.authSource,
    impersonatedUserId:
      subjectUserId != null && subjectUserId !== actor.principalId ? subjectUserId : undefined,
    resourceType: "connection",
    resourceId: `connector:${connectorKey}`,
    operation: "use",
    runId,
    metadata: {
      connectorKey,
      reason,
      ...(candidateCount != null ? { candidateCount } : {}),
    },
  });
}

/** Unavailable evidence is not a confirmed missing connector. It carries no
 * upstream message, response, configuration value or connection id. */
export class ConnectionAvailabilityUnknownError extends Error {
  override readonly name = "ConnectionAvailabilityUnknownError";
  constructor() { super("Connection availability could not be confirmed. Try again later."); }
}

/** Required start predicate, separate from token fetching. Caller has already
 * authorized the connector PACKAGE. Discovery uses trusted human/runAs and the
 * existing grant/ceiling predicate, before any provider metadata query. */
export async function hasRequiredConnectorConnectionForUse(input: {packageId:string;actor:ActorContext}): Promise<boolean> {
  const { actor } = input;
  const subjectUserId = connectionSubjectUserId(actor);
  const missing = async () => { await auditSentinelDeny({connectorKey:input.packageId,actor,subjectUserId,reason:"no_candidate"}); return false; };
  try {
    const catalog = await import("@cinatra-ai/connectors-catalog/descriptors.mjs");
    let descriptor = catalog.getConnectorDescriptorByPackageId(input.packageId);
    const visited = new Set<string>();
    while (descriptor?.consumesConnectionFrom) {
      if (visited.has(descriptor.slug)) throw new ConnectionAvailabilityUnknownError();
      visited.add(descriptor.slug);
      descriptor = catalog.getConnectorDescriptorBySlug(descriptor.consumesConnectionFrom);
      if (!descriptor) throw new ConnectionAvailabilityUnknownError();
    }
    // A Google OAuth client configured for the application is the owner's
    // configuration-only representation. It is NOT a Gmail/Calendar account.
    if (descriptor?.connectionConfigurationOnly) {
      const ownerPackageId = descriptor.packageId;
      let state: "present" | "absent";
      try {
        const { resolveCapabilityProviders } = await import("@/lib/extension-capabilities-registry");
        const owners = resolveCapabilityProviders("connection-configuration-presence")
          .filter(provider => provider.packageName === ownerPackageId);
        if (owners.length !== 1) throw new ConnectionAvailabilityUnknownError();
        const impl = owners[0].impl;
        if (!impl || typeof impl !== "object" ||
            typeof (impl as { readPresence?: unknown }).readPresence !== "function") {
          throw new ConnectionAvailabilityUnknownError();
        }
        // Resolve the live owning reader on each call. Never import its vendor
        // implementation or treat an unwired/invalid provider as a known miss.
        const result: unknown = await (impl as { readPresence(): Promise<unknown> }).readPresence();
        if (!result || typeof result !== "object" || Array.isArray(result)) {
          throw new ConnectionAvailabilityUnknownError();
        }
        const keys = Reflect.ownKeys(result);
        if (keys.length !== 1 || keys[0] !== "state") {
          throw new ConnectionAvailabilityUnknownError();
        }
        const observed = (result as { state: unknown }).state;
        if (observed !== "present" && observed !== "absent") {
          throw new ConnectionAvailabilityUnknownError();
        }
        state = observed;
      } catch {
        // A provider may throw credential-bearing or authorization errors. Its
        // unavailable evidence is UNKNOWN, never an echoed error or absence.
        throw new ConnectionAvailabilityUnknownError();
      }
      return state === "present" ? true : await missing();
    }
    const packageId = descriptor?.packageId ?? input.packageId;
    const aliases = new Set(catalog.connectorKeysForPackageId(packageId));
    const { listNangoConnectionsForScopeFilter } = await import("@cinatra-ai/extensions/connection-identity-store");
    const discovered = await listNangoConnectionsForScopeFilter(actor.organizationId ?? null,subjectUserId ?? "");
    const candidates = [...new Map(discovered.filter(row => !row.deletedAt && (row.connectorPackageId === packageId || aliases.has(row.connectorKey))).map(row => [row.id,row])).values()];
    const authorized: NangoConnectionIdentity[] = [];
    for (const row of candidates) {
      // Row grants, org and only:user ceilings remain load-bearing for admins.
      const decision = await decideConnectionUse({identity:row,actor,subjectUserId});
      if (decision.allowed) authorized.push(row);
    }
    if (!authorized.length) return await missing();
    const authorizedOwn = authorized.filter(row => subjectUserId && row.ownerUserId === subjectUserId);
    const authorizedShared = authorized.filter(row => row.ownerUserId !== subjectUserId && row.organizationId != null && row.organizationId === actor.organizationId);
    // Match canonical resolution BEFORE provider presence can prune an
    // ambiguous grant set into an apparent single usable connection.
    if (!authorizedOwn.length && authorizedShared.length > 1) {
      await auditSentinelDeny({connectorKey:packageId,actor,subjectUserId,reason:"ambiguous_shared_candidates",candidateCount:authorizedShared.length});
      throw new AmbiguousSharedConnectionError({statusCode:403,reason:"forbidden",message:"More than one shared connection is available. Ask its owners to narrow the grants."});
    }
    let ownPrimary = authorizedOwn[0];
    const existing: NangoConnectionIdentity[] = [];
    const external = authorized.filter(row => row.connectorKey === "externalMcp");
    if (external.length) {
      const { listExternalMcpServersForPreflight, externalMcpKeylessConnectionId } = await import("@/lib/external-mcp-registry");
      const rows = await listExternalMcpServersForPreflight();
      for (const identity of external) {
        const row = rows.find(r => r.enabled && typeof r.serverUrl === "string" && r.serverUrl.trim() && (r.nangoConnectionId || externalMcpKeylessConnectionId(r.id)) === identity.connectionId);
        if (!row || (row.orgId && row.orgId !== actor.organizationId) || (row.scope === "user" && row.userId !== subjectUserId)) continue;
        // A keyless server has a real derived identity, not a fake vault entry.
        // Keyed rows use their saved address; no account credential is fetched.
        existing.push(identity);
      }
    }
    const accountRows = authorized.filter(row => row.connectorKey !== "externalMcp");
    if (accountRows.length) {
      const { readConnectorConfigurationForPreflight } = await import("@/lib/database-metadata");
      const { getNangoSystem,listNangoConnectionAddressesForPreflight } = await import("@/lib/nango-system");
      const store = await readConnectorConfigurationForPreflight("nango_connections");
      const records = store?.connections;
      if (records !== undefined && (!records || typeof records !== "object" || Array.isArray(records))) throw new ConnectionAvailabilityUnknownError();
      if (ownPrimary && authorizedOwn.length > 1) {
        const primaryOrder = (records as Record<string,unknown> | undefined)?.[ownPrimary.connectorKey];
        if (Array.isArray(primaryOrder)) {
          const first = (primaryOrder as SavedNangoConnection[]).find(record => authorizedOwn.some(row => row.connectorKey === ownPrimary.connectorKey && row.connectionId === record.connectionId));
          if (first) ownPrimary = authorizedOwn.find(row => row.connectorKey === ownPrimary.connectorKey && row.connectionId === first.connectionId) ?? ownPrimary;
        }
      }
      const surface = getNangoSystem();
      if (!surface) throw new ConnectionAvailabilityUnknownError();
      const addresses = accountRows.flatMap(identity => {
        const entries = (records as Record<string,unknown> | undefined)?.[identity.connectorKey];
        if (entries !== undefined && !Array.isArray(entries)) throw new ConnectionAvailabilityUnknownError();
        const record = (entries as SavedNangoConnection[] | undefined)?.find(r => r.connectionId === identity.connectionId);
        const providerConfigKey = record?.providerConfigKey || surface.providerConfigKeys[identity.connectorKey];
        return record && providerConfigKey ? [{identity,providerConfigKey,connectionId:identity.connectionId}] : [];
      });
      if (addresses.length) {
        const presence = await listNangoConnectionAddressesForPreflight({providerConfigKeys:[...new Set(addresses.map(r=>r.providerConfigKey))],connectionIds:[...new Set(addresses.map(r=>r.connectionId))]});
        if (presence.state === "unknown") throw new ConnectionAvailabilityUnknownError();
        for (const address of addresses) if (presence.addresses.some(r=>r.providerConfigKey===address.providerConfigKey && r.connectionId===address.connectionId)) existing.push(address.identity);
      }
    }
    const selected = ownPrimary ?? authorizedShared[0];
    if (selected && !existing.some(row => row.id === selected.id)) return await missing();
    if (!selected) return await missing();
    await enforceConnectionUse({identity:selected,actor,subjectUserId,source:"required-run-start"});
    return true;
  } catch (error) {
    if (error instanceof AuthzError || error instanceof ConnectionAvailabilityUnknownError) throw error;
    throw new ConnectionAvailabilityUnknownError();
  }
}
