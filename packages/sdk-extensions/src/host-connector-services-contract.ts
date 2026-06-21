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
  // `@cinatra-ai/host:nango-connection-storage` delegating adapter id is
  // FULLY retired (contract id + type removed at Stage 3; the host's
  // deprecation-window compat shim removed at the epic's governance
  // end-state, cinatra#151 Stage 7) — every consumer resolves the
  // connector-authored `nango-system` surface directly, and the legacy id
  // resolves to nothing.
  mcpPagination: "@cinatra-ai/host:mcp-pagination",
  contentEditorDispatch: "@cinatra-ai/host:content-editor-dispatch",
  drupalMcp: "@cinatra-ai/host:drupal-mcp",
  // --- hostInternal pinned-empty sweep (cinatra#172 Stage H2) --------------
  // Per-concern widget-auth config surface for the drupal assistant widget
  // (`@/lib/drupal-widget-auth` stays host-side).
  drupalWidgetAuth: "@cinatra-ai/host:drupal-widget-auth",
  wordpressMcp: "@cinatra-ai/host:wordpress-mcp",
  // --- hostInternal pinned-empty sweep (cinatra#172 Stage H3) --------------
  // WordPress post/media CONTENT surface — deliberately a SEPARATE capability
  // id from the connection-focused `wordpress-mcp` service so connection
  // admin and content CRUD never evolve under one id.
  wordpressContent: "@cinatra-ai/host:wordpress-content",
  // --- per-user / per-connector-instance WRITE authority (cinatra#409) ------
  // The host-owned authority the WordPress / Drupal content-editor MCP
  // connectors call before EVERY write primitive. The host resolves the
  // TRUSTED user actor (mcpRequestContextStorage / llm / cookie frame — NEVER
  // connector input), DENIES fail-closed when no userId+orgId resolve, and
  // delegates to the existing per-instance connector-authority policy. The
  // package id the policy evaluates is a HOST-BOUND constant (the guard the
  // host publishes per connector is already bound to that connector's own
  // package id) — never caller-supplied. Distinct from the content/connection
  // service ids so authz and content CRUD never evolve under one id.
  instanceWriteAuthority: "@cinatra-ai/host:instance-write-authority",
  // Per-concern widget-auth config surface for the wordpress assistant widget
  // (`@/lib/wordpress-widget-auth` stays host-side).
  wordpressWidgetAuth: "@cinatra-ai/host:wordpress-widget-auth",
  // --- hostInternal pinned-empty sweep (cinatra#172 Stage H4) --------------
  // Per-concern connection-admin surfaces for the github/linkedin transports
  // and the youtube OAuth token mint (`@/lib/github-api` / `@/lib/linkedin-api`
  // / `@/lib/youtube-api` stay host-side).
  githubConnection: "@cinatra-ai/host:github-connection",
  linkedinConnection: "@cinatra-ai/host:linkedin-connection",
  youtubeConnection: "@cinatra-ai/host:youtube-connection",
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

/** Drupal external-MCP toolbox + instance-admin surfaces (instance settings +
 * cached probe + endpoint/URL policy + the connector settings page's
 * save/delete/status reads-and-writes — `@/lib/drupal-api` /
 * `@/lib/drupal-mcp-connection` stay host-side).
 *
 * TRUST (cinatra#172 Stage H2): READ and WRITE members share this ONE
 * in-process capability id — the registry is server-side only, never
 * client-resolvable. The WRITERS are `saveInstance` (persists the instance
 * row + imports the Nango credential) and `deleteInstance` (hard-deletes the
 * row + best-effort Nango cleanup). AUTHORIZATION GATING STAYS
 * EXTENSION-SIDE: the connector's "use server" actions keep their
 * `requireExtensionAction(<pkg>, "manage")` gates — the identical posture the
 * static `@/lib/drupal-api` imports carried before the cutover. */
