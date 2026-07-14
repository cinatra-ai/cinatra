/**
 * MCP boundary enforcement.
 *
 * Wraps every MCP `tools/call` dispatch with a registry-driven
 * deny-by-default check. Three outcomes per call:
 *
 *   1. `allowed: true`  — call proceeds.
 *   2. `allowed: false, shouldBlock: false` — audit emitted, call proceeds
 *      (shadow mode). Used for `status: "unenforced" | "partial"`
 *      classifications until they are enforced.
 *   3. `allowed: false, shouldBlock: true` — call rejected, audit emitted,
 *      MCP returns an error envelope.
 *
 * A typed `CarveOut` matching the primitive's name + boundary perimeter
 * short-circuits to `allowed: true` (audit notes the bypass).
 */
import "server-only";

import { lookupPrimitiveClassification, type EnforcementStatus, type PrimitiveClassification } from "./inventory-augment";
import { lookupClassification } from "./registry";
import { getEffectiveExtensionMcpTool } from "@/lib/extension-mcp-registry";
import { findCarveOut, type BoundaryPerimeter } from "./carve-out";
import { logAuditEvent } from "./audit";
import { can } from "./enforce";
import type { ActorContext } from "./actor-context";
import type { OboCeilingChain, OboCeilingTier } from "@cinatra-ai/mcp-server/obo-ceiling";

// ---------------------------------------------------------------------------
// Agent OBO "cannot-express" surface classifier (epic #1049 / W4 #1053).
//
// Some MCP surfaces never resolve a target resource's owner (ownerType/ownerId),
// so they cannot honor a sub-organization OBO scope ceiling. For an AGENT-RUN
// OBO token whose ceiling chain is narrower than the org floor, those surfaces
// deny fail-closed (see enforceMcpBoundary). Kept INLINE in this boundary
// module — its sole consumer — rather than a separate leaf module, so it adds
// no node to any route's reachable first-party graph (the /sign-in route-graph
// ratchet). Exported for unit tests.
// ---------------------------------------------------------------------------

/** The cannot-express W4 surface classes (epic #1049 surface class 3), plus
 *  the P5.5 assistant surface (cinatra#1037) which joined the class at birth. */
export type CannotExpressSurface =
  | "connector"
  | "trigger"
  | "metrics"
  | "permissions"
  | "notifications"
  | "dashboard_cube"
  | "assistant";

// The standalone trigger-config primitives (the trigger module's own tools).
// The sibling agent_run_trigger_* primitives share resourceType "trigger" but
// resolve run ownership (kernel wave W2) and MUST be excluded — hence trigger is
// matched by NAME here, not by resourceType.
const TRIGGER_CONFIG_PRIMITIVES: ReadonlySet<string> = new Set([
  "trigger_config_get",
  "trigger_config_set",
  "trigger_config_delete",
]);

// Dashboard-cube name prefix — matched by name so the shared resourceType
// "dashboard" does not drag in the dashboards_* proper tools (ad-hoc wave W3).
const DASHBOARD_CUBE_PREFIX = "dashboards_cube_";

// The generalized assistant MCP surface (cinatra#1037 P5.5). assistant_threads
// rows carry ORG scoping only (no team/project/workspace column), and a sent
// turn runs with the target user's FULL server-resolved context — so the
// surface structurally cannot honor a sub-organization ceiling. Matched by
// NAME because the classification resourceType "object" is shared with the
// objects_* kernel wave (W2), which resolves real ownership and must NOT be
// captured. The module's resolveCaller() refuses the same callers as
// defense-in-depth.
const ASSISTANT_MCP_PRIMITIVES: ReadonlySet<string> = new Set([
  "assistant_send",
  "assistant_thread_list",
  "assistant_thread_get",
]);

/**
 * Which cannot-express W4 surface a primitive belongs to, or `null` when it is
 * not a W4 cannot-express surface. The five resource types matched by type are
 * EXCLUSIVELY W4 surfaces; the trigger/dashboard/assistant members are matched
 * by name because those resource types are shared with sibling waves.
 */
