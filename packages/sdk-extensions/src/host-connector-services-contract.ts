// Host connector-services capability contracts (TYPES ONLY).
//
// The transport/provider registration-via-capabilities cutover moves transport
// connector bootstrap out of the host's static import-and-call list and into
// each connector's `serverEntry` (`register(ctx)`). The bespoke host deps the
// transports need (legacy connector-config KV, the Nango connection-storage
// surface, google-oauth runtime, the secrets codec, the external-MCP registry,
// MCP self-client headers, instance identity) are delivered as PER-CONCERN
// capability provider impls the HOST registers into the generic capability
// registry at boot; a connector's `register(ctx)` resolves only the concerns it
// needs via `ctx.capabilities.resolveProviders(<id>)` and adapts them into its
// own deps slot.
//
// WHY capability impls and not new ctx ports or SDK DI value-slots:
//   - the ctx-port ABI is frozen (additive optional methods only) AND the
//     existing per-connector deps contracts are partly SYNCHRONOUS
//     (e.g. a sync `getPrimarySavedConnection`), which the async-by-ABI
//     `ctx.nango` port cannot satisfy without rewriting connector internals;
//   - a runtime-loaded package's `serverEntry` graph must not VALUE-import the
//     host-provided SDK (host-peer value-import gate; model-B runtime
//     resolution), so an SDK `require…()` helper function is not available to
//     extension register code — but `ctx.capabilities` IS, and impls are data.
//
// This module is deliberately TYPE-ONLY for extensions (they `import type` the
// shapes and inline the capability-id literals); the host imports the constants
// as values when registering the impls. None of these types import host
// internals — every shape is structural.

/** Capability ids the HOST registers per-concern service impls under. The
 * `@cinatra-ai/host:` prefix is reserved for host-provided services (it is not
 * an extension package name). */
export const HOST_CONNECTOR_SERVICE_CAPABILITIES = {
  connectorConfig: "@cinatra-ai/host:connector-config",
  nangoConnectionStorage: "@cinatra-ai/host:nango-connection-storage",
  googleOAuth: "@cinatra-ai/host:google-oauth",
  secretsCodec: "@cinatra-ai/host:secrets-codec",
  externalMcpRegistry: "@cinatra-ai/host:external-mcp-registry",
  mcpSelfClient: "@cinatra-ai/host:mcp-self-client",
  instanceIdentity: "@cinatra-ai/host:instance-identity",
  emailRouting: "@cinatra-ai/host:email-routing",
  blogRouting: "@cinatra-ai/host:blog-routing",
} as const;

/** The legacy global connector-config KV (raw `connectorId`-keyed rows — NOT
 * the org-scoped `ctx.settings` namespace; existing rows keep working). */
export type HostConnectorConfigService = {
  read<T>(connectorId: string, fallback: T): T;
  write(connectorId: string, value: unknown): void;
};

/** The Nango connection-storage surface (host-bound from the nango gateway).
 * Mirrors the host's synchronous-where-sync functions 1:1 so a connector's
 * existing deps contract can be satisfied without internal rewrites. */
export type HostNangoConnectionStorageService = {
  isConfigured(): boolean;
  getStatus(): { status: "connected" | "not_connected"; detail?: string };
  getFrontendConfig(): unknown;
  getPrimarySavedConnection(
    connectorKey: string,
    opts?: { scope?: "app" | "user"; userId?: string },
  ): {
    providerConfigKey: string;
    connectionId: string;
    displayName?: string;
    email?: string;
  } | null;
  ensureIntegration(input: {
    provider: string;
    providerConfigKey: string;
    displayName?: string;
    [k: string]: unknown;
  }): Promise<unknown>;
  ensureConnectorIntegration(connectorKey: string): Promise<unknown>;
  importConnection(input: Record<string, unknown>): Promise<unknown>;
  getCredentials(
    providerConfigKey: string,
    connectionId: string,
    opts?: { forceRefresh?: boolean },
  ): Promise<unknown>;
  saveConnectionRecord(
    connectorKey: string,
    record: Record<string, unknown>,
    opts?: { multiple?: boolean; scope?: "app" | "user"; userId?: string },
  ): Promise<unknown>;
  removeConnectionRecord(
    connectorKey: string,
    connectionId: string,
    opts?: { scope?: "app" | "user"; userId?: string },
  ): Promise<unknown>;
  deleteConnection(providerConfigKey: string, connectionId: string): Promise<unknown>;
  clearConnectionRecords(
    connectorKey: string,
    opts?: { scope?: "app" | "user"; userId?: string },
  ): Promise<unknown>;
  buildBearerAuthHeader(input: Record<string, unknown>): Promise<unknown>;
  providerConfigKeys: Record<string, string>;
  connectionIds: Record<string, string>;
};

