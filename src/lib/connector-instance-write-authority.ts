import "server-only";

// Per-user / per-connector-instance WRITE authority for the CMS content path
// (cinatra#409).
//
// THE GAP THIS CLOSES. The MCP boundary (src/lib/authz/mcp-boundary.ts:266)
// defers WRITE/ADMIN/EXECUTE effects to the per-handler authz layer — it only
// membership-gates the write and AUDITS the per-permission result
// (`deferredToHandler: !permitted`). The WordPress / Drupal content-editor MCP
// connectors historically ran their write handlers under a HARDCODED synthetic
// actor (`{ actorType: "model", source: "agent" }`), so the REAL user never
// reached handler authz and ANY caller who passed the coarse org-membership gate
// could write to ANY configured instance in the org. Even post-#408 (the widget
// route pins `input.instanceId == verified-origin instance`, re-checks live
// membership, and threads `runBy=userId` to the MCP boundary), the WRITE was
// gated by org-MEMBERSHIP + connector-PACKAGE entitlement, not by the user's
// rights ON THE SPECIFIC INSTANCE.
//
// WHY THE PACKAGE-LEVEL CHECK ALONE IS NOT ENOUGH (codex must-fix). The host's
// `requireConnectorAuthority(packageId, actor, { instanceId })` evaluates the
// connector-PACKAGE access policy (`evaluateExtensionAccess` against the
// connector's `extension_access_policy`, keyed on `(organizationId,
// package_name)`); the `instanceId` is currently AUDIT-ONLY in that path. So a
// same-org member entitled to the WordPress/Drupal connector package would, with
// the package check alone, write to ANY instance configured in the org — the
// per-instance layer would be a no-op. THIS module adds the missing per-instance
// gate: it resolves the instance row HOST-SIDE and asserts the instance's
// persisted org binding (`{orgId, runBy}`, cinatra#274) matches the TRUSTED
// actor's org BEFORE delegating to the package authority. A forged instanceId —
// same-org-but-unbound-or-mismatched, or a different-org instance — is denied
// here because the resolved row's org does not match the trusted actor's org.
//
// THE ENFORCEMENT. This module is the HOST-OWNED authority the content
// connectors call before EVERY write primitive. It:
//   (a) resolves the TRUSTED user actor host-side from the active
//       `mcpRequestContextStorage` / llm / cookie frame (via
//       `resolveExtensionActorContext` + `resolveExtensionActorSummary`) — NEVER
//       from connector / tool input;
//   (b) DENIES (throws) fail-closed when no `userId` + `orgId` resolve (a
//       synthetic / anonymous actor can never write);
//   (c) RE-VERIFIES LIVE ORG MEMBERSHIP for EVERY actor on EVERY path
//       (cinatra#406 + the 4th-gap fix). A per-user/per-instance CONTENT WRITE
//       must rest on the user's ACTUAL, CURRENT org membership + per-instance
//       grant — NEVER on the STAMPED org/role a carrier asserts, and NEVER on
//       platform-admin standing. The connector-package evaluator decides a
//       `workspace`-visibility connector on `actor.organizationId === ownerOrg`
//       ALONE with no membership-row read, so a REVOKED/stale same-org member
//       (stale cookie `activeOrganizationId`, or a not-yet-rotated delegated
//       agent-run token) could otherwise write — the revocation-TOCTOU /
//       fail-open family (cf. #413/#415). So for EVERY actor the authority
//       resolves the user's REAL membership role host-side
//       (`resolveOrgRoleForUser` against the trusted/instance-bound org),
//       DENIES fail-closed if there is no membership row
//       (`platform_admin_without_org_membership` for an admin carrier, else
//       `member_without_org_membership`) or the lookup errors
//       (`org_membership_resolution_error`), and otherwise delegates with
//       `platformRole` STRIPPED unconditionally and `orgRole` PINNED to the REAL
//       live membership role (never the carried role — a stale/forged claim can
//       never select privilege) — so the package authority decides on the
//       actual current grant, never admin bypass nor a stale carrier. The
//       `sourceType: "public_site_widget"` defensive deny is kept (belt-and-
//       braces, audited) so a future regression on the widget carrier still
//       short-circuits before any read;
//   (d) RESOLVES THE INSTANCE ROW host-side (host-bound reader) and asserts its
//       persisted org binding == the trusted actor's org — THE per-instance gate
//       (`instanceId` is load-bearing in the decision, not just audit). A row
//       that is unknown, unbound (no `orgId`), or bound to a DIFFERENT org is
//       DENIED fail-closed;
//   (e) calls `requireConnectorAuthority(<HOST-BOUND connector pkg>, actor,
//       { mode: "use", instanceId })` — the connector-PACKAGE entitlement layer,
//       which also emits a `connector_instance` audit row — and throws on deny;
//   (f) the `packageId` AND the instance reader are HOST-BOUND from a CLOSED
//       connector-kind enum (`"wordpress" | "drupal"`), NEVER caller-supplied:
//       the connector names only WHICH KIND it is (its own static identity), and
//       the host maps that to both the package id and the instance reader, so a
//       connector can never select a different package's policy nor a different
//       reader (codex must-fix).
//
// The boundary (mcp-boundary.ts) is deliberately LEFT AS-IS: it stays the coarse
// membership gate by design (line 266 comment); moving per-instance checks into
// the boundary would duplicate connector policy and make the boundary understand
// tool-specific `instanceId` semantics. The per-handler layer (this dep) owns
// entitlement.

