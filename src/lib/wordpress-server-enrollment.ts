import "server-only";

// WordPress multi-server enrollment lifecycle (cinatra#2018 S3): the pure-core,
// idempotent DIFF application of a VERIFIED `wp-site-inventory` payload onto the
// host-owned `connector_instance_server` rows, plus the org-admin manual-route
// machinery and the S7-facing health-refresh read. All DB access goes through an
// INJECTED store surface (unit-testable without a DB); the boot binder
// (`register-host-connector-services.ts`) wires the real store + cache/probe
// invalidation via `createWordPressServerEnrollmentDeps`.
//
// Lifecycle rules (the reconciliation contract):
//  - The enrichment payload is the ENUMERATION AUTHORITY for `discovered` rows:
//    add / update / retire follow the payload; a discovered server absent from
//    an accepted payload retires (tools fail closed via the invoker's
//    enrolled-only acquire filter).
//  - `manual` rows are NEVER touched by reconciliation (clobber-protection,
//    enforced here AND at the store layer).
//  - The `default` row is always enrolled and never retires; a payload entry
//    for it refreshes display metadata only (route pinned).
//  - Identity keys on `adapterServerId` (host-digested `serverId`): a route
//    move updates the SAME row (caches invalidated, health/policy continuity);
//    identity-metadata changes (route/name/version) and retire→re-add revivals
//    emit audit events so an implementation swapped under a reused registry id
//    is operator-visible.
//  - Reported-but-ineligible servers persist as `present_unenrolled` with a
//    typed reason — surfaced, never silently dropped; the informational set has
//    replace semantics (absent entries are deleted, not tombstoned).

import { Buffer } from "node:buffer";
import type {
  WpSiteInventoryServerEntryV1,
  WpSiteInventoryV1,
} from "@/lib/wordpress-site-inventory-contract";
import {
  CATALOG_DEFAULT_SERVER_ID,
  DEFAULT_SERVER_REST_PATH,
  SYSTEM_SERVER_ENROLLMENT_ACTOR,
  deleteManualServer,
  deletePresentUnenrolledServer,
  ensureDefaultServerEnrollment,
  listInstanceServers,
  normalizeRestPath,
  recordServerStatus,
  resolveServerId,
  retireServer,
  upsertServer,
  type ConnectorInstanceServerRecord,
  type ServerExposureMode,
  type ServerHealthStatus,
  type UpsertServerInput,
} from "@/lib/connector-instance-server-store";
import { classifyExposureModeFromWireTools } from "@/lib/connector-instance-snapshot-loader";
import {
  probeWordPressInstanceMcpServer,
  resolveWordPressMcpFallbackEndpoint,
  type WordPressMcpAdapterStatus,
  type WordPressMcpProbeTarget,
} from "@/lib/wordpress-mcp-connection";
import {
  InvokerError,
  listConnectorInstanceMcpTools,
} from "@/lib/connector-instance-mcp-transport";
import { logAuditEvent } from "@/lib/authz/audit";

// ---------------------------------------------------------------------------
// Ordering / anti-replay acceptance rule (pure)
// ---------------------------------------------------------------------------

/**
 * The `(credentialVersion, inventorySeq)` acceptance rule, as a PURE function:
 * accept iff the presented pair is STRICTLY newer than the stored one —
 * a higher credential generation (epoch reset on rotation: the sequence may
 * restart), or the same generation with a strictly higher sequence. `stored`
 * null (no inventory ever accepted) always accepts. The durable enforcement is
 * the store's atomic conditional-advance upsert (`tryAdvanceSiteInventory`);
 * this function is the same predicate for callers/tests that reason about it
 * without a database.
 */
