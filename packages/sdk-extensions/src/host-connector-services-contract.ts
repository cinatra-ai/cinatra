// Host connector-services capability contracts (TYPES ONLY).
//
// The transport/provider registration-via-capabilities cutover moves transport
// connector bootstrap out of the host's static import-and-call list and into
// each connector's `serverEntry` (`register(ctx)`). The bespoke host deps the
// transports need (legacy connector-config KV, google-oauth runtime, the
// secrets codec, the external-MCP registry, MCP self-client headers, instance
// identity, MCP pagination, content-editor A2A dispatch, the drupal/wordpress
// MCP instance surfaces, runtime mode, notifications, the skills catalog, and
// the provider-named openai/anthropic connection stores) are delivered as
// PER-CONCERN capability provider impls the HOST registers into the generic
// capability registry at boot; a connector's `register(ctx)` resolves only the
// concerns it needs via `ctx.capabilities.resolveProviders(<id>)` and adapts
// them into its own deps slot. The nango connection-storage surface resolves
// via the connector-authored `nango-system` capability instead
// (./nango-system-contract — cinatra#151 Stages 1+3).
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

import type { ObjectsProvider } from "./objects-provider-contract";
import type { CrmConnector } from "./crm-connector-contract";
import type { BlogDraftBuildInput, BlogDraftPayload } from "./blog-connector-contract";
import type {
  SocialMediaPost,
  SocialMediaPublishReceipt,
} from "./social-media-connector-contract";
import type { EmailSystemMessage, EmailSendReceipt } from "./email-connector-contract";

/** Capability ids the HOST registers per-concern service impls under. The
 * `@cinatra-ai/host:` prefix is reserved for host-provided services (it is not
 * an extension package name). */
export const HOST_CONNECTOR_SERVICE_CAPABILITIES = {
  connectorConfig: "@cinatra-ai/host:connector-config",
  googleOAuth: "@cinatra-ai/host:google-oauth",
  secretsCodec: "@cinatra-ai/host:secrets-codec",
  externalMcpRegistry: "@cinatra-ai/host:external-mcp-registry",
  mcpSelfClient: "@cinatra-ai/host:mcp-self-client",
  instanceIdentity: "@cinatra-ai/host:instance-identity",
  emailRouting: "@cinatra-ai/host:email-routing",
  blogRouting: "@cinatra-ai/host:blog-routing",
  objectsIntegration: "@cinatra-ai/host:objects-integration",
  extensionActionGuard: "@cinatra-ai/host:extension-action-guard",
  // --- transport-DI inversion services (cinatra#151 Stage 3) ---------------
  // The per-concern host services the openai/anthropic/drupal-mcp/
  // wordpress-mcp serverEntry transports adapt into their own deps slots at
  // activation. NOTE the retired sibling: the legacy
  // `@cinatra-ai/host:nango-connection-storage` delegating adapter id is GONE
  // from this contract — every consumer resolves the connector-authored
  // `nango-system` surface directly (the host keeps publishing the legacy
  // string id ONLY as a deprecation-window compat shim for already-installed
  // runtime package-store digests; removal rides the epic's governance
  // end-state, cinatra#151 Stage 7).
  mcpPagination: "@cinatra-ai/host:mcp-pagination",
  contentEditorDispatch: "@cinatra-ai/host:content-editor-dispatch",
  drupalMcp: "@cinatra-ai/host:drupal-mcp",
  wordpressMcp: "@cinatra-ai/host:wordpress-mcp",
  runtimeMode: "@cinatra-ai/host:runtime-mode",
  notifications: "@cinatra-ai/host:notifications",
  skillsCatalog: "@cinatra-ai/host:skills-catalog",
  openaiConnection: "@cinatra-ai/host:openai-connection",
  anthropicConnection: "@cinatra-ai/host:anthropic-connection",
} as const;