import {
  resolveExtensionActorContext,
  resolveExtensionActorSummary,
} from "@/lib/extension-host-actor";
import { requireConnectorAuthority } from "@/lib/connector-authority";
import { resolveOrgRoleForUser } from "@/lib/auth-session";
import { logAuditEvent } from "@/lib/authz/audit";
import type { ActorContext } from "@/lib/authz/actor-context";
import { readWordPressInstanceById } from "@/lib/wordpress-api";
import { getDrupalAPISettings } from "@/lib/drupal-api";
import { getConnectorDescriptorBySlug } from "@cinatra-ai/connectors-catalog/descriptors.mjs";

/**
 * The CLOSED set of CMS content connectors this authority gates, mapping the
 * connector KIND (the connector's OWN static identity it passes) to its
 * CATALOG SLUG — NOT to a concrete package-name literal. The connector never
 * supplies a package id; it names only its kind, and the host owns the
 * kind→slug mapping. The package id is then DERIVED at resolution time from the
 * single sanctioned connector-catalog registry (`getConnectorDescriptorBySlug`)
 * — never named in this core file — so the package whose policy is evaluated is
 * host-bound and registry-resolved, never caller input AND never a frozen core
 * vendor literal (true-IoC: vendor identity is registry-declared + host-gated,
 * not a hardcoded core constant).
 */
const CONNECTOR_KIND_TO_CATALOG_SLUG = {
  wordpress: "wordpress-mcp-connector",
  drupal: "drupal-mcp-connector",
} as const;

export type InstanceWriteConnectorKind = keyof typeof CONNECTOR_KIND_TO_CATALOG_SLUG;

/**
 * Resolve the host-bound connector package id for a CMS-write kind THROUGH the
 * sanctioned connector-catalog registry: the host maps the kind to its catalog
 * SLUG, then the registry derives the package id (no package-name literal lives
 * in core). Fail-closed: an unknown kind, or a slug the registry does not cover,
 * THROWS — the connector can never select another package's policy, and a
 * resolution miss can never silently fall through to a write.
 */
function resolvePackageIdForKind(kind: InstanceWriteConnectorKind): string {
  const slug = CONNECTOR_KIND_TO_CATALOG_SLUG[kind];
  const packageId = getConnectorDescriptorBySlug(slug)?.packageId;
  if (!packageId) {
    throw new InstanceWriteAuthorityError(`unresolved_connector_kind:${kind}`);
  }
  return packageId;
}