export type HostDrupalMcpService = {
  listInstances(): Array<{
    id: string;
    name: string;
    siteUrl: string;
    nangoConnectionId: string;
    providerConfigKey: string;
    /** Row metadata (host rows always carry these; optional for skew). */
    lastValidatedAt?: string;
    createdAt?: string;
    updatedAt?: string;
  }>;
  probe(
    siteUrl: string,
    authHeader: string,
  ): Promise<"registered" | "not_installed" | "auth_error" | "unreachable">;
  resolveServerUrl(siteUrl: string): string;
  isPrivateUrl(url: string): boolean;
  // --- instance-admin surface (cinatra#172 Stage H2) -----------------------
  /** Aggregate status for the connector's `drupal_status` primitive. */
  getAPIStatus(): Promise<{
    instanceCount: number;
    instances: Array<{ id: string; name: string; siteUrl: string; lastValidatedAt?: string }>;
  }>;
  /** WRITER — persist an instance row (Nango import + readback inside). */
  saveInstance(input: { id?: string; name: string; siteUrl: string; mcpApiKey?: string }): Promise<{
    id: string;
    name: string;
    siteUrl: string;
    nangoConnectionId: string;
    providerConfigKey: string;
    lastValidatedAt?: string;
    createdAt: string;
    updatedAt: string;
  }>;
  /** WRITER — hard-delete an instance row (best-effort Nango cleanup). */
  deleteInstance(id: string): Promise<void>;
  /** Per-instance MCP reachability statuses (host probe + Nango bearer). */
  getInstanceStatuses(): Promise<
    Array<{
      id: string;
      name: string;
      siteUrl: string;
      status: "registered" | "not_installed" | "auth_error" | "unreachable";
      isPrivate: boolean;
    }>
  >;
};

/** Widget AUTH-CONFIG storage for the Drupal assistant widget
 * (`@/lib/drupal-widget-auth` stays host-side; the request-time origin/token
 * validation lives in the host's generic widget-stream auth, NOT here).
 *
 * TRUST (cinatra#172 Stage H2): read and write share this ONE in-process
 * capability id (server-side registry only). The WRITER is `generate()` — it
 * MINTS AND PERSISTS a fresh widget API key, immediately invalidating the
 * previous one. AUTHORIZATION GATING STAYS EXTENSION-SIDE: the connector's
 * "use server" generate action keeps its `requireExtensionAction(<pkg>,
 * "manage")` gate — the identical posture the static import carried. */
export type HostDrupalWidgetAuthService = {
  read(): { apiKey: string; generatedAt: string } | null;
  /** WRITER — mint + persist a fresh widget API key (invalidates the old). */
  generate(): { apiKey: string; generatedAt: string };
};

/** Structural WordPress instance row threading through the wordpress
 * connection/content services. Required fields are what every consumer needs;
 * the row metadata is optional FOR SKEW ONLY (host rows always carry the
 * Nango binding + timestamps) so a connector compiled against this shape can
 * meet any host. `@/lib/wordpress-api`'s `WordPressInstanceSettings` is the
 * host-side authority. */
export type WordPressInstanceRowShape = {
  id: string;
  name: string;
  siteUrl: string;
  username: string;
  applicationPassword: string;
  /** Nango credential binding (host rows always carry these; optional for skew). */
  providerConfigKey?: string;
  connectionId?: string;
  /** Row metadata (host rows always carry these; optional for skew). */
  lastValidatedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Opt-in site-specific blog-connector binding (host-persisted). */
  blogConnectorId?: string;
};

/** WordPress external-MCP toolbox + connection/instance-admin surfaces
 * (`@/lib/wordpress-api` / `@/lib/wordpress-mcp-connection` stay host-side).
 * Post/media CONTENT CRUD deliberately lives on the SEPARATE
 * `@cinatra-ai/host:wordpress-content` service (`HostWordPressContentService`)
 * so connection admin and content writes never evolve under one capability id.
 *
 * TRUST (cinatra#172 Stage H3): READ and WRITE members share this ONE
 * in-process capability id — the registry is server-side only, never
 * client-resolvable. The WRITERS are `deleteInstance` (hard-deletes the
 * instance row + best-effort Nango cleanup) and `webhookSubscriptions.register`
 * / `webhookSubscriptions.remove` (mutate the REMOTE WordPress site's
 * `cinatra/v1/webhooks` subscription table over Basic auth). AUTHORIZATION
 * GATING STAYS EXTENSION-SIDE: the connectors' "use server" actions keep
 * their `requireExtensionAction(<pkg>, "manage")` gates — the identical
 * posture the static `@/lib/wordpress-api` imports carried before the
 * cutover. */