/** The legacy global connector-config KV (raw `connectorId`-keyed rows — NOT
 * the org-scoped `ctx.settings` namespace; existing rows keep working).
 * `delete` PHYSICALLY removes a row — required by consumers whose security
 * posture forbids blanking a dead key (e.g. the nango legacy-key purge, where
 * the stale row's values are untrusted and must not survive in any form). */
export type HostConnectorConfigService = {
  read<T>(connectorId: string, fallback: T): T;
  write(connectorId: string, value: unknown): void;
  delete(connectorId: string): void;
};

// The legacy `HostNangoConnectionStorageService` type is RETIRED with its
// adapter id (cinatra#151 Stage 3): consumers type the connector-authored
// surface via `NangoSystemSurface` (./nango-system-contract).

/** MCP list pagination helpers (`@/lib/mcp-pagination` stays host-side). */
export type HostMcpPaginationService = {
  decodeCursor(cursor?: string): number;
  buildListPage<T>(
    items: T[],
    total: number,
    offset: number,
    limit: number,
  ): { items: T[]; total: number; nextCursor?: string };
};

/**
 * Host-owned A2A blocking dispatch to a content-editor agent (shared by the
 * drupal/wordpress MCP connectors). The host helper mints the A2A bearer,
 * opens the external A2A client, sends one text-mode task and returns the
 * agent's reply TEXT — the `@cinatra-ai/llm` + `@cinatra-ai/a2a` runtime
 * edges stay host-side.
 */
export type HostContentEditorDispatchService = {
  dispatch(input: { agentUrl: string; payload: unknown; timeoutMs: number }): Promise<string>;
};

/** Drupal external-MCP toolbox surfaces (instance settings + cached probe +
 * endpoint/URL policy — `@/lib/drupal-api` / `@/lib/drupal-mcp-connection`
 * stay host-side). */
export type HostDrupalMcpService = {
  listInstances(): Array<{
    id: string;
    name: string;
    siteUrl: string;
    nangoConnectionId: string;
    providerConfigKey: string;
  }>;
  probe(
    siteUrl: string,
    authHeader: string,
  ): Promise<"registered" | "not_installed" | "auth_error" | "unreachable">;
  resolveServerUrl(siteUrl: string): string;
  isPrivateUrl(url: string): boolean;
};

/** WordPress external-MCP toolbox surfaces + the instance hard-delete
 * (`@/lib/wordpress-api` / `@/lib/wordpress-mcp-connection` stay host-side). */
export type HostWordPressMcpService = {
  listInstances(): Array<{
    id: string;
    name: string;
    siteUrl: string;
    username: string;
    applicationPassword: string;
  }>;
  probeAdapter(instance: {
    id: string;
    name: string;
    siteUrl: string;
    username: string;
    applicationPassword: string;
  }): Promise<"registered" | "not_installed" | "auth_error" | "unreachable">;
  resolveServerUrl(siteUrl: string): string;
  isPrivateUrl(url: string): boolean;
  deleteInstance(id: string): Promise<void>;
};

/** Host runtime-mode flag (development vs production). */
export type HostRuntimeModeService = {
  isDevelopment(): boolean;
};

/** Host notification creation (best-effort user-facing notices). */
export type HostNotificationsService = {
  create(input: {
    title: string;
    body: string;
    kind?: "error" | "info" | "success" | "warning";
    href?: string;
  }): Promise<void>;
};

/** Skills-catalog read (the host binds a call-time lazy import so the
 * `@cinatra-ai/skills` boot cycle never rides a connector's register graph). */
export type HostSkillsCatalogService = {
  read(): Promise<{
    skills: Array<{
      id: string;
      name: string;
      slug: string;
      description: string;
      packageId: string;
      packageName: string;
      packageSlug: string;
      sourcePath?: string;
    }>;
  }>;
};

/** The host-owned openai connection row + the shared connection store
 * (`@/lib/openai-connection-store` is read by host configuration surfaces —
 * NOT relocatable into the extension; provider-named like `googleOAuth`). */
export type HostOpenAIConnectionService = {
  readRowFromDatabase(): unknown;
  read(): unknown;
  update(input: unknown): Promise<void>;
  clear(): Promise<void>;
  updateLoggingEnabled(loggingEnabled: boolean): Promise<void>;
};

