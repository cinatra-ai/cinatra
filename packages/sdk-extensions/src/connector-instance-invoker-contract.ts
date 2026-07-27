// TYPE-ONLY host-capability contract for the governed connector-instance invoker
// (cinatra#2017 S2, gateway PR-2 core slice K1 — the CORE half).
//
// This is the shared, SDK-published mirror of the shape PR-1 VENDORED inside the
// connector (`wordpress-mcp-connector/src/mcp/invoker-contract.ts`). It is
// TYPE-ONLY plus the capability-id constant (the id lives on
// `HOST_CONNECTOR_SERVICE_CAPABILITIES.connectorInstanceInvoker`, fenced behind
// the `./internal` value subpath like every other host id). The connector
// follow-up PR (C3, merges THIRD after this core PR lands + publishes the
// contract) swaps its vendored copy for these exports — a pure type/import swap,
// no behavior change, because the shapes are structurally identical.
//
// SECURITY SHAPE (M6 / R2-B1): the connector-facing methods carry NO
// `connectorKey` and NO `kind` selector. `connectorKey` is derived HOST-SIDE
// from the verified calling-connector identity (its `packageName`, or the
// host-minted enqueue binding on the job path) inside the published host
// capability — there is no connector-visible selector to mis-name. Identity
// (actor) is likewise host-derived from the active MCP request frame; the
// connector passes only the non-identity call coordinates.

/**
 * The normalized, signed connector-instance pin (D6/B1). Minted host-side onto
 * the agent-run OBO token (`pin:{ck,iid}`) and carried natively by the widget
 * token (`inst`/`knd`); both are NORMALIZED into this one shape at the MCP
 * transport boundary. The invoker asserts `pin.connectorKey === boundConnectorKey`
 * and derives `effectiveInstanceId = input.instanceId ?? pin.instanceId` (§1.2
 * step 0). Absent ⇒ org scope (an explicit `instanceId` is then required).
 */
export type ConnectorInstancePin = {
  connectorKey: string;
  instanceId: string;
};

/** The resolved, server-qualified identity of a single tool (§2.6/§3.6, R2-M3).
 * `serverId` is a STABLE, OPAQUE, host-owned id (§10-A1) — never endpoint-,
 * URL-, or normalized-name-derived; `name` is the (slash-bearing on triad
 * servers) ability id / tool name. Policy allow/deny entries key on this pair. */
export type SiteToolRef = {
  serverId: string;
  name: string;
};

/** Per-instance policy mode (§2.6/§10-A3). `open` = allow all except `deny`;
 * `restricted` = allow ONLY `allow` minus `deny` (empty `allow` ⇒ deny-all). */
export type InstanceToolPolicyMode = "open" | "restricted";

/**
 * A persisted per-`(connectorKey, instanceId)` policy record (§2.6/§10-A3).
 * Server-qualified allow/deny (R2-M3). Written explicitly at instance creation
 * (`mode:"open"`), by the deploy-gated reconcile, and by the lazy first-touch
 * backstop; an ABSENT record is a compatibility fallback (open) only, never the
 * normal migrated state.
 */
export type InstanceToolPolicyRecord = {
  connectorKey: string;
  instanceId: string;
  mode: InstanceToolPolicyMode;
  allow?: SiteToolRef[];
  deny?: SiteToolRef[];
  updatedBy: string;
  updatedAt: string;
};

/**
 * Input to a single governed site-tool call (the `wordpress_site_tool_call`
 * primitive's forwarded coordinates). NO `connectorKey` / `kind` (M6).
 */
export type SiteToolCallInput = {
  /**
   * The tool to invoke. On a triad-only server this is the INNER ability id,
   * which may carry a slash (e.g. `ewpa/create-post`, `core/get-site-info`).
   */
  toolName: string;
  /**
   * Arguments forwarded to the resolved tool's advertised schema UNMODIFIED
   * (§3.7). An empty object is a valid no-arg call (e.g. a discover-style tool).
   */
  args: Record<string, unknown>;
  /**
   * Target connected-site instance. OPTIONAL: required only when the caller's
   * session is not pinned to a single instance (org scope). When the actor
   * carries a signed instance pin, an omitted value resolves to the pinned id
   * host-side; a supplied value must equal the pin or the host rejects it.
   */
  instanceId?: string;
  /**
   * Target MCP server. OPTIONAL: required only when `toolName` is non-unique
   * across the instance's enrolled servers. An OPAQUE, host-owned identity
   * (§10-A1) — never endpoint- or name-derived; the connector forwards it
   * verbatim and never mints one.
   */
  serverId?: string;
};

