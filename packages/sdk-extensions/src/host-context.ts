// ExtensionHostContext — the privileged port surface the host passes to an
// extension's `register(ctx)` hook.
//
// STATUS: ABI FROZEN. The port set below is derived EMPIRICALLY from the
// extension inventory of what extensions actually import from `@/`
// (45 distinct host modules across 21 connectors). FROZEN: no port may be added
// or changed without an SDK ABI MAJOR bump.
//
// The `telemetry` port (`HostTelemetryPort`, the inverted
// `@cinatra-ai/metric-usage-api` surface) carries the usage/cost events
// `apollo-connector` (and future metered connectors) emit. Adding a port is a
// breaking ABI change; server-entry extensions pinning `sdkAbiRange: "^1"` must
// be moved to `"^2"` or the loader would (correctly) skip them as
// ABI-incompatible.
//
// TYPE-MODEL DECISION (deliberate): `ExtensionHostContext` exposes ALL ports as
// required properties — an author sees the full surface and least-privilege is
// enforced at RUNTIME (the host's grant-aware factory fail-louds on an ungranted
// or unwired port; see src/lib/extension-host-context.ts). Compile-time grant
// typing (a ctx parameterized by the manifest's `requestedHostPorts`) is a
// possible future refinement; this keeps the surface simple + uniform with
// runtime enforcement.
//
// Decoupling principle: an extension reaches every privileged host capability
// THROUGH these ports — never via a `@/lib/*`, `@/components/*`,
// `@/app/*` import. Method signatures here are intentionally narrow and
// least-privilege; `db` in particular is the exceptional, scoped escape hatch,
// not the default data path (config → `settings`, credentials → `secrets`).
//
// This module is type-only and host-agnostic on purpose: the SDK contract
// package must not import host internals OR host-core sibling packages — an
// standalone companion extension repo peer-depends on `react`/`next`/
// `@cinatra-ai/sdk-*` only (see package.json), so host-specific shapes are kept
// opaque here and refined when the ABI freezes.

/**
 * Opaque scoped DB handle. Least-privilege; most extensions never need it.
 *
 * RESERVED — NOT wired yet. The host factory fail-louds on any access
 * (granted-but-not-implemented); no extension may declare
 * `requestedHostPorts: ["db"]` and rely on it yet. The runtime behind this port
 * — a scoped read surface over the extension's own tables (created by its
 * host-run node-pg-migrate migrations, #118) — is wired by a future release.
 *
 * The SDK ABI is ALREADY 2.0.0 (the `telemetry` port carries the 2.0 major). So
 * a future scoped `ctx.db` WRITE surface is an additive 2.x capability (a new
 * method behind a precise `sdkAbiRange` + grant) — or a 3.0 only if the `db`
 * port shape / privilege model changes. Writes must never be smuggled through
 * the read-only `query()`.
 */
export type HostDbPort = {
  /** Run a parameterized read within the extension's data scope. Reserved — not wired yet (a future release). */
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** The host schema the extension's host-run migrations target. Not wired yet (a future release). */
  readonly schema: string;
};

/** Non-secret per-extension / per-connector configuration persistence. */
export type HostSettingsPort = {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
};

/** Credential storage, deliberately separate from non-secret settings. */
export type HostSecretsPort = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

/** Nango OAuth gateway access (the `@/lib/nango` surface, inverted). */
export type HostNangoPort = {
  isConfigured(): Promise<boolean>;
  getConnection(connectionId: string, providerConfigKey: string): Promise<unknown>;
  ensureConnectSession(input: Record<string, unknown>): Promise<unknown>;
  /**
   * Render-time data getters for connector setup/settings pages (ABI 2.2.0,
   * additive/optional). A connector consumes these null-safe
   * (`ctx.nango.getStatus?.()`) so a host pinned to an older minor degrades
   * gracefully. `connectorKey` is `string` (the SDK does not import the host's
   * connector-roster union; the host narrows at the boundary).
   */
  getStatus?(): Promise<{ status: "connected" | "not_connected"; detail?: string }>;
  getFrontendConfig?(): Promise<{ apiURL?: string; baseURL?: string }>;
  getPrimarySavedConnection?(
    connectorKey: string,
    opts?: { scope?: "app" | "user"; userId?: string },
  ): Promise<{
    connectionId: string;
    providerConfigKey?: string;
    displayName?: string;
    email?: string;
  } | null>;
  getPrimarySavedConnections?(opts?: {
    scope?: "app" | "user";
    userId?: string;
  }): Promise<
    Record<
      string,
      {
        connectorKey: string;
        connectionId: string;
        providerConfigKey: string;
        connectedAt: string;
        scope?: "app" | "user";
        userId?: string;
        displayName?: string;
        email?: string;
        authMode?: string;
        metadata?: Record<string, unknown>;
      } | null
    >
  >;
  listConnectionRecords?(
    connectorKey: string,
  ): Promise<{ connectionId: string; metadata?: Record<string, unknown> }[]>;
};