/** Google-OAuth runtime helpers (status / authed fetch / token refresh). */
export type HostGoogleOAuthService = {
  getStatus(opts?: unknown): Promise<{
    status: "connected" | "incomplete" | "not_connected";
    accountEmail?: string;
    detail?: string;
  }>;
  apiFetch<T = unknown>(
    input: { url: string; method?: string; body?: unknown },
    options?: Record<string, unknown>,
  ): Promise<T>;
  refreshAccessTokenIfNeeded(opts?: unknown): Promise<unknown>;
};

/** AES-256-GCM secret codec over the host instance key (storage stays in the
 * connector's own config rows — this is a codec, not a store). */
export type HostSecretsCodecService = {
  encryptSecret(plaintext: string, aad?: string): { ciphertext: string; iv: string };
  decryptSecret(input: { ciphertext: string; iv: string }, aad?: string): string;
};

/** Global external-MCP server registry mutation (apify-style first-party
 * registration of an externally-hosted MCP server). */
export type HostExternalMcpRegistryService = {
  upsertServer(input: Record<string, unknown>): void;
  deleteServer(id: string): void;
};

/** Auth headers for the in-app MCP self-client. */
export type HostMcpSelfClientService = {
  buildHeaders(): Record<string, string>;
};

/** This deployment's instance identity (read-only). */
export type HostInstanceIdentityService = {
  read(): { instanceDisplayName?: string | null } | null;
};

/**
 * Host-side email ROUTING impls for the email facade (the sender-identity
 * objects lookup chain, the dev-mode recipient override, and the best-effort
 * sent-email object writer live host-side; the registry-fallback step lives in
 * the facade). `resolveConnectorId` returns null when no step resolves so the
 * facade can fall through to its own registry fallback.
 */
export type HostEmailRoutingService = {
  resolveConnectorId(opts: {
    explicitConnectorId?: string;
    senderIdentityId?: string;
    userId?: string;
    orgId?: string;
  }): Promise<string | null>;
  applyDevModeOverride<M>(msg: M): M;
  saveSentEmailObject?(input: {
    msg: unknown;
    receipt: unknown;
    routing: {
      connectorId: string;
      senderIdentityId?: string;
      userId?: string;
      orgId?: string;
    };
  }): Promise<void>;
};

/** Host-side blog facade impls (image materializer + project store). */
export type HostBlogRoutingService = {
  materializeBlogImage: (...args: never[]) => unknown;
  projectStore: unknown;
};

/**
 * A post-save hook for the Nango connection-save route. A connector registers
 * one under the `nango-connection-saved` capability from its `register(ctx)`;
 * the host route runs every hook whose `connectorKey`/`scope` match the saved
 * connection, best-effort (a hook failure never fails the save).
 */
export const NANGO_CONNECTION_SAVED_CAPABILITY = "nango-connection-saved";
export type NangoConnectionSavedHook = {
  connectorKey: string;
  scope?: "app" | "user";
  run(input: { userId?: string }): Promise<void>;
};

/**
 * A declared-toolbox resolver for the LLM MCP-tool injection path. A connector
 * managed OUTSIDE the external-MCP registry (apify today) registers one under
 * the `llm-toolbox` capability; the LLM registry resolves a declared toolbox id
 * through these providers before falling back to the external registry.
 */
export const LLM_TOOLBOX_CAPABILITY = "llm-toolbox";
export type LlmToolboxProvider = {
  /** The declared toolbox id this provider serves (an agent's pinned toolbox id). */
  toolboxId: string;
  /** Build the MCP server tool definitions to inject (provider = LLM vendor id). */
  build(provider: string): Promise<unknown[]>;
};

/** The social-post capability id concrete social providers register under. */
export const SOCIAL_POST_CAPABILITY = "social-post";

/** The crm-provider capability id concrete CRM providers register under. */
export const CRM_PROVIDER_CAPABILITY = "crm-provider";

/** The email-send capability id concrete email providers register under. */
export const EMAIL_SEND_CAPABILITY = "email-send";