/**
 * The package ids this authority gates (the host allowlist for this kind set),
 * DERIVED from the connector-catalog registry via the host-owned kind→slug map
 * — this core module names no package literal; the ids are registry-resolved.
 * A kind whose slug the registry does not cover resolves to `undefined` here
 * (diagnostics-only surface); the load-bearing path uses `resolvePackageIdForKind`,
 * which fails closed. Exposed for host wiring/diagnostics and test assertions.
 */
export const INSTANCE_WRITE_AUTHORITY_PACKAGE_IDS: Record<
  InstanceWriteConnectorKind,
  string | undefined
> = Object.fromEntries(
  (Object.keys(CONNECTOR_KIND_TO_CATALOG_SLUG) as InstanceWriteConnectorKind[]).map(
    (kind) => [kind, getConnectorDescriptorBySlug(CONNECTOR_KIND_TO_CATALOG_SLUG[kind])?.packageId],
  ),
) as Record<InstanceWriteConnectorKind, string | undefined>;

/** A resolved instance's persisted org binding (cinatra#274). `orgId` is the org
 * that owns the install; `null` for a legacy/unbound row (which fails closed). */
type InstanceOrgBinding = { orgId: string | null };

/**
 * Host-bound instance readers, keyed by connector kind. Each returns the
 * persisted org binding for an instance id, or `null` when the instance does not
 * exist. The reader is selected HOST-SIDE from the kind enum — never by caller
 * input — so a connector can never read another connector's instance rows.
 */
const CONNECTOR_KIND_TO_INSTANCE_ORG_RESOLVER: Record<
  InstanceWriteConnectorKind,
  (instanceId: string) => InstanceOrgBinding | null
> = {
  wordpress: (instanceId) => {
    const row = readWordPressInstanceById(instanceId);
    if (!row) return null;
    return { orgId: typeof row.orgId === "string" && row.orgId.trim() ? row.orgId.trim() : null };
  },
  drupal: (instanceId) => {
    const row = getDrupalAPISettings().instances.find((i) => i.id === instanceId);
    if (!row) return null;
    return { orgId: typeof row.orgId === "string" && row.orgId.trim() ? row.orgId.trim() : null };
  },
};

/** Thrown when a per-instance write authority check denies. Fail-closed: the
 * connector handler MUST let this propagate (never fall back to a write). */
export class InstanceWriteAuthorityError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`connector instance write denied: ${reason}`);
    this.name = "InstanceWriteAuthorityError";
    this.reason = reason;
  }
}

/** The trusted actor frame this authority resolves from the host context. */
type ResolvedActor = {
  actor: ActorContext;
  userId: string;
  orgId: string;
};

/**
 * Resolve the TRUSTED user actor from the active host context (MCP / llm /
 * cookie), returning the kernel `ActorContext` together with the human SUBJECT
 * userId and the org id — BOTH derived from the SAME store so they can never be
 * combined across stores. Returns `null` when no `userId` + `orgId` resolve.
 *
 * Identity is HOST-DERIVED ONLY — never from connector / tool input.
 */
async function resolveTrustedWriteActor(): Promise<ResolvedActor | null> {
  // Summary carries the human SUBJECT userId + org (the `runBy` user on whose
  // behalf the model call runs). The kernel actor carries roles/platformRole.
  // Both come from the SAME trusted resolution (extension-host-actor).
  const [actor, summary] = await Promise.all([
    resolveExtensionActorContext(),
    resolveExtensionActorSummary(),
  ]);
  const userId = summary?.userId ?? null;
  const orgId = summary?.organizationId ?? actor?.organizationId ?? null;
  if (!actor || !userId || !orgId) return null;
  // The policy + per-instance gate key on the actor's org; pin it to the trusted
  // summary org (coherent by construction — same store) so a forged cross-org
  // instanceId is evaluated against the actor's REAL org, never the tool input.
  return { actor: { ...actor, organizationId: orgId }, userId, orgId };
}

export type InstanceWriteAuthorityInput = {
  /** WHICH connector instance the write targets (the tool `instanceId` arg). */
  instanceId: string;
  /** The write primitive name (for the audit row — e.g. `wordpress_post_update`). */
  primitiveName: string;
  /**
   * The request's source type when the host surfaces it on the MCP context
   * (additive; defaults to undefined). When `"public_site_widget"`, the
   * authority defensively asserts no platform-admin bypass. NOT trusted from
   * connector input — the host threads it; this is a belt-and-braces field.
   */
  sourceType?: string;
};

