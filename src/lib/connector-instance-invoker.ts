import "server-only";

// The governed connector-instance invoker — Plane C core (cinatra#2017 S2 slice
// K6, design §1.1–§1.4 / §2 / §3). An INTERNAL host API, never model-visible,
// that reaches a connector instance's own MCP catalog through the full
// authz → policy → classify → hook → execute → audit order (D1). The two
// connector-owned model-visible primitives (`wordpress_site_tool_call` /
// `wordpress_site_tools_list`) call this through the host-bound, connector-scoped
// capability (§1.6, published in register-host-connector-services.ts).
//
// Dependency-injected so the whole order is unit-testable with a mocked SDK
// Client/transport, mocked authority gate, mocked cache + policy store (§6.1).
// `connectorKey` is HOST-INTERNAL — supplied ONLY by the host-bound guard (MCP
// path) or the host-minted job binding (job path), NEVER a connector/model/
// payload field on any path (M6 / R2-B1 / R3-B1).

import type { ActorContext } from "@/lib/authz/actor-context";
import type {
  ConnectorInstancePin,
  SiteToolRow,
  SiteToolsListPage,
} from "@cinatra-ai/sdk-extensions";
import {
  evaluateInstanceToolPolicy,
  type InstanceToolPolicyRecord,
  type ToolRef,
} from "@cinatra-ai/mcp-server/instance-tool-policy";
import { classifyAnnotations } from "@cinatra-ai/mcp-server/annotation-classifier";
import {
  InvokerError,
  TRIAD_EXECUTE_ABILITY,
} from "@/lib/connector-instance-mcp-transport";
import {
  CATALOG_DEFAULT_SERVER_ID,
  composeSortedCatalog,
  resolveToolAcrossServers,
  type CatalogServerSnapshot,
  type CatalogToolEntry,
  type ConnectorInstanceCatalogCache,
} from "@/lib/connector-instance-catalog-cache";

/** The trusted actor the invoker operates under — ALWAYS host-derived (§2.4),
 * never connector/tool input. `actor`/`userId`/`orgId` feed the single live
 * authority pass; `connectorInstancePin` is the normalized signed pin (§2.7). */
export type InvokerTrustedActor = {
  actor: ActorContext;
  userId: string;
  orgId: string;
  connectorInstancePin?: ConnectorInstancePin;
};

/** The step-1 authority gate, pre-bound to the connectorKey (the guard selects
 * it host-side). Throws (fail-closed) on deny — its own authorization-decision
 * audit is emitted internally (M4: exactly one live pass per invocation). */
export type RequireInstanceUseGate = (
  actor: { actor: ActorContext; userId: string; orgId: string },
  input: { instanceId: string; primitiveName: string; sourceType?: string; causation?: string },
) => Promise<void>;

/** Host-side resolved wire target for an instance (Nango → Basic auth; §1.3). */
export type ResolvedInstanceEndpoint = { endpoint: string; authHeader: string };

/** Fresh-serve window for a per-(instance, server) catalog snapshot
 * (cinatra#2018 S3 D7). Expansion costs one discover + N get-info wire calls,
 * so refreshing at most every 5 min per server is negligible load while
 * keeping "a new tool appears within the TTL" a 5-minute promise. */
export const CATALOG_TTL_MS = 5 * 60_000;
/** Serve-stale ceiling, applied ONLY when a refresh FAILED (D7): bounds the
 * operator-visible inconsistency window through a transient site outage
 * without letting a long-dead site serve phantom catalogs. */
export const CATALOG_MAX_STALE_MS = 60 * 60_000;

/** The minimal enrolled-server projection the acquire loop consumes
 * (structurally satisfied by the enrollment store's `listEnrolledServers`) —
 * deliberately never the full health/history row. */
export type EnrolledServerRef = {
  serverId: string;
  exposureMode: "triad-only" | "first-class" | null;
  restPath: string;
};

/** Map a catalog-load failure onto the persisted per-server health state
 * (cinatra#2018 S3 §7): wire 401/403 → `auth_error`; absent-stack
 * (`network_error`/`timeout`) → `unreachable`; everything else — the endpoint
 * answered but expansion failed (`session_required`/`tool_error`/
 * `empty_response`/`invalid_response`) or an unclassified expansion error —
 * → `catalog_unavailable`. */