export function cannotExpressSurface(args: {
  primitiveName: string;
  resourceType: string;
}): CannotExpressSurface | null {
  const { primitiveName, resourceType } = args;
  if (resourceType === "connector_instance") return "connector";
  if (resourceType === "administration") return "permissions";
  if (resourceType === "metric_cost" || resourceType === "metric_usage") return "metrics";
  if (resourceType === "notification") return "notifications";
  if (TRIGGER_CONFIG_PRIMITIVES.has(primitiveName)) return "trigger";
  if (primitiveName.startsWith(DASHBOARD_CUBE_PREFIX)) return "dashboard_cube";
  if (ASSISTANT_MCP_PRIMITIVES.has(primitiveName)) return "assistant";
  return null;
}

/**
 * The NON-organization ceiling tiers present in a chain (deduped, order-stable).
 * Empty ⇒ the chain is org-only (only the mandatory org floor), which these
 * surfaces CAN express. A `null`/`undefined` chain yields `[]` — the caller
 * gates on the ceiling's PRESENCE (⟺ agent-run OBO) separately, never treating
 * absence as a non-org bound.
 */
export function oboCeilingNonOrgTiers(
  chain: OboCeilingChain | null | undefined,
): OboCeilingTier[] {
  if (!chain || chain.length === 0) return [];
  const seen = new Set<OboCeilingTier>();
  const out: OboCeilingTier[] = [];
  for (const c of chain) {
    if (c.tier !== "organization" && !seen.has(c.tier)) {
      seen.add(c.tier);
      out.push(c.tier);
    }
  }
  return out;
}

export type McpBoundaryDecision =
  | { allowed: true; reason?: never; shouldBlock?: never }
  | { allowed: false; reason: string; shouldBlock: boolean };

export type McpBoundaryRequest = {
  primitiveName: string;
  /** mcpRequestContextStorage frame at call time. */
  ctx?: {
    orgId?: string | null;
    userId?: string | null;
    platformRole?: "platform_admin" | "member" | null;
    /**
     * Org-membership role carried natively on the MCP request context —
     * resolved once at transport context-build time for the SAME
     * orgId/userId pair in this frame (see McpRequestContext.orgRole).
     * When present, the boundary's synthetic actor uses it instead of the
     * coarse "member" default so org-admin-gated classifications evaluate
     * correctly at the boundary. Absent → existing member default.
     */
    orgRole?: "org_owner" | "org_admin" | "member" | null;
    delegatedRestricted?: boolean;
    /**
     * Agent run id from the signed delegated-actor token (when the
     * caller is an agent-run-OBO delegation) or the X-Cinatra-Run-Id
     * header (legacy). Forwarded to `logAuditEvent` so every
     * cross-service MCP call is traceable back to the dispatching run.
     */
    runId?: string;
    projectContext?: { projectId?: string | null };
    /**
     * Agent-run OBO scope-ceiling chain forwarded from the delegated actor
     * (`McpRequestContext.oboCeiling`). Carried onto the synthetic actor so the
     * enforcement wave can consult it; no boundary decision reads it yet.
     */
    oboCeiling?: OboCeilingChain;
  };
  /** When true, dispatch is via the chat-bridge token (delegated_chat_token perimeter). */
  delegatedRestricted: boolean;
};

function statusShouldBlock(status: EnforcementStatus): boolean {
  return status === "enforced";
}

function synthActor(ctx: McpBoundaryRequest["ctx"], extraRoles?: string[]): ActorContext {
  // an authenticated user with an active org is, at minimum,
  // a `member`. The kernel's `resolveRoles` only pushes the member role when
  // `orgRole` is set, so we default it here for the coarse boundary check
  // (the per-handler authz still does the fine-grained ownership lookup).
  // When the transport carried the resolved membership role (ctx.orgRole,
  // coherent with ctx.orgId/ctx.userId by construction), prefer it over the
  // coarse default so org_admin/org_owner boundary decisions are native.
  const isMember = !!ctx?.userId && !!ctx?.orgId;
  return {
    principalType: "HumanUser",
    principalId: ctx?.userId ?? "anonymous",
    authSource: "mcp",
    policyVersion: "current",
    organizationId: ctx?.orgId ?? undefined,
    orgRole:
      ctx?.platformRole === "platform_admin"
        ? undefined
        : ctx?.orgRole ?? (isMember ? "member" : undefined),
    platformRole: ctx?.platformRole ?? undefined,
    // Carry the agent-run OBO ceiling onto the synthetic actor (carrier only —
    // no boundary decision consults it yet). Undefined for non-agent-run callers.
    ...(ctx?.oboCeiling ? { oboCeiling: ctx.oboCeiling } : {}),
    ...(extraRoles && extraRoles.length > 0 ? ({ roles: extraRoles } as Partial<ActorContext>) : {}),
  } as ActorContext;
}