export type RequireInstanceWriteAuthority = (
  input: InstanceWriteAuthorityInput,
) => Promise<void>;

/**
 * Mint a per-connector-kind write-authority guard. `kind` is the CLOSED enum the
 * connector names for ITSELF; the host maps it to the package id + instance
 * reader (never caller-supplied). The returned guard throws
 * `InstanceWriteAuthorityError` on deny (fail-closed) and resolves `void` on
 * allow.
 */
export function createInstanceWriteAuthority(
  kind: InstanceWriteConnectorKind,
): RequireInstanceWriteAuthority {
  const packageId = resolvePackageIdForKind(kind);
  const resolveInstanceOrg = CONNECTOR_KIND_TO_INSTANCE_ORG_RESOLVER[kind];

  return async function requireInstanceWriteAuthority({
    instanceId,
    primitiveName,
    sourceType,
  }: InstanceWriteAuthorityInput): Promise<void> {
    const deny = async (
      reason: string,
      ids?: { userId?: string; orgId?: string },
    ): Promise<never> => {
      await logAuditEvent({
        ...(ids?.orgId ? { organizationId: ids.orgId } : {}),
        ...(ids?.userId ? { actorPrincipalId: ids.userId } : {}),
        actorPrincipalType: "human",
        authSource: "mcp",
        resourceType: "connector_instance",
        resourceId: instanceId,
        operation: "use",
        decision: "denied",
        policyVersion: "connector-instance-write-authority",
        metadata: {
          packageId,
          connectorKind: kind,
          primitiveName,
          reason,
          ...(sourceType ? { sourceType } : {}),
        },
      });
      throw new InstanceWriteAuthorityError(reason);
    };

    // (a)+(b) Resolve the trusted user actor; DENY fail-closed if absent. The
    // synthetic/anonymous path NEVER reaches the instance read or the policy.
    const resolved = await resolveTrustedWriteActor();
    if (!resolved) await deny("no_trusted_actor");
    const { actor, userId, orgId } = resolved as ResolvedActor;

    // (c) Defensive: on the public-site-widget path the actor must NOT carry a
    // platform-admin bypass (post-#408 `resolveAgentRunMcpActor` suppresses it;
    // assert it here so a future regression on the carrier cannot silently
    // re-grant admin-bypass writes from a public widget).
    if (sourceType === "public_site_widget" && actor.platformRole === "platform_admin") {
      await deny("platform_admin_on_public_widget", { userId, orgId });
    }

    // (c-universal) LIVE ORG-MEMBERSHIP RE-VERIFICATION on EVERY path — a
    // mandatory precondition for ANY per-instance CMS write (cinatra#406 +
    // the 4th-gap fix), run BEFORE the per-instance read so a revoked/stale actor
    // is denied UNIFORMLY and cannot use the precise instance deny reasons
    // (`unknown_instance` / `instance_unbound` / `instance_org_mismatch`) as an
    // instance-existence / org-binding ORACLE (self-review hardening). The
    // connector-package authority's delegated evaluator (`evaluateExtensionAccess`)
    // decides a `workspace`-visibility connector on the STAMPED org alone
    // (`actor.organizationId === ownerOrg`), with NO membership-row read — and
    // BOTH the canonical evaluator and the legacy `isOrgAdmin` fallback grant
    // `platform_admin` UNCONDITIONALLY. So passing ANY actor through on its
    // CARRIED standing would let a stale/revoked same-org member (stale cookie
    // `activeOrganizationId`, or a not-yet-rotated delegated agent-run token) —
    // or platform-admin standing — authorize a content write, the
    // revocation-TOCTOU / fail-open family (cf. #413/#415).
    //
    // We therefore resolve the user's REAL membership in the trusted org and
    // delegate ONLY a membership-DERIVED actor:
    //   - membership lookup errors     → DENY (fail-closed, never allow on error)
    //   - no membership row            → DENY: standing (member OR platform-admin)
    //                                     is not a LIVE org grant. A revoked
    //                                     member with a stale carrier is denied
    //                                     here even under `workspace` visibility.
    //   - real member/org_admin/owner  → continue to the per-instance gate, then
    //                                     delegate with `orgRole` PINNED to the
    //                                     REAL live role (never the carried role
    //                                     — a stale/forged `orgRole` claim can
    //                                     never select privilege) and
    //                                     `platformRole` STRIPPED unconditionally
    //                                     (so admin standing can never decide a
    //                                     content write, and future carrier drift
    //                                     can never become load-bearing).
    // The deny reason names the carrier class for diagnostics:
    // `platform_admin_without_org_membership` when the actor carried platform
    // admin, else `member_without_org_membership`. An entitled member HAS a live
    // row → continues, so the #405 headless and #408 widget entitled-user paths
    // are unaffected (they resolve their real role and delegate as it).
    let realOrgRole: ActorContext["orgRole"] | undefined;
    try {
      realOrgRole = await resolveOrgRoleForUser(orgId, userId);
    } catch {
      await deny("org_membership_resolution_error", { userId, orgId });
    }
    if (!realOrgRole) {
      await deny(
        actor.platformRole === "platform_admin"
          ? "platform_admin_without_org_membership"
          : "member_without_org_membership",
        { userId, orgId },
      );
    }

    // (d) PER-INSTANCE gate — the missing layer (codex must-fix). Resolve the
    // instance row HOST-SIDE and assert its persisted org binding == the trusted
    // actor's org. `instanceId` is load-bearing in the decision here, not just
    // audit. Unknown / unbound (no orgId) / different-org → DENY fail-closed. A
    // forged instanceId (same-org-config-mismatch OR different-org) is caught by
    // the org mismatch; a row with no persisted org binding cannot prove
    // entitlement → deny (stricter, safe). Reached only AFTER a live membership
    // row is confirmed, so these precise reasons never leak to a revoked actor.
    let binding: InstanceOrgBinding | null;
    try {
      binding = resolveInstanceOrg(instanceId);
    } catch {
      // A thrown instance-reader error fails CLOSED with a normalized audited
      // deny row (never propagate raw / allow on a read fault).
      await deny("instance_resolution_error", { userId, orgId });
      return; // unreachable — deny() throws; satisfies definite-assignment
    }
    if (!binding) await deny("unknown_instance", { userId, orgId });
    const instanceOrgId = (binding as InstanceOrgBinding).orgId;
    if (!instanceOrgId) await deny("instance_unbound", { userId, orgId });
    if (instanceOrgId !== orgId) await deny("instance_org_mismatch", { userId, orgId });

    // Build the delegated decision actor FROM SCRATCH as a sanitized human
    // SUBJECT — NEVER by spreading the carrier actor (the 4th-gap self-review
    // must-fix). Spreading would forward the carrier's STALE authorization scope
    // (`teamIds` / `teamRoles` / `projectIds` / `projectGrants`) into the package
    // evaluator, which authorizes `team:<id>` / `project:<id>` connector
    // visibility tiers off those fields — so a member REMOVED from a team/project
    // but carrying stale scope could still write (the same stale-scope family as
    // the org-membership gap). We therefore drop EVERY carried authorization
    // field and supply only host-verified facts:
    //   - principalType "HumanUser" + principalId = the trusted SUBJECT userId,
    //     so the evaluator's `humanUserId()` resolves the real human and an
    //     entitled installer / co-owner is recognized even when the transport
    //     carrier was a model / A2A principal (fixes the non-human-carrier
    //     false-deny);
    //   - organizationId pinned to the trusted, instance-bound org;
    //   - orgRole pinned to the LIVE membership role (never a carried/forged claim);
    //   - platformRole stripped (admin standing can never decide a content write).
    // Scoped tiers (`team:` / `project:`) therefore FAIL CLOSED here (`not_visible`)
    // rather than ride stale scope — correct for WP/Drupal, which are org-owned
    // admin|workspace connectors. `authSource` / `policyVersion` are carried
    // (non-authorization audit/version metadata only).
    const decisionActor: ActorContext = {
      principalType: "HumanUser",
      principalId: userId,
      organizationId: orgId,
      orgRole: realOrgRole,
      platformRole: undefined,
      authSource: actor.authSource,
      policyVersion: actor.policyVersion,
    };

    // (e) Connector-PACKAGE entitlement via the existing connector authority. The
    // package id is HOST-BOUND for this kind — resolved through the connector
    // catalog registry from the host-owned kind→slug map, never caller-supplied.
    // `requireConnectorAuthority` evaluates the connector-package policy for the
    // actor's org and emits its own `connector_instance` audit row. The actor
    // passed here NEVER carries platform-admin standing (stripped above).
    let decision: Awaited<ReturnType<typeof requireConnectorAuthority>>;
    try {
      decision = await requireConnectorAuthority(packageId, decisionActor, {
        mode: "use",
        instanceId,
      });
    } catch {
      // A thrown package-authority error fails CLOSED with a normalized audited
      // deny row (never propagate raw / allow on a policy-evaluation fault).
      await deny("connector_authority_error", { userId, orgId });
      return; // unreachable — deny() throws; satisfies definite-assignment
    }
    if (!decision.allowed) {
      await deny(decision.reason, { userId, orgId });
    }
  };
}