/** The host-owned anthropic connection row (DB fallback credential). */
export type HostAnthropicConnectionService = {
  readRowFromDatabase(): unknown;
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
 * A BLOCKING materializer for the Nango connection-save flow — distinct from
 * the best-effort `nango-connection-saved` hooks above. The nango gateway's
 * save path awaits every registered materializer for the saved `connectorKey`
 * and FOLDS FAILURES INTO ITS RESULT (a materializer failure fails the save —
 * the inline semantics of the wordpress/linkedin account materialization that
 * historically ran inside the save body). The host registers one provider
 * whose `materialize` dispatches by `connectorKey` and reports `handled`; the
 * save path FAILS LOUD when a connector key that requires materialization
 * finds no handler (never a silent skip).
 */
export const NANGO_CONNECTION_MATERIALIZER_CAPABILITY = "nango-connection-materializer";
export type NangoConnectionMaterializerInput = {
  connectorKey: string;
  providerConfigKey: string;
  connectionId: string;
  /** WordPress-style site URL carried by the save request (when present). */
  siteUrl?: string;
  scope?: "app" | "user";
  userId?: string;
};
export type NangoConnectionMaterializer = {
  materialize(input: NangoConnectionMaterializerInput): Promise<{ handled: boolean }>;
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

// ---------------------------------------------------------------------------
// Connector-exposed host surfaces (the lazy/guarded host-access cutover): a
// connector exposes the settings/status/integration readers the HOST needs as
// capability providers from its own `register(ctx)`, and host consumers
// resolve them at call time — the host names no connector package. Connectors
// register with the STRING ids (additive; an old host simply never resolves
// them); the constants + provider types below are for the host's resolver
// modules, which structurally guard every impl before trusting it.
// ---------------------------------------------------------------------------

/**
 * The host-published OBJECTS INTEGRATION surface (per-concern host service,
 * `@cinatra-ai/host:objects-integration`): the host-bound objects provider +
 * the capability-aware CRM provider lookup, as VALUES through the capability
 * registry — so a connector's serverEntry graph can register object types,
 * sync adapters, and pointer writers WITHOUT value-importing a host peer
 * (the host-peer-value-import ban).
 */
export type HostObjectsIntegrationService = {
  /** The host-bound objects provider, or null while unwired (next build). */
  getObjectsProvider(): ObjectsProvider | null;
  /** Registry + capability-aware CRM provider lookup (null when absent). */
  lookupCrmProvider(providerId: string): CrmConnector | null;
};

/**
 * An extension that ships object types registers a registrar here; the host's
 * `registerAllObjectTypes()` invokes every registered provider (idempotent —
 * replace-by-id on the object registry) instead of importing the extension.
 */
export const OBJECT_TYPE_REGISTRAR_CAPABILITY = "object-type-registrar";
export type ObjectTypeRegistrarProvider = {
  registerObjectTypes(): void;
};

/**
 * Idempotent object-sync registration (CRM sync adapters today) the host's
 * background repair cycles invoke before processing the projection outbox.
 */
export const CRM_SYNC_BOOTSTRAP_CAPABILITY = "crm-sync-bootstrap";
export type CrmSyncBootstrapProvider = {
  ensureSyncRegistrations(): void;
};

/** Payload of a durable CRM pointer write (the twenty-pointer-repair job). */
export type CrmPointerWritePayload = {
  type: "account" | "contact";
  externalId: string;
  name: string;
  orgId?: string | null;
  userId?: string | null;
};

/**
 * Durable CRM pointer writes. The impl owns the register-types-before-write
 * ordering the host previously had to encode around `writePointerByType`.
 */
export const CRM_POINTER_WRITER_CAPABILITY = "crm-pointer-writer";
export type CrmPointerWriterProvider = {
  writePointer(payload: CrmPointerWritePayload): Promise<void>;
};

/**
 * Dev-tunnel (Tailscale today) local status reads for the host's
 * development/tunnel surface. Absence degrades to "not connected".
 */
export const DEV_TUNNEL_STATUS_CAPABILITY = "dev-tunnel-status";
export type DevTunnelStatusProvider = {
  getConnectionStatus(): { connected: boolean };
  getFunnelUrlPreview(): string | null;
};

/** Blog project summary the host's project store exposes to the blog facade. */
export type HostBlogProjectSummary = {
  id: string;
  name: string;
  companyUrl: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * The host-side blog project store the host injects behind
 * `HOST_CONNECTOR_SERVICE_CAPABILITIES.blogRouting` (`projectStore`).
 * Structurally identical to the blog facade's own `BlogProjectStore` interface
 * — kept as an SDK type so HOST code never type-imports the facade package
 * (type imports count toward the required-extensions cover gate).
 */
export type HostBlogProjectStore = {
  listProjects(): Promise<HostBlogProjectSummary[]>;
  getProject(projectId: string): Promise<HostBlogProjectSummary | null>;
  updatePostImageArtifactRefs(input: {
    projectId: string;
    postId: string;
    imageArtifactId?: string;
    imageRepresentationRevisionId?: string;
    imagePrompt?: string;
  }): Promise<void>;
};

/** Input/result of the blog facade's image materialization (structural). */
export type BlogImageMaterializeInputShape = {
  imageBase64: string;
  imageMimeType: string;
  title?: string;
  createdByRunId?: string | null;
};
export type BlogImageMaterializeResultShape = {
  artifactId: string;
  representationRevisionId: string;
};

/** WordPress content-converter shapes (the dormant convert primitive). */
export type WordPressContentConverterInputShape = {
  wordpressInstanceId: string;
  title: string;
  excerpt: string;
  content: string;
};
export type WordPressContentConverterOutputShape = {
  title?: string;
  excerpt?: string;
  content: string;
  contentIsHtml?: boolean;
};

/**
 * The blog facade surface the blog-connector registers for HOST consumers
 * (src/lib/blog/*): draft-payload build, image materialization, and the
 * legacy WP content-converter lookup. Absence degrades the host's blog
 * features per call.
 */
export const BLOG_SYSTEM_CAPABILITY = "blog-system";
export type BlogSystemProvider = {
  buildDraftPayload(
    input: BlogDraftBuildInput,
    opts?: { connectorId?: string; instanceBlogConnectorId?: string },
  ): Promise<BlogDraftPayload>;
  materializeBlogImage(
    input: BlogImageMaterializeInputShape,
  ): Promise<BlogImageMaterializeResultShape>;
  getWordPressContentConverter(
    wordpressInstanceId: string,
  ):
    | ((input: WordPressContentConverterInputShape) => Promise<WordPressContentConverterOutputShape>)
    | null;
};

/**
 * The provider-neutral social-media publish facade the social-media-connector
 * registers for HOST consumers (the blog LinkedIn publish step today).
 */
export const SOCIAL_MEDIA_SYSTEM_CAPABILITY = "social-media-system";
export type SocialMediaSystemProvider = {
  publishPost(
    post: SocialMediaPost,
    opts?: { connectorId?: string; userId?: string; orgId?: string },
  ): Promise<SocialMediaPublishReceipt>;
};

/**
 * The host's extension-action permission gate as a per-concern service —
 * the SAME enforcement the SDK `requireExtensionAction` slot binds, published
 * as a VALUE so a serverEntry-built action impl can gate without an SDK value
 * import (host-peer-value-import ban). MUST fail closed.
 */
export type HostExtensionActionGuardService = {
  require(packageId: string, mode: "read" | "manage"): Promise<void>;
};

/**
 * The per-LLM-provider settings/status/catalog surface an LLM connector
 * registers for HOST consumers (campaign actions, setup/telemetry/logging
 * pages, the connection-status + llm-access test routes, the setup wizard).
 * One provider per connector, discriminated by `providerId`; every member is
 * optional — the host's resolver structurally guards what it uses, and an
 * absent provider degrades the host feature per call.
 *
 * TRUST BOUNDARY: this surface is HOST-INTERNAL in-process wiring — it is
 * resolvable only via the server-side capability registry, never by clients.
 * AUTHORIZATION therefore lives at the HOST CALL SITES (the server actions /
 * routes that resolve a surface carry their own gating, unchanged from the
 * static imports they replaced); a member that was itself a GATED action
 * before the cutover (the openai save/clear/skills actions) must keep its
 * own fail-closed gate inside the impl (the extension-action-guard service).
 * Plain readers/writers (logging toggles, model selection) follow their host
 * call sites' existing gating exactly as before.
 */
export const LLM_PROVIDER_SURFACE_CAPABILITY = "llm-provider-surface";
export type LlmProviderSurface = {
  /** The LLM vendor id ("openai" | "anthropic" | "gemini" | "apollo" | ...). */
  providerId: string;
  isConnectionReady?(connection?: unknown): boolean;
  getConfiguredConnection?(connection?: unknown): Promise<unknown>;
  listAvailableModels?(input: {
    projectId?: string;
    organizationId?: string;
  }): Promise<string[]>;
  filterVisibleModels?(models: string[]): string[];
  filterSelectableModels?(models: string[]): string[];
  serviceTierOptions?: Array<{ value: string; label: string }>;
  getDefaultModel?(): string;
  saveDefaultModel?(model: string): void;
  saveAPISettings?(input: { apiKey?: string }): Promise<unknown>;
  clearAPISettings?(): Promise<unknown>;
  models?: readonly string[];
  getConfiguredAPIKey?(): Promise<string | null>;
  getLoggingSettings?(): { enabled: boolean; directory: string };
  saveLoggingSettings?(enabled: boolean): Promise<void>;
  logDirectory?: string;
  actions?: {
    saveConnection?(formData: FormData): Promise<unknown>;
    clearConnection?(): Promise<unknown>;
    saveSkillsSettings?(formData: FormData): Promise<unknown>;
  };
  // --- LLM provider adapter members (cinatra#151 Stage 2) ----------------
  // Resolved by the host's packages/llm adapters at call time (the last
  // value-imports packages/llm carried). Absence degrades per member:
  // connection/headers members gate adapter availability; log writers are
  // best-effort (host no-ops when absent).
  /** Provider request headers (e.g. Gemini API key + host self-client headers). */
  buildRequestHeaders?(input: {
    apiKey?: string;
    contentType?: string;
    extraHeaders?: Record<string, string>;
  }): Record<string, string>;
  /** Request/response telemetry log writer (connector owns enabled-check + redaction). */
  writeLogFile?(input: { label: string; kind: "request" | "response"; body: unknown }): Promise<void>;
  /**
   * GATED shell-tool members (least privilege): a settings reader + the
   * docker-confined executor — never a raw client/spawn handle. The ABI
   * deliberately carries NO administration/settings parameter: the
   * connector's STORED settings are the single policy authority (enabled
   * flag, command allowlists, mount roots, limits are enforced inside the
   * connector against stored state and cannot be overridden through this
   * surface).
   */
  shellTools?: {
    readSettings(): unknown;
    runCommandInDocker(input: {
      shellCommand: string;
      cwd?: string;
      timeoutMs?: number;
      maxOutputLength?: number;
    }): Promise<{
      exitCode: number | null;
      stdout: string;
      stderr: string;
      timedOut?: boolean;
      outputTruncated?: boolean;
    }>;
  };
};

/**
 * The provider-neutral email send facade the email-connector registers for
 * HOST consumers (the trigger email-send path today). Routing chain +
 * dev-mode recipient override live connector-side, exactly as the facade
 * the host previously dynamic-imported.
 */
export const EMAIL_SYSTEM_CAPABILITY = "email-system";
export type EmailSystemProvider = {
  sendEmail(
    message: EmailSystemMessage,
    opts?: { connectorId?: string; userId?: string; orgId?: string; senderIdentityId?: string },
  ): Promise<EmailSendReceipt>;
};