export type HostWordPressMcpService = {
  listInstances(): Array<WordPressInstanceRowShape>;
  probeAdapter(instance: {
    id: string;
    name: string;
    siteUrl: string;
    username: string;
    applicationPassword: string;
  }): Promise<"registered" | "not_installed" | "auth_error" | "unreachable">;
  /** FALLBACK (`index.php?rest_route=`) endpoint form — works in every WP
   * configuration; the INJECTED MCP server URL. Distinct from
   * `resolveEndpoint` (the PRIMARY pretty-permalink form) — do not conflate. */
  resolveServerUrl(siteUrl: string): string;
  isPrivateUrl(url: string): boolean;
  /** WRITER — hard-delete an instance row (best-effort Nango cleanup). */
  deleteInstance(id: string): Promise<void>;
  // --- connection/instance-admin surface (cinatra#172 Stage H3) ------------
  /** Aggregate status for the connector's `wordpress_status` primitive. */
  getAPIStatus(): { status: "connected" | "not_connected"; detail: string };
  /** Full instance settings document (rows + logging flag). */
  getAPISettings(): { instances: Array<WordPressInstanceRowShape>; loggingEnabled?: boolean };
  /** One instance row by id (null when unknown). */
  readInstanceById(id: string): WordPressInstanceRowShape | null;
  /** PRIMARY (`/wp-json/...` pretty-permalink) endpoint form — the canonical
   * URL shown in admin UIs. Distinct from `resolveServerUrl` (FALLBACK). */
  resolveEndpoint(siteUrl: string): string;
  /** Remote `cinatra/v1/webhooks` subscription client (direct Basic auth on
   * the instance row — works without Nango). `register`/`remove` are WRITERS
   * against the remote WordPress site. */
  webhookSubscriptions: {
    list(instance: {
      siteUrl: string;
      username: string;
      applicationPassword: string;
    }): Promise<
      Array<{
        id: string;
        event_type: string;
        target_url: string;
        post_types: string[];
        created_at: string;
      }>
    >;
    /** WRITER — idempotent remote subscription upsert (HTTP 409 == success). */
    register(
      instance: { siteUrl: string; username: string; applicationPassword: string },
      subscription: { event_type: string; target_url: string; post_types?: string[] },
    ): Promise<{
      id: string;
      event_type: string;
      target_url: string;
      post_types: string[];
      created_at: string;
    }>;
    /** WRITER — idempotent remote subscription delete (404 == already gone). */
    remove(
      instance: { siteUrl: string; username: string; applicationPassword: string },
      subscriptionId: string,
    ): Promise<void>;
  };
};

/** WordPress post/media CONTENT surface (`@/lib/wordpress-api` stays
 * host-side; Basic-auth resolution runs host-side through Nango on the
 * instance row's credential binding). SEPARATE capability id from the
 * connection-focused `wordpress-mcp` service — connection admin and content
 * CRUD must never evolve under one id.
 *
 * TRUST (cinatra#172 Stage H3): this is a COARSE content-CRUD surface — read
 * and write members share this ONE in-process capability id (server-side
 * registry only). The WRITERS are `createDraft`, `deletePost`, `uploadMedia`,
 * `updateDraftMeta`, and `updatePost` (all mutate the REMOTE WordPress site);
 * `readPost` / `readPostStatus` / `listPublishedPosts` are readers.
 * AUTHORIZATION GATING STAYS EXTENSION-SIDE / DISPATCH-SIDE: the consuming
 * MCP primitive handlers sit behind the host's MCP dispatch + actor gating —
 * the identical posture the static `@/lib/wordpress-api` imports carried
 * before the cutover (no member is client-resolvable). */