/**
 * The minimal instance shape the actor-scoped LIST filter needs: every row
 * carries an `id` (the per-instance authority is keyed on it). Callers thread
 * their own richer row type through the generic so the FULL row is returned
 * unchanged for the authorized subset.
 */
type InstanceWithId = { id: string };

/**
 * An actor-scoped instance LIST filter. Given the GLOBAL, unscoped instance
 * rows, returns ONLY the subset the CURRENT TRUSTED actor is authorized to
 * `use` — the read-boundary twin of `requireWrite`, reusing the IDENTICAL
 * authority machinery (same trusted-actor resolution, same universal
 * live-membership reverify, same sanitized decisionActor, same per-instance
 * org-binding gate, same connector-package `requireConnectorAuthority` check).
 * It NEVER throws to the caller — a deny at any layer DROPS the instance (or,
 * for actor/membership failures, returns `[]`), so the external-MCP
 * toolbox-injection path fails CLOSED (injects no tools) rather than leaking
 * another tenant's credentialed MCP server.
 */
export type FilterAuthorizedInstances = <T extends InstanceWithId>(
  instances: T[],
) => Promise<T[]>;

/**
 * Mint a per-connector-kind, actor-scoped instance LIST filter. `kind` is the
 * CLOSED enum the connector names for ITSELF; the host maps it to the package id
 * + instance reader (never caller-supplied). The returned filter:
 *   (a)+(b) resolves the TRUSTED actor host-side and returns `[]` fail-closed
 *           when none resolves (synthetic/anonymous/legacy frame);
 *   (c)     RE-VERIFIES LIVE ORG MEMBERSHIP for the actor and returns `[]` when
 *           there is no membership row OR the lookup errors (a revoked/stale
 *           same-org member, or a platform-admin without a live membership row,
 *           gets nothing — no admin bypass);
 *   (d)     keeps ONLY instances whose persisted org binding matches the trusted
 *           actor's org (unknown/unbound/different-org rows are dropped) AND
 *   (e)     for which `requireConnectorAuthority(<host-bound pkg>, decisionActor,
 *           { mode:"use", instanceId })` ALLOWS — using a decisionActor built
 *           FROM SCRATCH (platformRole stripped, orgRole pinned to the LIVE
 *           role, scoped tiers dropped), exactly like `requireWrite`.
 * Identity is HOST-DERIVED ONLY — never from connector / tool input.
 */