export function mapCatalogLoadErrorToServerHealth(
  err: unknown,
): "catalog_unavailable" | "unreachable" | "auth_error" {
  if (err instanceof InvokerError) {
    if (err.httpStatus === 401 || err.httpStatus === 403) return "auth_error";
    if (err.code === "network_error" || err.code === "timeout") return "unreachable";
    return "catalog_unavailable";
  }
  return "catalog_unavailable";
}

export type ConnectorInstanceInvokerDeps = {
  /** Step 1 — the SINGLE live per-instance USE authority pass (M4). */
  requireUse: RequireInstanceUseGate;
  /** Lazy first-touch backstop (R2-B2): ensure an explicit open policy row on the
   * first AUTHORIZED touch. Runs after step 1, before the catalog read. */
  ensureDefaultOpenPolicy: (input: {
    connectorKey: string;
    instanceId: string;
    updatedBy: string;
    reason: string;
  }) => Promise<{ created: boolean }>;
  /** Host-side endpoint + single-source (Nango→Basic) auth resolution (§1.3).
   * Runs ONLY after the gate (B2). Returns null when the instance is
   * unresolvable. The OPTIONAL third parameter (cinatra#2018 S3) resolves a
   * dedicated enrolled server's per-route endpoint; omitted / the default id
   * keeps the exact pre-S3 behavior, and an unknown/retired serverId resolves
   * null (fail closed). Legacy two-parameter implementations remain assignable. */
  resolveInstanceEndpoint: (
    connectorKey: string,
    instanceId: string,
    serverId?: string,
  ) => Promise<ResolvedInstanceEndpoint | null>;
  /** cinatra#2018 S3 — the enrollment-store read driving multi-server acquire.
   * OPTIONAL for compatibility: when ABSENT the acquire path keeps the exact
   * S2 single-default-server behavior (legacy deps / connectors without
   * enrollment). When PRESENT the acquire loop serves ONLY currently-enrolled
   * serverIds (store beats cache: a retired server's still-cached snapshot is
   * unreachable even if eviction raced) under the TTL/max-stale policy, and a
   * FAILED store read fails CLOSED (typed error — never a silent
   * default-server fallback that could resurrect a retired server). */
  listEnrolledServers?: (
    connectorKey: string,
    instanceId: string,
  ) => Promise<EnrolledServerRef[]>;
  /** cinatra#2018 S3 — first-touch default-enrollment backstop, run in the
   * shared gate tail beside `ensureDefaultOpenPolicy` so a pre-S3 instance
   * converges to an explicit default-enrolled row on first authorized use. */
  ensureDefaultServerEnrollment?: (input: {
    connectorKey: string;
    instanceId: string;
  }) => Promise<void>;
  /** cinatra#2018 S3 — per-server health write-back from acquire-loop load
   * failures (§7). Failures here are logged, never masking the serve path. */
  recordServerCatalogStatus?: (input: {
    connectorKey: string;
    instanceId: string;
    serverId: string;
    status: "catalog_unavailable" | "unreachable" | "auth_error";
    at: number;
  }) => Promise<void>;
  /** TTL/max-stale overrides (tests). Defaults: CATALOG_TTL_MS / CATALOG_MAX_STALE_MS. */
  catalogTtlMs?: number;
  catalogMaxStaleMs?: number;
  /** The per-(instance, server) catalog cache (§1.4). */
  cache: ConnectorInstanceCatalogCache;
  /** Populate a server's catalog snapshot from the wire (triad expand /
   * first-class passthrough). Called on a cache miss, AFTER the gate. */
  loadServerSnapshot: (input: {
    connectorKey: string;
    instanceId: string;
    serverId: string;
    endpoint: string;
    authHeader: string;
  }) => Promise<CatalogServerSnapshot>;
  /** Execute one WIRE tool (transport). The invoker maps triad translation onto
   * this; first-class calls pass through. */
  callWireTool: (input: {
    endpoint: string;
    authHeader: string;
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<unknown>;
  /** Read the persisted per-instance policy (§2.6). */
  readPolicy: (connectorKey: string, instanceId: string) => Promise<InstanceToolPolicyRecord | null>;
  /** Step 5 — execution / list-served audit sink. */
  audit: (event: {
    resourceType: "connector_instance";
    resourceId: string;
    operation: string;
    decision: "allowed" | "denied";
    metadata: Record<string, unknown>;
    actorPrincipalId?: string;
    organizationId?: string;
    causation?: string;
  }) => Promise<void> | void;
  /** Step 3 — S5 destructive-confirmation hook. S2 only FIRES it when enabled AND
   * the resolved tool classifies destructive; the subsystem is S5 (absent = no-op). */
  destructiveHook?: {
    enabled: () => boolean;
    fire: (input: {
      connectorKey: string;
      instanceId: string;
      serverId: string;
      toolName: string;
      actor: InvokerTrustedActor;
      causation?: string;
    }) => Promise<void>;
  };
  /** Warn-once sink for the absent-policy compatibility fallback (§10-A3). */
  warnAbsentPolicy?: (connectorKey: string, instanceId: string) => void;
  /** Audit-warn sink for a fail-closed INVALID policy record (§10-A3): a
   * malformed/unknown-mode record denies-all AND emits an audit warn. Distinct
   * from the absent (compatibility) fallback — invalid is a security signal. */
  warnInvalidPolicy?: (connectorKey: string, instanceId: string) => void;
  now?: () => number;
  /** Governed list page size (§3.5 uncapped pagination — this bounds a single
   * page, not the total). Default 100. */
  pageSize?: number;
};

export type InvokeConnectorInstanceToolInput = {
  /** HOST-INTERNAL — from the host-bound guard / job binding ONLY (M6/R2-B1/R3-B1). */
  connectorKey: string;
  instanceId?: string;
  serverId?: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Advisory op intent (audit + hook input); NEVER a security decision (§1.2). */
  intent?: string;
  actor: InvokerTrustedActor;
  causation?: string;
  /** The connector primitive name for the authority + execution audit rows. */
  primitiveName?: string;
  sourceType?: string;
};

export type ListConnectorInstanceToolsInput = {
  connectorKey: string;
  instanceId?: string;
  serverId?: string;
  cursor?: string;
  actor: InvokerTrustedActor;
  causation?: string;
  primitiveName?: string;
  sourceType?: string;
};

const DEFAULT_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Steps 0–1 — the SHARED gate spine both invoke + list run BEFORE any catalog
// read (B2). Returns the resolved effective instance id (never a catalog).
// ---------------------------------------------------------------------------
async function runSharedGate(
  input: {
    connectorKey: string;
    instanceId?: string;
    actor: InvokerTrustedActor;
    causation?: string;
    primitiveName: string;
    sourceType?: string;
  },
  deps: ConnectorInstanceInvokerDeps,
): Promise<{ effectiveInstanceId: string }> {
  const boundConnectorKey = input.connectorKey;
  const pin = input.actor.connectorInstancePin;

  // Step 0 — pin + connector-bind gate (§1.2 / §2.7 / B1 / M6).
  let effectiveInstanceId: string;
  if (pin) {
    if (pin.connectorKey !== boundConnectorKey) {
      throw new InvokerError(
        "instance_pin_mismatch",
        "connector-instance pin does not match the host-bound connector",
      );
    }
    if (input.instanceId !== undefined && input.instanceId !== pin.instanceId) {
      throw new InvokerError(
        "instance_pin_mismatch",
        "supplied instanceId does not match the signed instance pin",
      );
    }
    effectiveInstanceId = input.instanceId ?? pin.instanceId;
  } else {
    if (!input.instanceId) {
      throw new InvokerError(
        "instance_id_required",
        "an explicit instanceId is required when the actor carries no instance pin",
      );
    }
    effectiveInstanceId = input.instanceId;
  }

  // Step 1 — the SINGLE live per-instance USE authority pass (M4). Throws
  // fail-closed on deny; emits its own authorization-decision audit internally.
  await deps.requireUse(
    { actor: input.actor.actor, userId: input.actor.userId, orgId: input.actor.orgId },
    {
      instanceId: effectiveInstanceId,
      primitiveName: input.primitiveName,
      ...(input.sourceType ? { sourceType: input.sourceType } : {}),
      ...(input.causation ? { causation: input.causation } : {}),
    },
  );

  // Lazy first-touch backstop (R2-B2) — ensure an explicit open policy row on the
  // first AUTHORIZED touch, so "absent" is provably transient.
  await deps.ensureDefaultOpenPolicy({
    connectorKey: boundConnectorKey,
    instanceId: effectiveInstanceId,
    updatedBy: "system:connector-instance-policy-first-touch",
    reason: "invoker_first_touch",
  });

  // First-touch default-ENROLLMENT backstop (cinatra#2018 S3), mirroring the
  // policy backstop above: a pre-S3 instance converges to an explicit
  // default-enrolled server row the moment it is used — zero backfill.
  await deps.ensureDefaultServerEnrollment?.({
    connectorKey: boundConnectorKey,
    instanceId: effectiveInstanceId,
  });

  return { effectiveInstanceId };
}

/**
 * Acquire the instance's catalog snapshots. Runs ONLY after the gate (B2).
 *
 * ENROLLMENT-DRIVEN path (cinatra#2018 S3 — `listEnrolledServers` bound): the
 * loop iterates the STORE's currently-enrolled servers (store beats cache —
 * layer 1 of removed-server fail-closed: a retired server's still-cached
 * snapshot is unreachable even if eviction raced, because iteration is DRIVEN
 * by this per-call list read — a server absent from it is never looked up in
 * the cache at all, so the residual exposure is only the read-to-serve
 * instant of an acquire already in flight when the retire commits, a bound no
 * additional per-server store re-read could tighten) and enforces the
 * freshness policy per server: fresh (age ≤ TTL) serves the cache; expired triggers a
 * per-server reload (endpoint resolved per server); a FAILED reload serves the
 * stale snapshot only within the max-stale window (age honestly visible via
 * `cacheAgeMs`) and records the mapped per-server health; past max-stale the
 * server contributes nothing (fail closed). A store-read failure fails CLOSED
 * (typed error) — never a silent default-server fallback. When the caller
 * EXPLICITLY targeted an enrolled server that ended up with no obtainable
 * snapshot, the typed `catalog_unavailable` error distinguishes "the catalog
 * is unavailable" from `tool_not_found`.
 *
 * LEGACY path (`listEnrolledServers` absent — S2-shaped deps): byte-identical
 * S2 behavior — cache-first, default-server population on a miss.
 *
 * SECURITY (§10-A1 / R3-M3, both paths): snapshots are only ever minted under
 * STABLE, host-owned server ids — `CATALOG_DEFAULT_SERVER_ID` or ids read from
 * the enrollment STORE — NEVER a caller-supplied `serverId`. Minting a catalog
 * under a caller-picked id would let a caller forge a `{serverId,name}` policy
 * key that no deny entry matches (policy bypass). A caller `serverId` stays a
 * downstream FILTER (resolveToolAcrossServers / the list `scoped` filter /
 * the explicit-target check here); an unenrolled id resolves to
 * `tool_not_found`, never a mis-tagged catalog.
 *
 * EXPORTED (cinatra#2019 S4, surface-only — zero behavior change): the
 * trusted-site native-read-injection builder must recompute its eligibility
 * verdict against snapshots served under EXACTLY this freshness policy
 * (TTL / bounded serve-stale / fail-closed store read), never a forked second
 * one. The binder composes it with the same deps object the invoker runs on;
 * callers own their gate — like the in-module callers, this runs only AFTER
 * an authorization pass.
 */
export async function acquireSnapshots(
  input: {
    connectorKey: string;
    instanceId: string;
    endpoint: string;
    authHeader: string;
    requestedServerId?: string;
  },
  deps: ConnectorInstanceInvokerDeps,
): Promise<CatalogServerSnapshot[]> {
  if (!deps.listEnrolledServers) {
    const cached = deps.cache.listForInstance(input.instanceId);
    if (cached.length > 0) return cached;
    const snap = await deps.loadServerSnapshot({
      connectorKey: input.connectorKey,
      instanceId: input.instanceId,
      serverId: CATALOG_DEFAULT_SERVER_ID,
      endpoint: input.endpoint,
      authHeader: input.authHeader,
    });
    deps.cache.set(input.instanceId, snap);
    return [snap];
  }

  let enrolled: EnrolledServerRef[];
  try {
    enrolled = await deps.listEnrolledServers(input.connectorKey, input.instanceId);
  } catch {
    throw new InvokerError(
      "catalog_unavailable",
      "the server-enrollment read failed; refusing to serve any catalog",
    );
  }

  const now = deps.now?.() ?? Date.now();
  const ttlMs = deps.catalogTtlMs ?? CATALOG_TTL_MS;
  const maxStaleMs = deps.catalogMaxStaleMs ?? CATALOG_MAX_STALE_MS;
  const served: CatalogServerSnapshot[] = [];

  for (const server of enrolled) {
    const cached = deps.cache.get(input.instanceId, server.serverId);
    const ageMs = cached ? now - cached.fetchedAtMs : Number.POSITIVE_INFINITY;
    if (cached && ageMs <= ttlMs) {
      served.push(cached);
      continue;
    }

    // Miss/expired → per-server reload. The default server reuses the already-
    // resolved instance endpoint (behavior-identical to S2); a dedicated server
    // resolves its own enrolled route.
    let target: ResolvedInstanceEndpoint | null = null;
    let resolutionThrew = false;
    if (server.serverId === CATALOG_DEFAULT_SERVER_ID) {
      target = { endpoint: input.endpoint, authHeader: input.authHeader };
    } else {
      try {
        target = await deps.resolveInstanceEndpoint(
          input.connectorKey,
          input.instanceId,
          server.serverId,
        );
      } catch {
        resolutionThrew = true;
      }
    }
    if (!target) {
      // No VALID endpoint exists for this server, so nothing may be served —
      // NOT even a stale snapshot. A returned null is the FRESHER store read
      // saying the server is no longer enrolled (or the instance is broken):
      // store beats cache, so the stale snapshot is evicted with it. A thrown
      // resolution is indeterminate — serve nothing this call (the cache entry
      // stays for the next acquire to settle). Serve-stale is reserved for
      // WIRE refresh failures after a valid endpoint was resolved; explicit
      // targeting of this server surfaces as catalog_unavailable below.
      if (!resolutionThrew) deps.cache.invalidate(input.instanceId, server.serverId);
      continue;
    }

    let loadError: unknown;
    try {
      const snap = await deps.loadServerSnapshot({
        connectorKey: input.connectorKey,
        instanceId: input.instanceId,
        serverId: server.serverId,
        endpoint: target.endpoint,
        authHeader: target.authHeader,
      });
      deps.cache.set(input.instanceId, snap);
      served.push(snap);
      continue;
    } catch (err) {
      loadError = err;
    }

    // WIRE reload FAILED (valid endpoint, refresh did not): record per-server
    // health, then serve-stale-within-window or omit (fail closed past
    // max-stale).
    if (deps.recordServerCatalogStatus) {
      try {
        await deps.recordServerCatalogStatus({
          connectorKey: input.connectorKey,
          instanceId: input.instanceId,
          serverId: server.serverId,
          status: mapCatalogLoadErrorToServerHealth(loadError),
          at: now,
        });
      } catch (recordErr) {
        console.error(
          "[connector-instance-invoker] per-server health write-back failed",
          recordErr,
        );
      }
    }
    if (cached && ageMs <= maxStaleMs) served.push(cached);
  }

  // Explicitly-targeted enrolled server with no obtainable snapshot → the
  // typed distinction from tool_not_found (the tool may well exist; the
  // catalog is unavailable). Without an explicit target the other servers
  // still resolve and a missing tool stays tool_not_found.
  if (
    input.requestedServerId &&
    enrolled.some((server) => server.serverId === input.requestedServerId) &&
    !served.some((snapshot) => snapshot.serverId === input.requestedServerId)
  ) {
    throw new InvokerError(
      "catalog_unavailable",
      `no catalog snapshot is obtainable for enrolled server "${input.requestedServerId}"`,
    );
  }

  return served;
}

// ---------------------------------------------------------------------------
// invokeConnectorInstanceTool — the D1 single-pass order (steps 0→5).
// ---------------------------------------------------------------------------
export async function invokeConnectorInstanceTool(
  input: InvokeConnectorInstanceToolInput,
  deps: ConnectorInstanceInvokerDeps,
): Promise<unknown> {
  const primitiveName = input.primitiveName ?? "connector_instance_tool_call";
  const { effectiveInstanceId } = await runSharedGate(
    {
      connectorKey: input.connectorKey,
      instanceId: input.instanceId,
      actor: input.actor,
      causation: input.causation,
      primitiveName,
      sourceType: input.sourceType,
    },
    deps,
  );

  // Endpoint + single-source auth resolution (host-side; AFTER the gate — B2).
  const resolved = await deps.resolveInstanceEndpoint(input.connectorKey, effectiveInstanceId);
  if (!resolved) {
    throw new InvokerError("network_error", "connector instance endpoint could not be resolved");
  }

  // Catalog presence + duplicate-name routing (§3.6) against the CACHED snapshots.
  const snapshots = await acquireSnapshots(
    {
      connectorKey: input.connectorKey,
      instanceId: effectiveInstanceId,
      endpoint: resolved.endpoint,
      authHeader: resolved.authHeader,
      ...(input.serverId ? { requestedServerId: input.serverId } : {}),
    },
    deps,
  );
  const resolution = resolveToolAcrossServers(snapshots, input.toolName, input.serverId);
  if (!resolution.ok) {
    if (resolution.reason === "ambiguous_tool") {
      throw new InvokerError(
        "ambiguous_tool",
        `toolName "${input.toolName}" is non-unique across enrolled servers; a serverId is required (candidates: ${resolution.candidateServerIds.join(", ")})`,
      );
    }
    throw new InvokerError("tool_not_found", `tool "${input.toolName}" is not present in the instance catalog`);
  }
  const { serverId, name, entry, snapshot } = resolution;

  // Step 2 — per-instance tool policy floor (§2.6 / §10-A3).
  const ref: ToolRef = { serverId, name };
  const policy = await deps.readPolicy(input.connectorKey, effectiveInstanceId);
  const decision = evaluateInstanceToolPolicy(policy, ref);
  if (decision.warn === "absent_policy_fallback_open") {
    deps.warnAbsentPolicy?.(input.connectorKey, effectiveInstanceId);
  } else if (decision.warn === "invalid_policy_deny_all") {
    deps.warnInvalidPolicy?.(input.connectorKey, effectiveInstanceId);
  }
  if (decision.status === "denied") {
    throw new InvokerError(
      "tool_policy_denied",
      `tool "${name}" is denied by the instance policy for server "${serverId}"`,
    );
  }

  // Step 3 — destructive-confirmation hook (advisory class; fire only, S5 owns it).
  const derivedClass = classifyAnnotations(entry.rawAnnotations);
  if (derivedClass === "destructive" && deps.destructiveHook?.enabled()) {
    await deps.destructiveHook.fire({
      connectorKey: input.connectorKey,
      instanceId: effectiveInstanceId,
      serverId,
      toolName: name,
      actor: input.actor,
      ...(input.causation ? { causation: input.causation } : {}),
    });
  }

  // Step 4 — execute. Triad-translate on triad-only servers; direct call on
  // first-class servers (§3.1). structuredContent-preferring unwrap in transport.
  // The wire target is the RESOLVED server's endpoint (cinatra#2018 S3): the
  // default server keeps the pre-resolved instance endpoint (behavior-identical
  // to S2); a dedicated enrolled server resolves its own route — null (e.g. a
  // retire raced the call) fails closed.
  let wireTarget: ResolvedInstanceEndpoint = resolved;
  if (serverId !== CATALOG_DEFAULT_SERVER_ID && deps.listEnrolledServers) {
    const perServer = await deps.resolveInstanceEndpoint(
      input.connectorKey,
      effectiveInstanceId,
      serverId,
    );
    if (!perServer) {
      throw new InvokerError(
        "network_error",
        "connector instance endpoint could not be resolved",
      );
    }
    wireTarget = perServer;
  }
  const wire =
    snapshot.exposureMode === "triad-only"
      ? { name: TRIAD_EXECUTE_ABILITY, arguments: { ability_name: name, parameters: input.args } }
      : { name, arguments: input.args };
  // Execution-audit failures (both step-5 sites below) are logged and
  // swallowed: by then the wire call has already run and cannot be rolled
  // back or safely replayed, so audit persistence must never turn a completed
  // non-idempotent call into a caller-visible failure (retry → double
  // execution) nor replace the typed InvokerError callers branch on. Durable
  // audit delivery is a future hardening concern, deliberately not this seam's.
  const auditSafely = async (event: Parameters<ConnectorInstanceInvokerDeps["audit"]>[0]) => {
    try {
      await deps.audit(event);
    } catch (auditErr) {
      console.error("[connector-instance-invoker] execution-audit sink failed", auditErr);
    }
  };
  let result: unknown;
  try {
    result = await deps.callWireTool({
      endpoint: wireTarget.endpoint,
      authHeader: wireTarget.authHeader,
      name: wire.name,
      arguments: wire.arguments,
    });
  } catch (err) {
    // Step 5 — execution audit (failure). Then re-throw the typed error.
    await auditSafely({
      resourceType: "connector_instance",
      resourceId: effectiveInstanceId,
      operation: primitiveName,
      decision: "denied",
      actorPrincipalId: input.actor.userId,
      organizationId: input.actor.orgId,
      ...(input.causation ? { causation: input.causation } : {}),
      metadata: {
        connectorKey: input.connectorKey,
        serverId,
        toolName: name,
        derivedClass,
        ...(input.intent ? { intent: input.intent } : {}),
        error: err instanceof InvokerError ? err.code : "error",
      },
    });
    throw err;
  }

  // Step 5 — execution audit (success). Distinct from step-1's authorization-
  // decision audit — exactly one of each per invocation (M4).
  await auditSafely({
    resourceType: "connector_instance",
    resourceId: effectiveInstanceId,
    operation: primitiveName,
    decision: "allowed",
    actorPrincipalId: input.actor.userId,
    organizationId: input.actor.orgId,
    ...(input.causation ? { causation: input.causation } : {}),
    metadata: {
      connectorKey: input.connectorKey,
      serverId,
      toolName: name,
      derivedClass,
      ...(input.intent ? { intent: input.intent } : {}),
    },
  });

  return result;
}

// ---------------------------------------------------------------------------
// listConnectorInstanceTools — governed tools_list (B2): shares steps 0–1 BEFORE
// any catalog read, then composes the frozen-contract rows (§3.5 / §10-A2).
// ---------------------------------------------------------------------------

/** Revision-pinned cursor: `${compositeRevision}::${offset}` (§3.5). */
function encodeCursor(compositeRevision: string, offset: number): string {
  return Buffer.from(`${compositeRevision}::${offset}`, "utf8").toString("base64url");
}
function decodeCursor(cursor: string): { revision: string; offset: number } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const idx = raw.lastIndexOf("::");
    if (idx < 0) return null;
    const revision = raw.slice(0, idx);
    const offset = Number.parseInt(raw.slice(idx + 2), 10);
    if (!Number.isInteger(offset) || offset < 0) return null;
    return { revision, offset };
  } catch {
    return null;
  }
}