export type HostWordPressContentService = {
  /** WRITER — create a draft post; payload mirrors the host's
   * `WordPressWritablePostPayload` (status is pinned to "draft"). */
  createDraft(input: {
    instance: WordPressInstanceRowShape;
    payload: {
      title: string;
      content: string;
      excerpt: string;
      status: "draft";
      slug?: string;
      author?: number;
      comment_status?: "open" | "closed";
      ping_status?: "open" | "closed";
      format?: string;
      sticky?: boolean;
      template?: string;
      categories?: number[];
      tags?: number[];
      meta?: Record<string, unknown>;
      featured_media?: number;
    };
  }): Promise<{ wordpressPostId: number; publicUrl?: string; adminUrl: string }>;
  readPost(input: {
    instance: WordPressInstanceRowShape;
    wordpressPostId: number;
    postType?: string;
  }): Promise<{
    id: number;
    status: string;
    title: string;
    content: string;
    excerpt: string;
    slug?: string;
    link?: string;
    featured_media?: number;
    categories?: number[];
    tags?: number[];
    adminUrl: string;
  }>;
  readPostStatus(input: {
    instance: WordPressInstanceRowShape;
    wordpressPostId: number;
  }): Promise<{ id: number; status: string; adminUrl: string; publicUrl?: string }>;
  listPublishedPosts(
    instance: WordPressInstanceRowShape,
    options?: { offset?: number; limit?: number },
  ): Promise<{
    items: Array<{ id: number; title: string; status: string; date: string; url: string }>;
    total: number;
  }>;
  /** WRITER — delete a post on the remote site. */
  deletePost(input: {
    instance: WordPressInstanceRowShape;
    wordpressPostId: number;
  }): Promise<{ deleted: boolean; previousStatus?: string }>;
  /** WRITER — upload media (featured images). */
  uploadMedia(input: {
    instance: WordPressInstanceRowShape;
    imageBase64: string;
    imageMimeType: string;
    title: string;
  }): Promise<{ mediaId: number; sourceUrl?: string }>;
  /** WRITER — meta-only post update; returns the raw WP post record. */
  updateDraftMeta(input: {
    instance: WordPressInstanceRowShape;
    wordpressPostId: number;
    meta: Record<string, unknown>;
  }): Promise<unknown>;
  /** WRITER — top-level field updates (title/content/excerpt/status/meta). */
  updatePost(input: {
    instance: WordPressInstanceRowShape;
    wordpressPostId: number;
    postType?: string;
    fields: {
      title?: string;
      content?: string;
      excerpt?: string;
      status?: "publish" | "future" | "draft" | "pending" | "private";
      meta?: Record<string, unknown>;
    };
  }): Promise<{
    id: number;
    status: string;
    title: string;
    content: string;
    excerpt: string;
    adminUrl: string;
  }>;
};

/**
 * Per-user / per-connector-instance WRITE authority for the CMS content path
 * (cinatra#409). The WordPress / Drupal content-editor MCP connectors resolve
 * this host service and call `requireWrite` at the TOP of every write primitive
 * (after schema-parse + instance resolve), BEFORE any host content writer.
 *
 * TRUST: the host resolves the TRUSTED user actor from the active request/run
 * context (`mcpRequestContextStorage` / llm / cookie) — NEVER from connector or
 * tool input — DENIES (throws) fail-closed when no `userId` + `orgId` resolve.
 * It then enforces TWO host-side layers, both keyed on the TRUSTED actor's org:
 *   1. PER-INSTANCE — resolves the instance row host-side and asserts its
 *      persisted org binding (cinatra#274) == the trusted actor's org, so a
 *      forged `instanceId` (same-org-mismatch or a different-org instance) is
 *      DENIED; an unknown / unbound row is DENIED fail-closed.
 *   2. CONNECTOR-PACKAGE — delegates to the host `requireConnectorAuthority`
 *      policy (emits a `connector_instance` audit row).
 * Both the connector package whose policy is evaluated AND the instance reader
 * are HOST-BOUND from the connector KIND (the connector names only WHICH kind it
 * is — its own static identity — via `selectForConnector`); a connector can
 * never select another package's policy nor another connector's instance rows.
 *
 * FAIL-CLOSED CONTRACT: a connector that resolves this service MUST let
 * `requireWrite` throw propagate (never fall back to a write); a connector that
 * CANNOT resolve it (old host, dep unbound) MUST also fail closed — never write
 * under a synthetic / anonymous actor. `requireWrite` resolves `void` on allow
 * and THROWS on deny (no boolean result to misread).
 */