export function createInstanceListAuthority(
  kind: InstanceWriteConnectorKind,
): FilterAuthorizedInstances {
  const packageId = resolvePackageIdForKind(kind);
  const resolveInstanceOrg = CONNECTOR_KIND_TO_INSTANCE_ORG_RESOLVER[kind];

  return async function filterAuthorizedInstances<T extends InstanceWithId>(
    instances: T[],
  ): Promise<T[]> {
    if (!instances || instances.length === 0) return [];

    // (a)+(b) Resolve the trusted user actor; DENY-ALL fail-closed if absent.
    // The synthetic/anonymous/legacy frame yields NO instances (never the
    // global list) — the exact fail-closed posture the connector toolbox needs.
    const resolved = await resolveTrustedWriteActor();
    if (!resolved) return [];
    const { actor, userId, orgId } = resolved;

    // (c) LIVE ORG-MEMBERSHIP RE-VERIFICATION (cinatra#406 + the 4th-gap fix),
    // run ONCE before the per-instance loop. A membership row is a MANDATORY
    // precondition: no row (revoked/stale member, or platform-admin without a
    // live membership) OR a lookup error → DENY-ALL (return []). Standing
    // (member OR platform-admin) is NOT a live org grant.
    let realOrgRole: ActorContext["orgRole"] | undefined;
    try {
      realOrgRole = await resolveOrgRoleForUser(orgId, userId);
    } catch {
      return [];
    }
    if (!realOrgRole) return [];

    // Build the delegated decision actor FROM SCRATCH as a sanitized human
    // SUBJECT — IDENTICAL construction to `requireWrite` (platformRole stripped,
    // orgRole pinned to the LIVE role, every carried authorization scope
    // dropped) so admin standing / stale team|project scope can never decide a
    // listed instance, and a non-human transport carrier (model/A2A) still
    // resolves the real human installer/co-owner.
    const decisionActor: ActorContext = {
      principalType: "HumanUser",
      principalId: userId,
      organizationId: orgId,
      orgRole: realOrgRole,
      platformRole: undefined,
      authSource: actor.authSource,
      policyVersion: actor.policyVersion,
    };

    const authorized: T[] = [];
    for (const instance of instances) {
      // (d) PER-INSTANCE org-binding gate. Resolve the row HOST-SIDE and keep it
      // ONLY when its persisted org binding == the trusted actor's org. Unknown
      // / unbound (no orgId) / different-org rows are DROPPED (never injected).
      // A reader fault drops the single instance (fail-closed, never the list).
      let binding: InstanceOrgBinding | null;
      try {
        binding = resolveInstanceOrg(instance.id);
      } catch {
        continue;
      }
      if (!binding) continue;
      const instanceOrgId = binding.orgId;
      if (!instanceOrgId || instanceOrgId !== orgId) continue;

      // (e) CONNECTOR-PACKAGE entitlement — the host-bound package policy, keyed
      // on the sanitized decisionActor's org. Keep the instance ONLY on allow.
      // A policy-evaluation fault drops the single instance (fail-closed).
      try {
        const decision = await requireConnectorAuthority(packageId, decisionActor, {
          mode: "use",
          instanceId: instance.id,
        });
        if (!decision.allowed) continue;
      } catch {
        continue;
      }
      authorized.push(instance);
    }
    return authorized;
  };
}

/**
 * Build the host `instance-write-authority` service object the host publishes
 * into the capability registry. `selectForConnector` accepts the CLOSED
 * connector-kind enum (`"wordpress" | "drupal"`) — the connector's OWN static
 * identity — and returns a guard bound HOST-SIDE to that kind's package id +
 * instance reader. The package id is resolved through the connector catalog
 * registry (never a core package-name literal); an unknown kind THROWS, so the
 * package whose policy is evaluated and the instance rows that can be read are
 * always host-controlled, never arbitrary caller input (codex must-fix).
 */
export function createInstanceWriteAuthorityService(): {
  selectForConnector(kind: string): { requireWrite: RequireInstanceWriteAuthority };
} {
  return {
    selectForConnector(kind: string) {
      if (!Object.prototype.hasOwnProperty.call(CONNECTOR_KIND_TO_CATALOG_SLUG, kind)) {
        throw new InstanceWriteAuthorityError(`unsupported_connector_kind:${kind}`);
      }
      const requireWrite = createInstanceWriteAuthority(kind as InstanceWriteConnectorKind);
      return { requireWrite };
    },
  };
}