/**
 * Input to the governed `tools_list` surface (the `wordpress_site_tools_list`
 * primitive's forwarded coordinates). NO `connectorKey` / `kind` (M6). The host
 * runs the SAME pin + live per-instance USE authority gate BEFORE any catalog
 * read (codex B2), so an unauthorized list yields a typed error, never a catalog.
 */
export type SiteToolsListInput = {
  /** Target instance — OPTIONAL, same pin semantics as `SiteToolCallInput`. */
  instanceId?: string;
  /** Target server — OPTIONAL opaque host-owned id (§10-A1), forwarded verbatim. */
  serverId?: string;
  /**
   * Revision-pinned pagination cursor (§3.5). A cursor minted against one catalog
   * snapshot pages consistently over it; a stale cursor is rejected host-side.
   */
  cursor?: string;
};

/** Classifier verdict for a listed tool — advisory only (destructive > write >
 * read, §3.4); never gates availability. */
export type SiteToolDerivedClass = "read" | "write" | "destructive";

/** Per-instance policy verdict for a listed tool (§2.6). In `restricted` mode a
 * denied tool is still LISTED and MARKED — the list is never shortened (§3.5). */
export type SiteToolPolicyStatus = "allowed" | "denied";

/**
 * One row of the governed `tools_list` (§3.5 frozen contract + §10-A2). Every
 * field is host-composed and pass-through verbatim; the connector never rewrites
 * a row. STRUCTURALLY IDENTICAL to the connector's vendored `SiteToolRow`.
 */
export type SiteToolRow = {
  /** Tool / ability id (slash-bearing on triad servers, §3.1). */
  name: string;
  /** STABLE, OPAQUE, host-owned server identity (§10-A1) — NOT endpoint-, URL-,
   * or normalized-name-derived. The stable sort key is `(serverId, name)`. */
  serverId: string;
  /** JSON Schema for the tool's arguments, verbatim from the site (A2, required —
   * gives a caller the schema needed to call an arbitrary tool). */
  inputSchema: unknown;
  /** JSON Schema for the tool's result, when the site supplies one (A2). */
  outputSchema?: unknown;
  /** Human-readable label, verbatim (A2). */
  label?: string;
  /** Human-readable description, verbatim (A2). */
  description?: string;
  /** Raw MCP annotation hints as carried by the site (advisory input, §3.4).
   * PRESENT on every row per the §3.5 frozen contract — an unannotated tool
   * carries `{}` (report-never-drop), never an omitted field. */
  rawAnnotations: Record<string, unknown>;
  /** Classifier verdict (advisory, §3.4). */
  derivedClass: SiteToolDerivedClass;
  /** Per-instance policy verdict for this row (§2.6). */
  policyStatus: SiteToolPolicyStatus;
  /** Age of the cached catalog snapshot in ms (§3.3/§3.5). */
  cacheAgeMs: number;
  /** The catalog snapshot revision this row was composed from (§3.5). */
  catalogRevision: string;
};

/**
 * A page of the governed `tools_list`. Uncapped pagination, no total ceiling
 * (§3.5): an absent `nextCursor` marks the last page.
 */
export type SiteToolsListPage = {
  tools: SiteToolRow[];
  /** Revision-pinned cursor for the next page (§3.5); absent = last page. */
  nextCursor?: string;
  /** The snapshot revision these rows were paged against (§3.5). */
  catalogRevision: string;
};

/**
 * The connector-facing shape of the governed invoker host capability
 * (`@cinatra-ai/host:connector-instance-invoker`). The host binds a
 * connector-SCOPED guard whose `connectorKey` is already derived from the
 * verified calling-connector identity (M6), so neither method takes a
 * `connectorKey` / `kind` argument. The connector resolves this via
 * `hostService<HostConnectorInstanceInvokerService>(ctx,
 * HOST_CONNECTOR_SERVICE_CAPABILITIES.connectorInstanceInvoker)`.
 *
 * STRUCTURALLY IDENTICAL to the connector's vendored
 * `LocalConnectorInstanceInvokerShape` (so C3's swap is a no-op).
 */
export type HostConnectorInstanceInvokerService = {
  /** Governed single-tool call → the tool's unwrapped result (structuredContent
   * preferred; typed errors thrown on failure). */
  invokeSiteTool: (input: SiteToolCallInput) => Promise<unknown>;
  /** Governed catalog listing (gate runs BEFORE any catalog read, B2). */
  listSiteTools: (input: SiteToolsListInput) => Promise<SiteToolsListPage>;
};