/** The CLOSED set of CMS content connector KINDS the per-instance write
 * authority gates. A connector names its OWN kind (its static identity); the
 * host maps the kind to the package id + instance reader. Type-closed AND
 * runtime-closed (the host also throws for any unknown kind at call time). */
export type InstanceWriteConnectorKind = "wordpress" | "drupal";

export type HostInstanceWriteAuthorityService = {
  /**
   * Bind the guard to a connector KIND (`"wordpress" | "drupal"`) — the
   * connector's OWN static identity, NOT a package id or any other caller-chosen
   * policy selector. The host maps the kind to BOTH the connector package id and
   * the instance reader; an unknown kind THROWS. Returns the bound guard.
   */
  selectForConnector(kind: InstanceWriteConnectorKind): {
    /** Throws on deny (fail-closed); resolves void on allow. `sourceType` is the
     * host-threaded request source (additive; `"public_site_widget"` triggers a
     * defensive no-platform-admin-bypass assertion) — NOT trusted from input. */
    requireWrite(input: {
      instanceId: string;
      primitiveName: string;
      sourceType?: string;
    }): Promise<void>;
  };
};

/** Widget AUTH-CONFIG storage for the WordPress assistant widget
 * (`@/lib/wordpress-widget-auth` stays host-side; the request-time
 * origin/token validation lives in the host's generic widget-stream auth and
 * the webhook HMAC verification — `verifyWebhookSignature` — stays host-only,
 * NOT here).
 *
 * TRUST (cinatra#172 Stage H3): read and write share this ONE in-process
 * capability id (server-side registry only). The WRITER is `generate()` — it
 * MINTS AND PERSISTS a fresh widget API key + webhook secret, immediately
 * invalidating the previous pair. AUTHORIZATION GATING STAYS EXTENSION-SIDE:
 * the connector's "use server" generate action keeps its
 * `requireExtensionAction(<pkg>, "manage")` gate — the identical posture the
 * static import carried. */
export type HostWordPressWidgetAuthService = {
  read(): { apiKey: string; webhookSecret: string; generatedAt: string } | null;
  /** WRITER — mint + persist a fresh key + webhook secret (invalidates the old). */
  generate(): { apiKey: string; webhookSecret: string; generatedAt: string };
};

/** GitHub OAuth/connection-admin surface (`@/lib/github-api` stays host-side;
 * credential storage + the Nango integration upsert + the GitHub REST calls
 * all run host-side inside each member).
 *
 * TRUST (cinatra#172 Stage H4): read and write members share this ONE
 * in-process capability id (server-side registry only — never
 * client-resolvable). The WRITERS are `saveOAuthSettings` (persists the OAuth
 * app credentials and ensures the Nango integration) and
 * `saveRepositorySelection` (persists the repository binding after validating
 * it against the live connection's repository list). AUTHORIZATION GATING
 * STAYS EXTENSION-SIDE: the connector's "use server" actions keep their
 * `requireExtensionAction(<pkg>, "manage")` gates — the identical posture the
 * static `@/lib/github-api` imports carried before the cutover. */