export function isSiteInventoryStrictlyNewer(
  presented: { credentialVersion: number; inventorySeq: number },
  stored: { credentialVersion: number; inventorySeq: number } | null,
): boolean {
  if (!stored) return true;
  if (presented.credentialVersion > stored.credentialVersion) return true;
  return (
    presented.credentialVersion === stored.credentialVersion &&
    presented.inventorySeq > stored.inventorySeq
  );
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** The store surface the reconciler composes (pre-bound; tests inject fakes). */
export type WordPressServerEnrollmentStore = {
  listInstanceServers(
    connectorKey: string,
    instanceId: string,
  ): Promise<ConnectorInstanceServerRecord[]>;
  ensureDefaultServerEnrollment(input: {
    connectorKey: string;
    instanceId: string;
  }): Promise<{ created: boolean }>;
  upsertServer(input: UpsertServerInput): Promise<{ written: boolean }>;
  retireServer(
    connectorKey: string,
    instanceId: string,
    serverId: string,
  ): Promise<{ retired: boolean }>;
  deletePresentUnenrolledServer(
    connectorKey: string,
    instanceId: string,
    serverId: string,
  ): Promise<{ deleted: boolean }>;
  deleteManualServer(
    connectorKey: string,
    instanceId: string,
    serverId: string,
  ): Promise<{ deleted: boolean }>;
  recordServerStatus(input: {
    connectorKey: string;
    instanceId: string;
    serverId: string;
    status: ServerHealthStatus;
  }): Promise<void>;
};

/** Manual-route verification wire surface (injected; tests fake the wire). */
export type WordPressManualRouteVerifier = {
  /** HEAD probe (pretty → query-string fallback) at the candidate route. */
  probeServer(
    target: WordPressMcpProbeTarget,
    restPath: string,
  ): Promise<WordPressMcpAdapterStatus>;
  /** REAL MCP handshake + wire `tools/list` through the S2 transport with the
   * instance credential — proves the route speaks Streamable-HTTP MCP AND
   * accepts the connection App-Password; the rows classify exposure mode. */
  listTools(input: {
    endpoint: string;
    authHeader: string;
  }): Promise<Array<Record<string, unknown>>>;
};

export type WordPressServerEnrollmentDeps = {
  store: WordPressServerEnrollmentStore;
  /** Per-server cache + probe invalidation, bound by the host binder (§6). */
  onServerInvalidated?: (instanceId: string, serverId: string) => void;
  /** Resolve the instance's probe/credential target (manual verification +
   * health refresh). Null when the instance/credential is unresolvable. */
  resolveInstance?: (instanceId: string) => WordPressMcpProbeTarget | null;
  verifier?: WordPressManualRouteVerifier;
  audit?: (event: Parameters<typeof logAuditEvent>[0]) => Promise<void> | void;
  now?: () => number;
  /** Health-refresh debounce override (tests). Default 60 s. */
  healthRefreshDebounceMs?: number;
};

/**
 * The production deps: the real store module, the real probe/transport
 * verifier, the host audit log. The binder supplies only the cache/probe
 * invalidation callback and the instance resolver (both live host-side).
 */
export function createWordPressServerEnrollmentDeps(input: {
  onServerInvalidated?: (instanceId: string, serverId: string) => void;
  resolveInstance?: (instanceId: string) => WordPressMcpProbeTarget | null;
}): WordPressServerEnrollmentDeps {
  return {
    store: {
      listInstanceServers: (connectorKey, instanceId) =>
        listInstanceServers(connectorKey, instanceId),
      ensureDefaultServerEnrollment: (i) => ensureDefaultServerEnrollment(i),
      upsertServer: (i) => upsertServer(i),
      retireServer: (connectorKey, instanceId, serverId) =>
        retireServer(connectorKey, instanceId, serverId),
      deletePresentUnenrolledServer: (connectorKey, instanceId, serverId) =>
        deletePresentUnenrolledServer(connectorKey, instanceId, serverId),
      deleteManualServer: (connectorKey, instanceId, serverId) =>
        deleteManualServer(connectorKey, instanceId, serverId),
      recordServerStatus: (i) => recordServerStatus(i),
    },
    verifier: {
      probeServer: (target, restPath) => probeWordPressInstanceMcpServer(target, restPath),
      listTools: (i) => listConnectorInstanceMcpTools(i),
    },
    ...(input.onServerInvalidated ? { onServerInvalidated: input.onServerInvalidated } : {}),
    ...(input.resolveInstance ? { resolveInstance: input.resolveInstance } : {}),
  };
}

function resolveAudit(deps: WordPressServerEnrollmentDeps) {
  return deps.audit ?? ((event: Parameters<typeof logAuditEvent>[0]) => logAuditEvent(event));
}

// ---------------------------------------------------------------------------
// applySiteInventory — the reconciler
// ---------------------------------------------------------------------------

export type ApplySiteInventoryInput = {
  connectorKey: string;
  instanceId: string;
  /** A contract-PARSED payload (the intake route / tests parse via
   * `wpSiteInventoryV1Schema` — the reconciler never re-validates). */
  payload: WpSiteInventoryV1;
  /** Verified intake provenance (audit metadata only). */
  siteId?: string;
  origin?: string;
};

export type ApplySiteInventoryResult = {
  /** Payload entries now enrolled (incl. a default-server entry if reported). */
  enrolled: number;
  /** Payload entries persisted present-not-enrolled (typed reason). */
  presentUnenrolled: number;
  /** Previously discovered servers retired by THIS payload's absence. */
  retired: number;
};

function isDefaultServerEntry(entry: WpSiteInventoryServerEntryV1): boolean {
  return entry.isDefault || entry.restPath === DEFAULT_SERVER_REST_PATH;
}

/**
 * Diff-apply an accepted inventory payload. Idempotent: re-applying the same
 * payload converges to the same rows. Only `discovered` rows are ever added /
 * updated / retired here; `manual` rows are untouched and the `default` row
 * only receives a display-metadata refresh. Callers own the anti-replay gate
 * (the intake route runs the atomic conditional advance BEFORE this).
 */
export async function applySiteInventory(
  input: ApplySiteInventoryInput,
  deps: WordPressServerEnrollmentDeps,
): Promise<ApplySiteInventoryResult> {
  const { connectorKey, instanceId, payload } = input;
  const audit = resolveAudit(deps);
  const nowIso = new Date(deps.now?.() ?? Date.now()).toISOString();

  // Step 1 — the default row exists no matter what the payload says
  // ("default always enrolled"; also the shared first-touch backstop core).
  await deps.store.ensureDefaultServerEnrollment({ connectorKey, instanceId });
  const existing = await deps.store.listInstanceServers(connectorKey, instanceId);
  const discoveredByAdapterId = new Map<string, ConnectorInstanceServerRecord>();
  for (const row of existing) {
    if (row.source === "discovered" && row.adapterServerId) {
      discoveredByAdapterId.set(row.adapterServerId, row);
    }
  }
  const takenIds = new Set(existing.map((row) => row.serverId));

  let enrolled = 0;
  let presentUnenrolled = 0;
  let retired = 0;
  const reportedAdapterIds = new Set<string>();

  for (const entry of payload.servers) {
    reportedAdapterIds.add(entry.adapterServerId);

    // --- default server: metadata refresh only (route + exposure pinned) ----
    if (isDefaultServerEntry(entry)) {
      const defaultRow = existing.find((row) => row.serverId === CATALOG_DEFAULT_SERVER_ID);
      await deps.store.upsertServer({
        connectorKey,
        instanceId,
        serverId: CATALOG_DEFAULT_SERVER_ID,
        source: "default",
        status: "enrolled",
        restPath: DEFAULT_SERVER_REST_PATH,
        adapterServerId: entry.adapterServerId,
        namespace: entry.namespace,
        route: entry.route,
        label: entry.name,
        serverVersion: entry.version ?? null,
        transports: entry.transports,
        exposureMode: "triad-only",
        unenrolledReason: null,
        enrolledAt: defaultRow?.enrolledAt ?? nowIso,
        retiredAt: null,
        verifiedAt: nowIso,
        lastStatus: defaultRow?.lastStatus ?? null,
        lastStatusAt: defaultRow?.lastStatusAt ?? null,
        createdBy: defaultRow?.createdBy ?? SYSTEM_SERVER_ENROLLMENT_ACTOR,
      });
      enrolled += 1;
      continue;
    }

    const eligible =
      entry.transports.includes("streamable-http") && !entry.requiresDedicatedAuth;
    const match = discoveredByAdapterId.get(entry.adapterServerId);

    // --- ineligible: surfaced present_unenrolled, never silently dropped ----
    if (!eligible) {
      const reason = !entry.transports.includes("streamable-http")
        ? ("custom_transport" as const)
        : ("custom_auth" as const);
      const serverId =
        match?.serverId ??
        resolveServerId(
          { kind: "discovered", instanceId, adapterServerId: entry.adapterServerId },
          (candidate) => takenIds.has(candidate),
        );
      takenIds.add(serverId);
      const wasEnrolled = match?.status === "enrolled";
      const { written } = await deps.store.upsertServer({
        connectorKey,
        instanceId,
        serverId,
        source: "discovered",
        status: "present_unenrolled",
        adapterServerId: entry.adapterServerId,
        namespace: entry.namespace,
        route: entry.route,
        restPath: entry.restPath,
        label: entry.name,
        serverVersion: entry.version ?? null,
        transports: entry.transports,
        exposureMode: match?.exposureMode ?? null,
        unenrolledReason: reason,
        enrolledAt: null,
        retiredAt: null,
        verifiedAt: nowIso,
        lastStatus: match?.lastStatus ?? null,
        lastStatusAt: match?.lastStatusAt ?? null,
        createdBy: match?.createdBy ?? SYSTEM_SERVER_ENROLLMENT_ACTOR,
      });
      if (written) presentUnenrolled += 1;
      // Leaving the enrolled set ⇒ its snapshot must die with it (fail closed
      // beats the cache either way; eviction is the hygiene layer).
      if (written && wasEnrolled) deps.onServerInvalidated?.(instanceId, serverId);
      continue;
    }

    // --- eligible, no prior identity: enroll fresh (verified-intake) --------
    if (!match) {
      const serverId = resolveServerId(
        { kind: "discovered", instanceId, adapterServerId: entry.adapterServerId },
        (candidate) => takenIds.has(candidate),
      );
      takenIds.add(serverId);
      const { written } = await deps.store.upsertServer({
        connectorKey,
        instanceId,
        serverId,
        source: "discovered",
        status: "enrolled",
        adapterServerId: entry.adapterServerId,
        namespace: entry.namespace,
        route: entry.route,
        restPath: entry.restPath,
        label: entry.name,
        serverVersion: entry.version ?? null,
        transports: entry.transports,
        exposureMode: null,
        unenrolledReason: null,
        enrolledAt: nowIso,
        retiredAt: null,
        verifiedAt: nowIso,
        lastStatus: null,
        lastStatusAt: null,
        createdBy: SYSTEM_SERVER_ENROLLMENT_ACTOR,
      });
      if (written) enrolled += 1;
      continue;
    }

    // --- eligible, same identity: update / revive on the SAME row -----------
    const wasRetired = match.status === "retired";
    const stayedEnrolled = match.status === "enrolled";
    const restPathChanged = match.restPath !== entry.restPath;
    const changed: string[] = [];
    if (restPathChanged || match.route !== entry.route || match.namespace !== entry.namespace) {
      changed.push("route");
    }
    if ((match.label ?? null) !== entry.name) changed.push("name");
    if ((match.serverVersion ?? null) !== (entry.version ?? null)) changed.push("version");

    const { written } = await deps.store.upsertServer({
      connectorKey,
      instanceId,
      serverId: match.serverId,
      source: "discovered",
      status: "enrolled",
      adapterServerId: entry.adapterServerId,
      namespace: entry.namespace,
      route: entry.route,
      restPath: entry.restPath,
      label: entry.name,
      serverVersion: entry.version ?? null,
      transports: entry.transports,
      exposureMode: match.exposureMode,
      unenrolledReason: null,
      enrolledAt: stayedEnrolled ? match.enrolledAt : nowIso,
      retiredAt: null,
      verifiedAt: nowIso,
      lastStatus: match.lastStatus,
      lastStatusAt: match.lastStatusAt,
      createdBy: match.createdBy,
    });
    if (!written) continue;
    enrolled += 1;
    if (wasRetired) {
      await audit({
        resourceType: "connector_instance",
        resourceId: instanceId,
        actorPrincipalType: "system",
        authSource: "worker",
        operation: "server_reenrolled",
        decision: "allowed",
        policyVersion: "connector-instance-server-enrollment",
        metadata: {
          connectorKey,
          serverId: match.serverId,
          adapterServerId: entry.adapterServerId,
          ...(input.siteId ? { siteId: input.siteId } : {}),
        },
      });
    }
    if (changed.length > 0) {
      // Operator-visible trail for an implementation swapped/moved under a
      // reused registry id (policy refs persist across the change by design).
      await audit({
        resourceType: "connector_instance",
        resourceId: instanceId,
        actorPrincipalType: "system",
        authSource: "worker",
        operation: "server_identity_metadata_changed",
        decision: "allowed",
        policyVersion: "connector-instance-server-enrollment",
        metadata: {
          connectorKey,
          serverId: match.serverId,
          adapterServerId: entry.adapterServerId,
          changed,
          ...(input.siteId ? { siteId: input.siteId } : {}),
        },
      });
    }
    if (restPathChanged) deps.onServerInvalidated?.(instanceId, match.serverId);
  }

  // --- retire pass: discovered rows absent from THIS payload ----------------
  // (`manual` and `default` rows are NEVER touched; retired rows stay retired.)
  for (const row of existing) {
    if (row.source !== "discovered") continue;
    if (row.adapterServerId && reportedAdapterIds.has(row.adapterServerId)) continue;
    if (row.status === "enrolled") {
      const result = await deps.store.retireServer(connectorKey, instanceId, row.serverId);
      if (result.retired) {
        retired += 1;
        deps.onServerInvalidated?.(instanceId, row.serverId);
      }
    } else if (row.status === "present_unenrolled") {
      // Informational set: replace semantics (no tombstone).
      await deps.store.deletePresentUnenrolledServer(connectorKey, instanceId, row.serverId);
    }
  }

  return { enrolled, presentUnenrolled, retired };
}

// ---------------------------------------------------------------------------
// Manual routes (org-admin, probe-verified — the S7 controls consume these)
// ---------------------------------------------------------------------------

/** Manual-route path shape: leading slash, alnum first segment char, then the
 * conservative REST-path charset. No `?` / `#` / dots (so no `..` and no
 * `.php`) by construction. */
export const MANUAL_SERVER_REST_PATH_PATTERN = /^\/[a-z0-9][a-z0-9/_-]{0,127}$/i;

export type AddManualServerRouteInput = {
  connectorKey: string;
  instanceId: string;
  /** A REST path (`/{namespace}/{route}`) or a pasted same-site URL (reduced
   * to its path; a `/wp-json` prefix is stripped so a copied pretty-permalink
   * endpoint URL resolves to the canonical REST path). */
  restPath: string;
  /** The acting org-admin user id (recorded as `created_by`). */
  actor: string;
};

export type AddManualServerRouteResult =
  | { ok: true; serverId: string; restPath: string; exposureMode: ServerExposureMode }
  | {
      ok: false;
      reason:
        | "invalid_path"
        | "foreign_origin"
        | "reserved_route"
        | "instance_unresolvable"
        | "probe_failed"
        | "verification_failed";
      probeStatus?: WordPressMcpAdapterStatus;
      errorCode?: string;
    };

function buildBasicAuthHeader(target: WordPressMcpProbeTarget): string {
  const credentials = `${target.username}:${target.applicationPassword}`;
  return `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
}

/** Reduce a pasted same-site URL to its REST path; typed rejection otherwise.
 * Only an EXACT origin match against the instance siteUrl is accepted — a
 * manual route can never point at a foreign host. */
function reduceManualRouteInput(
  raw: string,
  siteUrl: string,
): { ok: true; path: string } | { ok: false; reason: "invalid_path" | "foreign_origin" } {
  if (!/^https?:\/\//i.test(raw)) return { ok: true, path: raw };
  let parsed: URL;
  let site: URL;
  try {
    parsed = new URL(raw);
    site = new URL(siteUrl);
  } catch {
    return { ok: false, reason: "invalid_path" };
  }
  if (parsed.origin !== site.origin) return { ok: false, reason: "foreign_origin" };
  if (parsed.search || parsed.hash) return { ok: false, reason: "invalid_path" };
  // A copied pretty-permalink endpoint URL carries the `/wp-json` REST base;
  // the canonical REST path is what follows it.
  const path = parsed.pathname.startsWith("/wp-json/")
    ? parsed.pathname.slice("/wp-json".length)
    : parsed.pathname;
  return { ok: true, path };
}

/**
 * Verify-then-enroll a manual server route. STRICT precondition ordering —
 * NOTHING is persisted unless every step passes:
 *  1. path shape (allowlist charset; same-origin URL reduction only),
 *  2. HEAD probe at the route (pretty → fallback form),
 *  3. a REAL MCP handshake + wire `tools/list` with the instance credential
 *     (proves "Streamable-HTTP MCP server accepting the connection
 *     App-Password" and classifies exposure mode in the same shot).
 * Idempotent re-add of the same path re-verifies and refreshes the SAME row
 * (the manual digest identity), preserving `created_by`.
 */
export async function addManualServerRoute(
  input: AddManualServerRouteInput,
  deps: WordPressServerEnrollmentDeps,
): Promise<AddManualServerRouteResult> {
  const audit = resolveAudit(deps);
  const { connectorKey, instanceId } = input;
  const target = deps.resolveInstance?.(instanceId) ?? null;
  if (!target?.siteUrl || !target.username || !target.applicationPassword) {
    return { ok: false, reason: "instance_unresolvable" };
  }

  const reduced = reduceManualRouteInput(input.restPath.trim(), target.siteUrl);
  if (!reduced.ok) return { ok: false, reason: reduced.reason };
  if (reduced.path.includes("?") || reduced.path.includes("#")) {
    return { ok: false, reason: "invalid_path" };
  }
  // Shape-validate the SUPPLIED path (leading slash required — never inferred),
  // THEN canonicalize for the digest/storage form (trailing-slash trim only,
  // which cannot leave the validated shape).
  if (!MANUAL_SERVER_REST_PATH_PATTERN.test(reduced.path)) {
    return { ok: false, reason: "invalid_path" };
  }
  const restPath = normalizeRestPath(reduced.path);
  if (restPath === DEFAULT_SERVER_REST_PATH) {
    // The default server is always enrolled — a second row for its route
    // would shadow the grandfathered identity.
    return { ok: false, reason: "reserved_route" };
  }
  if (!deps.verifier) return { ok: false, reason: "verification_failed" };

  const probeStatus = await deps.verifier.probeServer(target, restPath);
  if (probeStatus !== "registered") {
    return { ok: false, reason: "probe_failed", probeStatus };
  }

  const endpoint = resolveWordPressMcpFallbackEndpoint(target.siteUrl, restPath);
  const authHeader = buildBasicAuthHeader(target);
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await deps.verifier.listTools({ endpoint, authHeader });
  } catch (err) {
    return {
      ok: false,
      reason: "verification_failed",
      ...(err instanceof InvokerError ? { errorCode: err.code } : {}),
    };
  }
  const exposureMode = classifyExposureModeFromWireTools(rows);

  const nowIso = new Date(deps.now?.() ?? Date.now()).toISOString();
  const existing = await deps.store.listInstanceServers(connectorKey, instanceId);
  const existingManual = existing.find(
    (row) => row.source === "manual" && row.restPath === restPath,
  );
  const serverId =
    existingManual?.serverId ??
    resolveServerId({ kind: "manual", instanceId, restPath }, (candidate) =>
      existing.some(
        (row) => row.serverId === candidate && !(row.source === "manual" && row.restPath === restPath),
      ),
    );

  await deps.store.upsertServer({
    connectorKey,
    instanceId,
    serverId,
    source: "manual",
    status: "enrolled",
    restPath,
    adapterServerId: null,
    namespace: null,
    route: null,
    label: existingManual?.label ?? null,
    serverVersion: null,
    // Operationally proven by the verification handshake just performed.
    transports: ["streamable-http"],
    exposureMode,
    unenrolledReason: null,
    enrolledAt:
      existingManual && existingManual.status === "enrolled"
        ? existingManual.enrolledAt
        : nowIso,
    retiredAt: null,
    verifiedAt: nowIso,
    lastStatus: "registered",
    lastStatusAt: nowIso,
    createdBy: existingManual?.createdBy ?? input.actor,
  });
  deps.onServerInvalidated?.(instanceId, serverId);
  await audit({
    resourceType: "connector_instance",
    resourceId: instanceId,
    actorPrincipalType: "human",
    actorPrincipalId: input.actor,
    authSource: "ui",
    operation: "server_manual_enrolled",
    decision: "allowed",
    policyVersion: "connector-instance-server-enrollment",
    metadata: { connectorKey, serverId, restPath, exposureMode },
  });
  return { ok: true, serverId, restPath, exposureMode };
}

export type RemoveManualServerRouteInput = {
  connectorKey: string;
  instanceId: string;
  serverId: string;
  actor: string;
};

export type RemoveManualServerRouteResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "not_manual" };

/** Delete a MANUAL server row (hard delete — a manual route's identity is its
 * route). Discovered/default rows are refused here AND at the store layer. */
export async function removeManualServerRoute(
  input: RemoveManualServerRouteInput,
  deps: WordPressServerEnrollmentDeps,
): Promise<RemoveManualServerRouteResult> {
  const audit = resolveAudit(deps);
  const { connectorKey, instanceId, serverId } = input;
  const existing = await deps.store.listInstanceServers(connectorKey, instanceId);
  const row = existing.find((r) => r.serverId === serverId);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.source !== "manual") return { ok: false, reason: "not_manual" };
  const { deleted } = await deps.store.deleteManualServer(connectorKey, instanceId, serverId);
  if (!deleted) return { ok: false, reason: "not_found" };
  deps.onServerInvalidated?.(instanceId, serverId);
  await audit({
    resourceType: "connector_instance",
    resourceId: instanceId,
    actorPrincipalType: "human",
    actorPrincipalId: input.actor,
    authSource: "ui",
    operation: "server_manual_removed",
    decision: "allowed",
    policyVersion: "connector-instance-server-enrollment",
    metadata: { connectorKey, serverId, restPath: row.restPath },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// S7-facing read + debounced health refresh
// ---------------------------------------------------------------------------

/** Settings-visit health-refresh debounce (per instance, in-process). */
export const SERVER_HEALTH_REFRESH_DEBOUNCE_MS = 60_000;

const healthRefreshLastRunAt = new Map<string, number>();

async function refreshEnrolledServerHealth(
  input: { connectorKey: string; instanceId: string },
  rows: ConnectorInstanceServerRecord[],
  deps: WordPressServerEnrollmentDeps,
): Promise<void> {
  const target = deps.resolveInstance?.(input.instanceId) ?? null;
  if (!target?.siteUrl || !target.username || !target.applicationPassword) return;
  if (!deps.verifier) return;
  for (const row of rows) {
    if (row.status !== "enrolled") continue;
    const status = await deps.verifier.probeServer(target, row.restPath);
    await deps.store.recordServerStatus({
      connectorKey: input.connectorKey,
      instanceId: input.instanceId,
      serverId: row.serverId,
      status,
    });
  }
}

/**
 * The S7-facing read: the full row set (enrolled + present_unenrolled +
 * retired) for an instance's health/catalog matrix. A settings visit through
 * this member ALSO re-verifies KNOWN enrolled rows' probe health in the
 * background (fire-and-forget; 60 s per-instance debounce) — cinatra cannot
 * re-enumerate servers without the site, but it can keep the health column
 * honest between enrichment pushes. The returned rows are the CURRENT store
 * state; a refreshed verdict lands on the next read.
 */
export async function listInstanceServersWithHealthRefresh(
  input: { connectorKey: string; instanceId: string },
  deps: WordPressServerEnrollmentDeps,
): Promise<ConnectorInstanceServerRecord[]> {
  const rows = await deps.store.listInstanceServers(input.connectorKey, input.instanceId);
  const key = `${input.connectorKey}::${input.instanceId}`;
  const now = deps.now?.() ?? Date.now();
  const debounceMs = deps.healthRefreshDebounceMs ?? SERVER_HEALTH_REFRESH_DEBOUNCE_MS;
  const lastRunAt = healthRefreshLastRunAt.get(key) ?? Number.NEGATIVE_INFINITY;
  if (now - lastRunAt >= debounceMs && deps.resolveInstance && deps.verifier) {
    healthRefreshLastRunAt.set(key, now);
    void refreshEnrolledServerHealth(input, rows, deps).catch((err) => {
      console.error(
        `[wordpress-server-enrollment] health refresh failed for ${input.instanceId}`,
        err,
      );
    });
  }
  return rows;
}

/** Test-only: reset the in-process health-refresh debounce state. */
export function __resetServerHealthRefreshDebounceForTests(): void {
  healthRefreshLastRunAt.clear();
}