/** Current actor / session (the `@/lib/auth-session` surface, inverted). */
export type HostAuthSessionPort = {
  getActor(): Promise<{
    userId: string | null;
    organizationId: string | null;
    orgRole: string | null;
  } | null>;
  requireOrganizationId(): Promise<string>;
};

/**
 * A tool an extension registers with the host MCP server via `ctx.mcp.registerTool`.
 * `handler` returns a PLAIN result (object/array/scalar); the host wraps it into
 * the MCP content/structuredContent envelope at replay time (arrays → `{ items }`,
 * objects → as-is, scalars → `{ result }`). `inputSchema` is an opaque
 * Standard Schema value (e.g. a zod schema — the MCP SDK validates against its
 * `~standard` interface); omit it for a no-argument tool (the host defaults to an
 * empty passthrough object). Typed `unknown` so the SDK stays leaf (no zod dep).
 */
export type HostMcpToolRegistration = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  handler: (input: unknown) => unknown | Promise<unknown>;
};

/** MCP tool registration + self-client + external-server registry. */
export type HostMcpPort = {
  registerTool(tool: HostMcpToolRegistration): void;
  callPrimitive(primitiveName: string, input: unknown): Promise<unknown>;
  listExternalServers(): Promise<unknown[]>;
  /**
   * The operator-configured public base URL of this deployment's MCP server, or
   * `null` when unset. Connector setup pages use it to render the public
   * `${publicBaseUrl}/api/mcp` endpoint for client configuration — without
   * importing host MCP internals (mirror-gate-safe: the host implements this
   * port, the connector only consumes `ctx.mcp.getPublicBaseUrl()`).
   */
  getPublicBaseUrl?(): Promise<{ publicBaseUrl: string | null }>;
};

/**
 * Object-type registration + object store + version history. `ioSpec` is kept
 * opaque (`unknown`) so the SDK contract does not depend on `@cinatra-ai/objects`
 * — the concrete `AgentIOSpec` shape is validated host-side at registration.
 */
export type HostObjectsPort = {
  registerType(descriptor: { typeId: string; ioSpec?: unknown; [k: string]: unknown }): void;
  read<T = unknown>(typeId: string, id: string): Promise<T | null>;
  write<T = unknown>(typeId: string, value: T): Promise<{ id: string }>;
  history(typeId: string, id: string): Promise<unknown[]>;
};

/** Background job enqueue + worker registration (the `@/lib/background-jobs` surface). */
export type HostJobsPort = {
  enqueue(jobName: string, payload: unknown, opts?: Record<string, unknown>): Promise<{ id: string }>;
  registerWorker(jobName: string, handler: (payload: unknown) => Promise<void>): void;
};

/** Host notification emission (the `@/lib/notifications` surface). */
export type HostNotificationsPort = {
  emit(input: { level: "info" | "warn" | "error"; title: string; body?: string }): Promise<void>;
};

/**
 * UI SURFACE registration — NOT a bag of host components. Visual primitives live
 * in `@cinatra-ai/sdk-ui` (a peerDependency); `ctx.ui` registers connector
 * setup/settings surfaces, schema-driven config, and named actions.
 */
export type HostUiPort = {
  registerSetupSurface(surface: unknown): void;
  registerSettingsSurface(surface: unknown): void;
  registerAction(action: { id: string; handler: (input: unknown) => Promise<unknown> }): void;
};