export type HostGitHubConnectionService = {
  /** Aggregate connection status for the settings page badge + Nango card. */
  getStatus(): Promise<{
    status: "connected" | "incomplete" | "not_connected";
    detail?: string;
    accountName?: string;
    accountEmail?: string;
    settingsConfigured: boolean;
    selectedRepositoryFullName?: string;
    selectedRepositoryUrl?: string;
  }>;
  /** OAuth app settings document (Nango-resolved credentials + stored
   * repository selection; `scopes` is the host's pinned scope set). The
   * stored personal-access-token fallback is NOT published here — it belongs
   * to the host's skills-configuration fallback path and stays host-side
   * (least-privilege hardening over the static import this replaces). */
  getOAuthSettings(): Promise<{
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    scopes: string[];
    selectedRepositoryFullName?: string;
    selectedRepositoryUrl?: string;
  }>;
  /** Repositories reachable through the live connection (sorted by name). */
  listRepositories(): Promise<
    Array<{
      id: number;
      owner: string;
      repo: string;
      fullName: string;
      url: string;
      visibility: "private" | "public";
      permissions: {
        admin: boolean;
        maintain: boolean;
        push: boolean;
        triage: boolean;
        pull: boolean;
      };
    }>
  >;
  /** WRITER — persist OAuth app credentials + ensure the Nango integration.
   * Returns the persisted settings document. */
  saveOAuthSettings(input: {
    clientId?: string;
    clientSecret?: string;
  }): Promise<unknown>;
  /** WRITER — persist the repository selection (validated against the live
   * connection; throws on an unknown repository). Returns the selected row. */
  saveRepositorySelection(input: { repositoryFullName?: string }): Promise<unknown>;
};

/** Structural LinkedIn account row threading through the linkedin connection
 * service (`@/lib/linkedin-api`'s `LinkedInAccountConnection` is the
 * host-side authority). TOKEN MATERIAL IS DELIBERATELY ABSENT: the host
 * service STRIPS `accessToken`/`tokenExpiresAt` from every row it publishes
 * (least-privilege hardening over the static import this replaces — the
 * legacy stored row may carry a bearer, and the `linkedin_accounts_list` MCP
 * primitive returns these rows to callers). The publish path resolves tokens
 * host-side from the underlying store and never needs them here. */
export type LinkedInAccountRowShape = {
  id: string;
  memberId: string;
  name: string;
  email?: string;
  profileUrl?: string;
  destinations: Array<{
    id: string;
    type: "member" | "organization";
    name: string;
    urn?: string;
  }>;
  createdAt: string;
  updatedAt: string;
};

/** LinkedIn connection-admin + publish surface (`@/lib/linkedin-api` stays
 * host-side; token resolution, the LinkedIn REST calls, and the API logging
 * all run host-side inside each member).
 *
 * TRUST (cinatra#172 Stage H4): this is one of the two COARSE transport
 * services the H4 design flags — read members and the publish WRITER share
 * this ONE in-process capability id (server-side registry only). The WRITER
 * is `publishPost`: it publishes PUBLIC content to the remote LinkedIn
 * network (member feed or organization page). AUTHORIZATION GATING STAYS
 * EXTENSION-SIDE / DISPATCH-SIDE: the consuming MCP primitive handlers sit
 * behind the host's MCP dispatch + actor gating, and the social-media
 * transport publish path sits behind the host facade's routing — the
 * identical posture the static `@/lib/linkedin-api` imports carried before
 * the cutover (no member is client-resolvable). */
export type HostLinkedInConnectionService = {
  /** Aggregate status for the connector's `linkedin_status` primitive. */
  getStatus(): Promise<{ status: "connected" | "not_connected"; detail: string }>;
  /** Full settings document (Nango-resolved credentials + account rows). */
  getSettings(): Promise<{
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    accounts: LinkedInAccountRowShape[];
    loggingEnabled?: boolean;
  }>;
  /** Connected account rows (updatedAt-desc). */
  listAccounts(): Promise<LinkedInAccountRowShape[]>;
  /** Publish destinations (app-scope account destinations, or user-scope
   * Nango connections when `scope: "user"`). */
  listDestinations(options?: { scope?: "app" | "user"; userId?: string }): Promise<
    Array<{
      linkedinAccountId: string;
      linkedinAccountName: string;
      destinationType: "member" | "organization";
      destinationId: string;
      destinationName: string;
      authorUrn: string;
    }>
  >;
  /** WRITER — publish a post to the remote LinkedIn network. */
  publishPost(input: {
    linkedinAccountId: string;
    destinationType: "member" | "organization";
    destinationId: string;
    content: string;
    userId?: string;
  }): Promise<{ postUrn: string; postUrl: string }>;
};