/** Composite snapshot revision across an instance's servers. In S2 (single
 * default server) this is unambiguous; §8 flags the multi-server composite as
 * S3's design. Stable for a given snapshot set; bumps when any server re-fetches. */
function compositeRevisionOf(snapshots: readonly CatalogServerSnapshot[]): string {
  return snapshots
    .map((s) => `${s.serverId}@${s.catalogRevision}`)
    .sort()
    .join("|");
}

export async function listConnectorInstanceTools(
  input: ListConnectorInstanceToolsInput,
  deps: ConnectorInstanceInvokerDeps,
): Promise<SiteToolsListPage> {
  const primitiveName = input.primitiveName ?? "connector_instance_tools_list";
  // Steps 0–1 — the SAME pin + live USE authority gate BEFORE any catalog read
  // (B2). A no-actor / revoked-actor / pin-mismatch caller receives a typed error
  // and NEVER a catalog (the gate throws before `resolveInstanceEndpoint` or the
  // cache is ever touched).
  const { effectiveInstanceId } = await runSharedGate(
    {
      connectorKey: input.connectorKey,
      instanceId: input.instanceId,
      actor: input.actor,
      causation: input.causation,
      primitiveName,
      sourceType: input.sourceType,
    },
    deps,
  );

  const resolved = await deps.resolveInstanceEndpoint(input.connectorKey, effectiveInstanceId);
  if (!resolved) {
    throw new InvokerError("network_error", "connector instance endpoint could not be resolved");
  }

  const snapshots = await acquireSnapshots(
    {
      connectorKey: input.connectorKey,
      instanceId: effectiveInstanceId,
      endpoint: resolved.endpoint,
      authHeader: resolved.authHeader,
      ...(input.serverId ? { requestedServerId: input.serverId } : {}),
    },
    deps,
  );
  const scoped = input.serverId ? snapshots.filter((s) => s.serverId === input.serverId) : snapshots;
  const compositeRevision = compositeRevisionOf(scoped);

  // Revision-pinned cursor: a stale cursor (minted against a bumped snapshot) is
  // rejected — never a silently mixed listing (§3.5).
  let offset = 0;
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    if (!decoded || decoded.revision !== compositeRevision) {
      throw new InvokerError(
        "catalog_revision_changed",
        "the catalog snapshot changed since this cursor was minted; restart pagination",
      );
    }
    offset = decoded.offset;
  }

  // Policy + classifier applied per row (restricted marks denied, never shortens
  // — §2.6 / §3.5 / N9). Report-never-drop mirrors S0's skipped[] shape.
  const policy = await deps.readPolicy(input.connectorKey, effectiveInstanceId);
  let warnedAbsent = false;
  let warnedInvalid = false;
  const sorted = composeSortedCatalog(scoped);
  const now = deps.now?.() ?? Date.now();
  const snapshotById = new Map(scoped.map((s) => [s.serverId, s]));

  const allRows: SiteToolRow[] = sorted.map((entry: CatalogToolEntry) => {
    const snap = snapshotById.get(entry.serverId)!;
    const decision = evaluateInstanceToolPolicy(policy, { serverId: entry.serverId, name: entry.name });
    if (decision.warn === "absent_policy_fallback_open" && !warnedAbsent) {
      warnedAbsent = true;
      deps.warnAbsentPolicy?.(input.connectorKey, effectiveInstanceId);
    } else if (decision.warn === "invalid_policy_deny_all" && !warnedInvalid) {
      warnedInvalid = true;
      deps.warnInvalidPolicy?.(input.connectorKey, effectiveInstanceId);
    }
    return {
      name: entry.name,
      serverId: entry.serverId,
      inputSchema: entry.inputSchema,
      ...(entry.outputSchema !== undefined ? { outputSchema: entry.outputSchema } : {}),
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      rawAnnotations: entry.rawAnnotations,
      derivedClass: classifyAnnotations(entry.rawAnnotations),
      policyStatus: decision.status,
      cacheAgeMs: Math.max(0, now - snap.fetchedAtMs),
      catalogRevision: compositeRevision,
    } satisfies SiteToolRow;
  });

  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
  const pageRows = allRows.slice(offset, offset + pageSize);
  const nextOffset = offset + pageRows.length;
  const nextCursor = nextOffset < allRows.length ? encodeCursor(compositeRevision, nextOffset) : undefined;

  // Light list-served audit (the authorization-decision audit already fired in
  // the gate; this records the served list for forensics).
  await deps.audit({
    resourceType: "connector_instance",
    resourceId: effectiveInstanceId,
    operation: primitiveName,
    decision: "allowed",
    actorPrincipalId: input.actor.userId,
    organizationId: input.actor.orgId,
    ...(input.causation ? { causation: input.causation } : {}),
    metadata: {
      connectorKey: input.connectorKey,
      total: allRows.length,
      returned: pageRows.length,
      catalogRevision: compositeRevision,
    },
  });

  return {
    tools: pageRows,
    ...(nextCursor ? { nextCursor } : {}),
    catalogRevision: compositeRevision,
  };
}
