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
   * Runs ONLY after the gate (B2). Returns null when the instance is unresolvable. */
  resolveInstanceEndpoint: (
    connectorKey: string,
    instanceId: string,
  ) => Promise<ResolvedInstanceEndpoint | null>;
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

  return { effectiveInstanceId };
}

/** Acquire the instance's catalog snapshots (cache-first; populate the default
 * server on a miss). Runs ONLY after the gate (B2). Conservative freshness — S3
 * owns TTL/invalidation (N6). */
async function acquireSnapshots(
  input: { connectorKey: string; instanceId: string; endpoint: string; authHeader: string },
  deps: ConnectorInstanceInvokerDeps,
): Promise<CatalogServerSnapshot[]> {
  const cached = deps.cache.listForInstance(input.instanceId);
  if (cached.length > 0) return cached;
  // SECURITY (§10-A1 / R3-M3): the snapshot identity is the STABLE, host-owned
  // `CATALOG_DEFAULT_SERVER_ID` — NEVER a caller-supplied `serverId`. Minting the
  // default catalog under a caller-picked id would let a caller forge a
  // `{serverId,name}` policy key that no deny entry matches (policy bypass). A
  // caller `serverId` is a downstream FILTER only (resolveToolAcrossServers /
  // the list `scoped` filter); an unenrolled id therefore resolves to
  // `tool_not_found`, never a mis-tagged catalog. S3 owns real multi-server
  // enrollment + host-generated ids.
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
  const wire =
    snapshot.exposureMode === "triad-only"
      ? { name: TRIAD_EXECUTE_ABILITY, arguments: { ability_name: name, parameters: input.args } }
      : { name, arguments: input.args };
  let result: unknown;
  let outcome: "allowed" | "denied" = "allowed";
  try {
    result = await deps.callWireTool({
      endpoint: resolved.endpoint,
      authHeader: resolved.authHeader,
      name: wire.name,
      arguments: wire.arguments,
    });
  } catch (err) {
    outcome = "denied";
    // Step 5 — execution audit (failure). Then re-throw the typed error.
    await deps.audit({
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
  await deps.audit({
    resourceType: "connector_instance",
    resourceId: effectiveInstanceId,
    operation: primitiveName,
    decision: outcome,
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