/** Structured logging scoped to the extension. */
export type HostLoggerPort = {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
};

/** Runtime mode / environment flags (the `@/lib/runtime-mode` surface). */
export type HostRuntimePort = {
  readonly mode: "development" | "production";
  flag(name: string): boolean;
  publicBaseUrl(): string | null;
};

/**
 * Capability / facade registration — connectors register providers behind a
 * capability facade (e.g. the email-send facade resolves gmail OR resend; the
 * capability-based dependency model). This is how a connector advertises what it
 * can DO without dependents pinning a concrete provider.
 */
export type HostCapabilitiesPort = {
  registerProvider(capability: string, provider: { packageName: string; impl: unknown }): void;
  resolveProviders(capability: string): { packageName: string; impl: unknown }[];
};

/**
 * A usage/cost telemetry event a connector emits through `ctx.telemetry`. This
 * MIRRORS the PUBLIC discriminated union of `@cinatra-ai/metric-usage-api`'s
 * `UsageEvent` but is declared HERE so the leaf SDK never imports the host
 * package — the host factory maps it 1:1 onto the real emitter, so the variants
 * must stay in sync (a new metered `source` is an additive SDK change). `source`
 * discriminates; `occurredAt` is ISO-8601; `idempotencyKey` dedupes at-least-once
 * emission. The strict shape rejects malformed events at compile time rather than
 * letting them silently fail downstream.
 */
export type HostLlmUsageEvent = {
  source: "llm";
  provider: "openai" | "anthropic" | "gemini";
  model: string;
  operation: "generate" | "stream";
  agentLabel: string | null;
  skillLabel: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  idempotencyKey: string;
  occurredAt: string;
  requestedProvider?: string | null;
  effectiveProvider?: string | null;
};

export type HostApolloUsageEvent = {
  source: "apollo";
  operation: string;
  agentLabel: string | null;
  requestCount: number;
  resultCount: number;
  creditsConsumed: number;
  idempotencyKey: string;
  occurredAt: string;
};

export type HostUsageEvent = HostLlmUsageEvent | HostApolloUsageEvent;

/**
 * Usage / cost telemetry emission — the inverted `@cinatra-ai/metric-usage-api`
 * surface. A metered connector (e.g. `apollo-connector`) reports per-call usage
 * through `ctx.telemetry.emitUsage(event)` instead of importing the host package.
 * Fire-and-forget by contract: emission MUST NOT throw or block the connector's
 * primary operation (the host swallows collection errors), so the method returns
 * `void`, not a Promise.
 */
export type HostTelemetryPort = {
  emitUsage(event: HostUsageEvent): void;
};

/**
 * The full privileged port surface passed to `register(ctx)`.
 *
 * ABI FROZEN — derived from the extension inventory; all ports required (runtime
 * grant enforcement; see the type-model decision in the file header).
 * Granted least-privilege: the host supplies only the subset an extension's
 * manifest `requestedHostPorts` declares + an admin approves (enforcement
 * progressive, designed here).
 */
export type ExtensionHostContext = {
  readonly abiVersion: string;
  readonly packageName: string;
  db: HostDbPort;
  settings: HostSettingsPort;
  secrets: HostSecretsPort;
  nango: HostNangoPort;
  authSession: HostAuthSessionPort;
  mcp: HostMcpPort;
  objects: HostObjectsPort;
  jobs: HostJobsPort;
  notifications: HostNotificationsPort;
  ui: HostUiPort;
  logger: HostLoggerPort;
  runtime: HostRuntimePort;
  capabilities: HostCapabilitiesPort;
  telemetry: HostTelemetryPort;
};

/** The canonical list of port names — the unit the manifest's
 * `requestedHostPorts` and the security grant model reference. */
export const HOST_PORT_NAMES = [
  "db",
  "settings",
  "secrets",
  "nango",
  "authSession",
  "mcp",
  "objects",
  "jobs",
  "notifications",
  "ui",
  "logger",
  "runtime",
  "capabilities",
  "telemetry",
] as const;

export type HostPortName = (typeof HOST_PORT_NAMES)[number];