export async function enforceMcpBoundary(req: McpBoundaryRequest): Promise<McpBoundaryDecision> {
  let classification = lookupPrimitiveClassification(req.primitiveName);

  // Extension-registered MCP tools (register(ctx) → ctx.mcp.registerTool) are not
  // in the host's static PRIMITIVE_CLASSIFICATIONS inventory. When the host has NO
  // classification AND the name is an EFFECTIVELY-registered extension tool,
  // synthesize an ENFORCED `platform/execute` classification so the coarse
  // deny-by-default boundary applies (platform_admin allowed; an unauthenticated /
  // org-less caller is blocked; an authenticated org member is allowed through with
  // the fine-grained permission audited-but-deferred to the extension's own
  // handler — execute-effect semantics). This closes the prior shadow-allow posture
  // where an extension tool that does not self-gate executed for ANY caller the
  // transport let through: extension tools are now no weaker than the host's own
  // enforced tools. NOT an unknown-tool bypass: it keys on the EFFECTIVE set (tools
  // the server build actually replayed, EXCLUDING names skipped due to a
  // static/reserved host collision), so an extension cannot unlock a host tool
  // (e.g. an unclassified built-in like `system_screen_lookup`) by registering its
  // name. Host classifications always win (the static lookup above); NEVER
  // synthesized on the delegated-chat perimeter (extension tools aren't on that
  // allowlist).
  let extensionClassificationPackage: string | undefined;
  if (!classification && !req.delegatedRestricted) {
    const effTool = getEffectiveExtensionMcpTool(req.primitiveName);
    if (effTool) {
      classification = { resourceType: "platform", action: "execute", status: "enforced" } satisfies PrimitiveClassification;
      extensionClassificationPackage = effTool.packageName;
    }
  }
  // Owning-package provenance for extension-tool audit rows, threaded into the
  // enforced-path audit metadata below (empty for host primitives).
  const extProvenance: Record<string, string> = extensionClassificationPackage
    ? { classificationSource: "extension_mcp_registry", packageName: extensionClassificationPackage }
    : {};

  if (!classification) {
    // Unclassified primitives are blocked in enforce mode (static checks cover
    // the inventory side; this is the defense-in-depth runtime hit).
    await logAuditEvent({
      organizationId: req.ctx?.orgId ?? undefined,
      actorPrincipalId: req.ctx?.userId ?? undefined,
      actorPrincipalType: "human",
      authSource: "mcp",
      resourceType: "platform",
      operation: req.primitiveName,
      decision: "denied",
      policyVersion: "current",
      ...(req.ctx?.runId ? { runId: req.ctx.runId } : {}),
      metadata: { reason: "unclassified_primitive" },
    });
    return { allowed: false, reason: "unclassified_primitive", shouldBlock: true };
  }

  // ── W4 (#1053): cannot-express surfaces under agent-run OBO ───────────────
  // Surfaces that never resolve a target's owner (`ownerType/ownerId`) cannot
  // honor a sub-organization scope ceiling (epic #1049 surface class 3). For an
  // AGENT-RUN OBO token whose ceiling chain is NARROWER than the org floor, deny
  // fail-closed HERE — before the carve-out, the unenforced-status shadow-skip,
  // and the owner/platform-admin short-circuits below — so a platform-admin
  // invoker can never nullify the ceiling for a delegated run (the same ordering
  // the kernel-wave ceiling uses). `req.ctx.oboCeiling` is present iff the caller
  // is an agent-run OBO delegation (the transport stamps it only for
  // `delegation === "agent_run"`); session / dev-bypass / A2A / chat-delegated
  // callers carry no chain here, so this gate is a no-op for them. A dashboard-
  // cube ORG-only ceiling is intentionally allowed through and instead confined
  // at the cube SecurityContext (`accessibleOrgIds` pinned to the run org) — the
  // coarse boundary can only deny, not pin.
  const cannotExpress = cannotExpressSurface({
    primitiveName: req.primitiveName,
    resourceType: classification.resourceType,
  });
  if (cannotExpress && req.ctx?.oboCeiling) {
    const unhonoredCeilingTiers = oboCeilingNonOrgTiers(req.ctx.oboCeiling);
    // Most cannot-express surfaces deny only a NARROWER-than-org ceiling — an
    // org-only ceiling is honored elsewhere (e.g. the dashboard-cube pins
    // `accessibleOrgIds` to the run org). The ASSISTANT surface is stricter: a
    // sent turn runs with the target's FULL server-resolved context AND drives a
    // NESTED turn under a fresh ceiling-less delegation token (the runtime mints
    // `delegation:"chat"`), so it can honor NEITHER a sub-org bound NOR the org
    // floor itself. It therefore denies on the ceiling's PRESENCE — agent-run
    // OBO delegations do not use this surface until the ceiling can be expressed
    // AND propagated (cinatra#1037; the module's resolveCaller() enforces the
    // same, handler-side defense-in-depth).
    const denyForSurface =
      cannotExpress === "assistant" ? true : unhonoredCeilingTiers.length > 0;
    if (denyForSurface) {
      await audit(req, classification.resourceType, "denied", {
        mode: "enforced",
        boundary: "mcp_handler_dispatch",
        reason: "agent_run_obo_scope_unsupported",
        oboSurface: cannotExpress,
        unhonoredCeilingTiers,
      });
      return {
        allowed: false,
        reason: `agent_run_obo_scope_unsupported:${cannotExpress}`,
        shouldBlock: true,
      };
    }
  }

  const perimeter: BoundaryPerimeter = req.delegatedRestricted
    ? "delegated_chat_token"
    : "mcp_handler_dispatch";

  const carve = findCarveOut({ primitiveName: req.primitiveName, boundary: perimeter });
  if (carve) {
    await logAuditEvent({
      organizationId: req.ctx?.orgId ?? undefined,
      actorPrincipalId: req.ctx?.userId ?? undefined,
      actorPrincipalType: "human",
      authSource: "mcp",
      resourceType: classification.resourceType,
      operation: req.primitiveName,
      decision: "allowed",
      policyVersion: "current",
      ...(req.ctx?.runId ? { runId: req.ctx.runId } : {}),
      metadata: { carveOut: true, risk: carve.risk, boundary: perimeter },
    });
    return { allowed: true };
  }

  // Skip the kernel check entirely for primitives still classified as
  // "unenforced". The per-handler legacy authz path remains in force; the
  // boundary just emits a shadow audit event.
  if (classification.status === "unenforced") {
    await logAuditEvent({
      organizationId: req.ctx?.orgId ?? undefined,
      actorPrincipalId: req.ctx?.userId ?? undefined,
      actorPrincipalType: "human",
      authSource: "mcp",
      resourceType: classification.resourceType,
      operation: req.primitiveName,
      decision: "allowed",
      policyVersion: "current",
      ...(req.ctx?.runId ? { runId: req.ctx.runId } : {}),
      metadata: {
        mode: "shadow",
        boundary: perimeter,
        status: classification.status,
        // Provenance when this is an extension-registered tool.
        ...(extensionClassificationPackage
          ? { classificationSource: "extension_mcp_registry", packageName: extensionClassificationPackage }
          : {}),
      },
    });
    return { allowed: true };
  }

  const reg = lookupClassification(classification.resourceType, classification.action);
  if (!reg) {
    // Drift between augment + registry. Block in enforce-strict mode; static
    // consistency tests should have already failed CI.
    await audit(req, classification.resourceType, "denied", { reason: "registry_drift" });
    return { allowed: false, reason: "registry_drift", shouldBlock: true };
  }

  const block = statusShouldBlock(classification.status);

  // Coarse boundary semantics.
  //
  // The MCP boundary is a deny-by-default *org-membership + role + read-perm*
  // gate. Owner-sensitive WRITE/EXECUTE/ADMIN authorization stays in the
  // per-handler authz (which does the real owner + cross-tenant record
  // lookup) until the resolver matrix proves fine-grained correctness.
  // Concretely, the boundary hard-blocks (when status=enforced):
  //   1. platform_admin → always allowed.
  //   2. unauthenticated / org-less callers → blocked (deny-by-default).
  //   3. requireRole mismatch → blocked (e.g. marketplace publish needs
  //      release_manager). Role grants resolved lazily — only for the ~2
  //      requireRole primitives — so the hot path takes no DB hit.
  //   4. READ/LIST effect → the base permission is enforced via can().
  //   5. WRITE/ADMIN/EXECUTE effect → membership-gated; the specific
  //      permission result is AUDITED but not hard-blocked (per-handler
  //      authz owns ownership).

  // (1) platform admin bypass.
  if (req.ctx?.platformRole === "platform_admin") {
    await audit(req, classification.resourceType, "allowed", { mode: "enforced", boundary: perimeter, via: "platform_admin", ...extProvenance });
    return { allowed: true };
  }

  // (2) deny-by-default: authenticated org member required.
  if (!req.ctx?.userId || !req.ctx?.orgId) {
    await audit(req, classification.resourceType, "denied", { mode: "enforced", boundary: perimeter, reason: "not_org_member", ...extProvenance });
    return { allowed: false, reason: "not_org_member", shouldBlock: block };
  }

  // (3) role gate — lazy-resolve role grants only for requireRole primitives.
  let extraRoles: string[] | undefined;
  if (reg.requiredAccess.requireRole) {
    try {
      const { resolveEffectiveRoleNamesForUser } = await import("./role-grant-store");
      extraRoles = await resolveEffectiveRoleNamesForUser(req.ctx.userId, req.ctx.orgId);
    } catch {
      extraRoles = [];
    }
    if (!extraRoles.includes(reg.requiredAccess.requireRole)) {
      await audit(req, classification.resourceType, "denied", {
        mode: "enforced",
        boundary: perimeter,
        reason: "missing_role",
        required: reg.requiredAccess.requireRole,
      });
      return { allowed: false, reason: `missing_role:${reg.requiredAccess.requireRole}`, shouldBlock: block };
    }
  }

  const actor = synthActor(req.ctx, extraRoles);
  const resource = {
    resourceType: classification.resourceType,
    resourceId: req.primitiveName,
    organizationId: req.ctx.orgId,
    ownerType: "organization" as const,
    ownerId: req.ctx.orgId,
  };
  const permitted = can(actor, reg.requiredAccess.requiredPermission, resource);

  // (4) read/list effect: the base permission is hard-enforced.
  if (reg.effect === "read") {
    if (!permitted) {
      await audit(req, classification.resourceType, "denied", {
        mode: "enforced",
        boundary: perimeter,
        requiredPermission: reg.requiredAccess.requiredPermission,
      });
      return { allowed: false, reason: `denied:${reg.requiredAccess.requiredPermission}`, shouldBlock: block };
    }
    await audit(req, classification.resourceType, "allowed", {
      mode: "enforced",
      boundary: perimeter,
      requiredPermission: reg.requiredAccess.requiredPermission,
    });
    return { allowed: true };
  }

  // (5) write/admin/execute: membership-gated; per-handler authz owns
  // ownership. Audit the permission result for forensics, then allow the call
  // through to the handler.
  await audit(req, classification.resourceType, "allowed", {
    mode: "enforced",
    boundary: perimeter,
    effect: reg.effect,
    requiredPermission: reg.requiredAccess.requiredPermission,
    permittedAtBoundary: permitted,
    deferredToHandler: !permitted,
    ...extProvenance,
  });
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Audit helper — collapses the repeated logAuditEvent boilerplate.
// ---------------------------------------------------------------------------
async function audit(
  req: McpBoundaryRequest,
  resourceType: string,
  decision: "allowed" | "denied",
  metadata: Record<string, unknown>,
): Promise<void> {
  await logAuditEvent({
    organizationId: req.ctx?.orgId ?? undefined,
    actorPrincipalId: req.ctx?.userId ?? undefined,
    actorPrincipalType: "human",
    authSource: "mcp",
    resourceType,
    operation: req.primitiveName,
    decision,
    policyVersion: "current",
    // Runs originated by an agent-run-OBO delegation carry the run id in
    // the request store (signed-token claim). Propagate so every audit
    // row links back to the dispatching run.
    ...(req.ctx?.runId ? { runId: req.ctx.runId } : {}),
    metadata,
  });
}