/** YouTube OAuth access-token mint over the saved Nango binding
 * (`@/lib/youtube-api` stays host-side; the Nango credential refresh runs
 * host-side inside the member).
 *
 * TRUST (cinatra#172 Stage H4): single READER member, no writers. The minted
 * bearer is returned IN-PROCESS to the media-feeds scraper (which forwards
 * it only to Google's YouTube Data API) and must never cross any other wire
 * boundary — the identical posture the static `@/lib/youtube-api` import
 * carried before the cutover. */
export type HostYouTubeConnectionService = {
  /** Nango-backed OAuth2 access-token mint. Returns null when Nango is
   * unconfigured or the resolved credentials are not a usable OAUTH2 bearer;
   * with no SAVED connection it still attempts the legacy fixed Nango
   * connection id before giving up, and a failing Nango credential resolution
   * REJECTS (it is not folded to null) — identical semantics to the static
   * `getConfiguredYouTubeAccessToken` import this replaces (callers keep
   * their existing null/throw handling). */
  getConfiguredAccessToken(): Promise<string | null>;
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

/** Structural external-MCP server registry row threading through the
 * registry service's read surface. Mirrors the host's
 * `ExternalMcpServerRecord` (`@/lib/external-mcp-registry` is the host-side
 * authority); every field is required — registry rows always carry the full
 * document, so consumers need no skew-optional fields here. */
export type ExternalMcpServerRowShape = {
  id: string;
  label: string;
  serverUrl: string;
  nangoConnectionId: string | null;
  scope: "global" | "org" | "team" | "user" | "workspace";
  orgId: string | null;
  userId: string | null;
  enabled: boolean;
  /** Layer A — native MCP allowlist (`null` = no filter). */
  allowedTools: string[] | null;
  /** Layer B — catalog toolName allowlist enforced by the host proxy
   * (`null` = no filter at the proxy layer). */
  allowedCatalogTools: string[] | null;
  createdAt: string;
  updatedAt: string;
};

/** Global external-MCP server registry: mutation (apify-style first-party
 * registration of an externally-hosted MCP server) + the registry READ and
 * bearer-mint surface (cinatra#172 Stage H4) the twenty transport resolves
 * its live workspace row through.
 *
 * TRUST (cinatra#172 Stage H4): read and write members share this ONE
 * in-process capability id — the registry is server-side only, never
 * client-resolvable. The WRITERS are `upsertServer` and `deleteServer`
 * (pre-existing). `resolveBearer` MINTS the upstream bearer via Nango and
 * returns it IN-PROCESS to the caller; server-side callers are trusted and
 * may hit the upstream directly, BYPASSING the host's Layer-B
 * (`allowed_catalog_tools`) proxy — that proxy remains the LLM-facing
 * enforcement point, and in-process callers are responsible for using the
 * right tool names (the identical posture the static
 * `@/lib/external-mcp-registry` import carried before the cutover; the
 * minted bearer must never cross a wire boundary). */
export type HostExternalMcpRegistryService = {
  upsertServer(input: Record<string, unknown>): void;
  deleteServer(id: string): void;
  // --- registry READ + bearer-mint surface (cinatra#172 Stage H4) ----------
  /** One registry row by id (null when unknown). */
  getServerById(id: string): ExternalMcpServerRowShape | null;
  /** Every registry row (cached host-side, createdAt ASC). */
  listServers(): ExternalMcpServerRowShape[];
  /** Upstream bearer mint for a row via its Nango binding (null when Nango
   * is unconfigured, the row has no connection, or resolution fails —
   * callers treat null as "no auth header"). */
  resolveBearer(server: ExternalMcpServerRowShape): Promise<string | null>;
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

/** The pm-provider capability id concrete PM (project-management) providers
 *  register under (plane-connector today). The host PM bridge
 *  (src/lib/register-pm-providers.ts) feeds the SDK PM provider registry's
 *  external resolver from this capability — same shape as crm-provider. */
export const PM_PROVIDER_CAPABILITY = "pm-provider";

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
