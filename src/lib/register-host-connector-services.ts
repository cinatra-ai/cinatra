import "server-only";

// Host-side publication of the PER-CONCERN connector services.
//
// Transport-DI inversion COMPLETE (cinatra#151 Stage 3): every transport
// connector that needs host infra ships a `serverEntry` (`register(ctx)`)
// and BINDS ITSELF at activation — the StaticBundleLoader (dev) /
// RuntimePackageLoader (prod package store) discovers it from the generated
// manifest and calls `register(ctx)`; the connector adapts the host services
// this module publishes into its own deps slot via
// `ctx.capabilities.resolveProviders(<id>)`. Adding or removing a transport
// extension requires NO edit to this file — the manifest + capability
// registry carry the wiring, and this module names NO extension package.
//
// This file is imported at boot from `src/instrumentation.node.ts` (Next.js
// runtime entry) and the BullMQ worker boot path, BEFORE extension
// activation runs — so an activating `register(ctx)` always finds the
// services already published. `@/lib/*` is not reachable from any connector
// package itself.

import {
  readConnectorConfigFromDatabase,
  writeConnectorConfigToDatabase,
  deleteConnectorConfig,
  readOpenAIConnectionFromDatabase,
  readAnthropicConnectionFromDatabase,
} from "@/lib/database";
import {
  decodeCursor,
  buildListPage,
} from "@/lib/mcp-pagination";
// External-MCP registry mutation + the registry READ/bearer-mint surface
// (cinatra#172 Stage H4): the twenty transport resolves its live workspace
// row + upstream bearer through the extended `external-mcp-registry` service
// so `twenty-mcp-call.ts` carries no `@/` edge. The bearer mint is trusted
// in-process plumbing — see the contract's TRUST note.
import {
  upsertExternalMcpServer,
  deleteExternalMcpServer,
  getExternalMcpServerById,
  listExternalMcpServers,
  resolveExternalMcpServerBearer,
} from "@/lib/external-mcp-registry";
import { encryptSecret, decryptSecret } from "@/lib/instance-secrets";
import { buildAppMcpSelfClientHeaders } from "@/lib/mcp-self-client";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import { isAppDevelopmentMode } from "@/lib/runtime-mode";
import { createNotification } from "@/lib/notifications";
import { registerCapabilityProvider } from "@/lib/extension-capabilities-registry";
import {
  type NangoConnectionMaterializer,
  type NangoConnectionMaterializerInput,
  type HostMcpPaginationService,
  type HostContentEditorDispatchService,
  type HostDrupalMcpService,
  type HostDrupalWidgetAuthService,
  type HostWordPressMcpService,
  type HostWordPressContentService,
  type HostInstanceWriteAuthorityService,
  type HostWordPressWidgetAuthService,
  type WordPressInstanceRowShape,
  type HostExternalMcpRegistryService,
  type HostGitHubConnectionService,
  type HostLinkedInConnectionService,
  type HostYouTubeConnectionService,
  type HostRuntimeModeService,
  type HostNotificationsService,
  type HostSkillsCatalogService,
  type HostOpenAIConnectionService,
  type HostAnthropicConnectionService,
  getObjectsProviderOrNull,
  lookupCrmProvider,
  requireExtensionAction,
} from "@cinatra-ai/sdk-extensions";
import {
  HOST_CONNECTOR_SERVICE_CAPABILITIES,
  NANGO_CONNECTION_MATERIALIZER_CAPABILITY,
} from "@cinatra-ai/sdk-extensions/internal";
import {
  getGoogleOAuthStatus,
  googleApiFetch,
  refreshGoogleOAuthAccessTokenIfNeeded,
} from "@cinatra-ai/google-oauth-connection";
import {
  readOpenAIConnection,
  updateOpenAIConnection,
  clearOpenAIConnection,
  updateOpenAILoggingEnabled,
} from "@/lib/openai-connection-store";
// Shared host-side A2A content-editor dispatch helper (drupal + wordpress
// content-editor connectors). Carries the @cinatra-ai/llm + @cinatra-ai/a2a
// runtime edges host-side so neither connector imports them.
import { dispatchContentEditorViaA2A } from "./host-content-editor-dispatch";
// Per-user / per-connector-instance WRITE authority for the CMS content path
// (cinatra#409): the host-owned authority the wordpress/drupal content-editor
// connectors call before EVERY write primitive. It resolves the TRUSTED user
// actor host-side (never from connector input), fails closed on no actor, and
// delegates to the existing per-instance connector-authority policy. The
// package whose policy is evaluated is host-bound (allowlist-validated in
// `selectForPackage`) — never caller-supplied.
import {
  createInstanceListAuthority,
  createInstanceWriteAuthorityService,
} from "./connector-instance-write-authority";
// WordPress instance settings + hard-delete + LinkedIn account
// materialization for the nango connection-save flow — published as the
// BLOCKING `nango-connection-materializer` capability and the
// `wordpress-mcp` per-concern service. The connection/instance-admin reads,
// the remote webhook-subscription client, and the post/media content surface
// (cinatra#172 Stage H3) are published as the extended `wordpress-mcp` and
// the NEW `wordpress-content` services so the wordpress connectors' settings
// and handler modules carry no `@/` edge.
import {
  createWordPressDraft,
  deleteWordPressInstance,
  deleteWordPressPost,
  deleteWordPressWebhookSubscription,
  getWordPressAPISettings,
  getWordPressAPIStatus,
  listPublishedWordPressPosts,
  listWordPressWebhookSubscriptions,
  readWordPressInstanceById,
  readWordPressPost,
  readWordPressPostStatus,
  registerWordPressWebhookSubscription,
  saveWordPressInstanceFromNangoConnection,
  updateWordPressDraftMeta,
  updateWordPressPost,
  uploadWordPressMedia,
  type WordPressInstanceSettings,
} from "@/lib/wordpress-api";
// LinkedIn account materialization for the nango connection-save flow + the
// connection-admin/publish surface (cinatra#172 Stage H4) published as the
// `linkedin-connection` per-concern service so the connector's settings page,
// transport adapter, and MCP handlers carry no `@/` edge. `publishLinkedInPost`
// is the service's WRITER — see the contract's TRUST note.
import {
  getLinkedInAPISettings,
  getLinkedInAPIStatus,
  listLinkedInAccounts,
  listLinkedInDestinations,
  publishLinkedInPost,
  saveLinkedInAccountFromNangoConnection,
} from "@/lib/linkedin-api";
// GitHub OAuth/connection-admin surface (cinatra#172 Stage H4): published as
// the `github-connection` per-concern service so the connector's settings
// page + manage-gated "use server" actions carry no `@/` edge.
import {
  getGitHubAPIStatus,
  getGitHubOAuthSettings,
  listGitHubRepositories,
  saveGitHubOAuthSettings,
  saveGitHubRepositorySelection,
} from "@/lib/github-api";
// YouTube OAuth token mint (cinatra#172 Stage H4): published as the
// `youtube-connection` per-concern service so the media-feeds connector's
// MCP handlers carry no `@/` edge (the scraper receives the mint function).
import { getConfiguredYouTubeAccessToken } from "@/lib/youtube-api";
// External-MCP toolbox surfaces — instance settings, the cached reachability
// probes, endpoint resolution, and the private-URL policy stay host-side and
// are published as the `wordpress-mcp` / `drupal-mcp` per-concern services so
// the connectors' `mcp-toolbox` modules carry no `@/` edge.
import {
  isPrivateUrl,
  probeWordPressInstanceMcpAdapter,
  resolveWordPressMcpEndpoint,
  resolveWordPressMcpFallbackEndpoint,
} from "@/lib/wordpress-mcp-connection";
// Widget auth-config storage for the wordpress assistant widget (cinatra#172
// Stage H3): published as the `wordpress-widget-auth` per-concern service
// (the webhook HMAC verification stays host-only).
import {
  generateWidgetAuthConfig as generateWordPressWidgetAuthConfig,
  readWidgetAuthConfig as readWordPressWidgetAuthConfig,
} from "@/lib/wordpress-widget-auth";
import {
  getDrupalMcpInstanceStatuses,
  probeDrupalMcp,
  resolveDrupalMcpServerUrl,
} from "@/lib/drupal-mcp-connection";
// Drupal instance-admin surface (cinatra#172 Stage H2): the connector settings
// page's save/delete/status moved behind the extended `drupal-mcp` service so
// the connector's settings/handlers modules carry no `@/` edge. The write
// members stay behind the connector's manage-gated "use server" actions.
import {
  deleteDrupalInstance,
  getDrupalAPISettings,
  getDrupalAPIStatus,
  saveDrupalInstance,
} from "@/lib/drupal-api";
// Widget auth-config storage for the drupal assistant widget (cinatra#172
// Stage H2): published as the `drupal-widget-auth` per-concern service.
import {
  generateDrupalWidgetAuthConfig,
  readDrupalWidgetAuthConfig,
} from "@/lib/drupal-widget-auth";

let _registered = false;

/** The provider key the host registers its per-concern service impls under in
 * the capability registry. Not an extension package name (reserved host id). */
const HOST_PROVIDER_PACKAGE = "@cinatra-ai/host";

/**
 * Publish the per-concern host connector services into the capability
 * registry. A serverEntry transport's `register(ctx)` resolves exactly the
 * concerns it needs via `ctx.capabilities.resolveProviders(<id>)` and adapts
 * them into its own deps slot — the host names no transport here. Idempotent
 * — safe to call from multiple boot paths; only the first call publishes
 * (subsequent calls no-op so test setups that re-import this module don't
 * double-publish).
 */
export function registerHostConnectorServices(): void {
  if (_registered) return;
  _registered = true;

  const svc = HOST_CONNECTOR_SERVICE_CAPABILITIES;
  const register = (capability: string, impl: unknown) =>
    registerCapabilityProvider(capability, { packageName: HOST_PROVIDER_PACKAGE, impl });

  register(svc.connectorConfig, {
    read: readConnectorConfigFromDatabase,
    write: writeConnectorConfigToDatabase,
    // PHYSICAL row delete — the nango legacy-key purge (security-reviewed:
    // the dead, untrusted key must be REMOVED, never blanked) binds this
    // member through its injected config store.
    delete: deleteConnectorConfig,
  });

  // BLOCKING nango connection-save materializers (linkedin account row +
  // wordpress instance row). One host provider; dispatches by connectorKey and
  // reports `handled` so the nango save path can fail loud on a key that
  // requires materialization but finds no handler. Failures propagate — the
  // save FAILS, exactly the inline semantics the save body carried when it
  // imported these host modules directly.
  const hostNangoMaterializer: NangoConnectionMaterializer = {
    materialize: async (input: NangoConnectionMaterializerInput) => {
      if (input.connectorKey === "wordpress") {
        const siteUrl = input.siteUrl?.trim();
        if (!siteUrl) {
          throw new Error("Enter the WordPress site domain before connecting with Nango.");
        }
        await saveWordPressInstanceFromNangoConnection({
          siteUrl,
          providerConfigKey: input.providerConfigKey,
          connectionId: input.connectionId,
        });
        return { handled: true };
      }
      if (input.connectorKey === "linkedin") {
        await saveLinkedInAccountFromNangoConnection({
          providerConfigKey: input.providerConfigKey,
          connectionId: input.connectionId,
        });
        return { handled: true };
      }
      return { handled: false };
    },
  };
  register(NANGO_CONNECTION_MATERIALIZER_CAPABILITY, hostNangoMaterializer);

  // The legacy `@cinatra-ai/host:nango-connection-storage` id is FULLY
  // RETIRED (cinatra#151 Stage 7 — the epic's governance end-state). It was
  // removed from the SDK contract and every in-tree consumer by the
  // transport-DI inversion (Stage 3) and survived here only as a
  // deprecation-window compat shim for runtime package-store digests
  // installed before the re-point; that window is closed. A digest that old
  // gets a capability-resolution miss at call time and must be refreshed
  // from the marketplace (every current package resolves the
  // connector-authored `nango-system` surface directly). The miss is thrown
  // by the stale package's OWN bundled code — the host deliberately does NOT
  // resurrect the id with a tombstone provider (the Stage 7 pin: the id
  // resolves to NOTHING, host-connector-services-publication.test.ts).
  // Operator remediation — an installed digest that predates a host
  // capability re-point is refreshed via the marketplace hot-update path;
  // for a first-party connector that refresh is only meaningful AFTER the
  // cinatra#161 republish wave (earlier refreshes hit the built-artifacts-
  // only install gate: loud, old digest stays active). Runbook:
  // docs/extension-server-entry-contract.md ("refreshing a stale digest").

  register(svc.googleOAuth, {
    getStatus: getGoogleOAuthStatus,
    apiFetch: googleApiFetch,
    refreshAccessTokenIfNeeded: refreshGoogleOAuthAccessTokenIfNeeded,
  });

  register(svc.secretsCodec, { encryptSecret, decryptSecret });

  register(svc.externalMcpRegistry, {
    upsertServer: upsertExternalMcpServer,
    deleteServer: deleteExternalMcpServer,
    // Registry READ + bearer-mint surface (cinatra#172 Stage H4). The bearer
    // mint is trusted in-process plumbing for server-side callers (the twenty
    // transport) — it bypasses the LLM-facing Layer-B proxy by design; see
    // the contract's TRUST note. The minted bearer never crosses a wire
    // boundary other than the upstream MCP call itself.
    getServerById: getExternalMcpServerById,
    listServers: listExternalMcpServers,
    resolveBearer: resolveExternalMcpServerBearer,
  } satisfies HostExternalMcpRegistryService);

  register(svc.mcpSelfClient, { buildHeaders: buildAppMcpSelfClientHeaders });

  register(svc.instanceIdentity, { read: readInstanceIdentity });

  // Objects-integration surface (lazy/guarded host-access cutover): the
  // host-bound objects provider + the capability-aware CRM provider lookup,
  // published as VALUES so a connector's serverEntry graph (which must keep
  // SDK peers type-only — host-peer-value-import ban) can register object
  // types / sync adapters / pointer writers through `ctx.capabilities`.
  register(svc.objectsIntegration, {
    getObjectsProvider: () => getObjectsProviderOrNull(),
    // `lookupCrmProvider` consults the SDK registry AND the external resolver
    // bound by src/lib/register-crm-providers.ts (capability-registered CRM
    // providers), so activation order never matters.
    lookupCrmProvider: (providerId: string) => lookupCrmProvider(providerId) ?? null,
  });

  // Extension-action permission gate as a per-concern service: the SAME
  // enforcement the SDK `requireExtensionAction` slot binds
  // (src/lib/register-extension-action-guard.ts), published as a VALUE so a
  // serverEntry-built action impl can gate without an SDK value import
  // (host-peer-value-import ban). Fail-closed: the SDK slot throws until the
  // guard module has bound it (instrumentation imports it before activation).
  register(svc.extensionActionGuard, {
    require: (packageId: string, mode: "read" | "manage") =>
      requireExtensionAction(packageId, mode),
  });

  // --- transport-DI inversion services (cinatra#151 Stage 3) ---------------
  // The per-concern surfaces the LLM-platform and content-editor MCP
  // serverEntry transports adapt into their own deps slots at activation.

  register(svc.mcpPagination, {
    decodeCursor,
    buildListPage,
  } satisfies HostMcpPaginationService);

  register(svc.contentEditorDispatch, {
    // A2A blocking dispatch to the content-editor agents (host-side bearer
    // mint + external A2A client + history-walk -> reply text).
    dispatch: dispatchContentEditorViaA2A,
  } satisfies HostContentEditorDispatchService);

  // Actor-scoped instance LIST filters — the read-boundary twin of the
  // instance-write-authority `requireWrite` gate, reusing the IDENTICAL
  // machinery (trusted-actor resolution from the MCP/llm frame,
  // live-membership reverify with deny-no-row, sanitized decisionActor,
  // per-instance org-binding + connector-package `use` gate).
  // Returns ONLY the trusted actor's authorized instances, [] fail-closed when
  // no actor/membership resolves. Bound host-side to the connector KIND (never
  // caller input) so the package policy + instance reader are host-controlled.
  const filterAuthorizedDrupalInstances = createInstanceListAuthority("drupal");
  const filterAuthorizedWordPressInstances = createInstanceListAuthority("wordpress");

  register(svc.drupalMcp, {
    listInstances: () => getDrupalAPISettings().instances,
    // ACTOR-SCOPED lister for the external-MCP toolbox-injection path. The host
    // resolves the trusted actor from the MCP request frame and returns ONLY
    // that actor's org-entitled instances; [] fail-closed when no actor resolves.
    // The connector toolbox uses THIS, never the global unscoped `listInstances`.
    listAuthorizedInstances: () =>
      filterAuthorizedDrupalInstances(getDrupalAPISettings().instances),
    probe: probeDrupalMcp,
    resolveServerUrl: resolveDrupalMcpServerUrl,
    isPrivateUrl,
    // Instance-admin surface (cinatra#172 Stage H2). The writers
    // (saveInstance/deleteInstance) sit behind the connector's manage-gated
    // "use server" actions — identical posture to the static imports they
    // replace (see the contract's TRUST note).
    getAPIStatus: getDrupalAPIStatus,
    saveInstance: saveDrupalInstance,
    deleteInstance: deleteDrupalInstance,
    getInstanceStatuses: getDrupalMcpInstanceStatuses,
  } satisfies HostDrupalMcpService);

  // Widget auth-config storage for the drupal assistant widget (cinatra#172
  // Stage H2): `generate` MINTS+PERSISTS a fresh key (manage-gated in the
  // connector); `read` backs the settings page render.
  register(svc.drupalWidgetAuth, {
    read: readDrupalWidgetAuthConfig,
    generate: generateDrupalWidgetAuthConfig,
  } satisfies HostDrupalWidgetAuthService);

  register(svc.wordpressMcp, {
    listInstances: () => getWordPressAPISettings().instances,
    // ACTOR-SCOPED lister, published symmetrically with the Drupal service (the
    // WordPress connector toolbox is already fail-closed via the per-instance
    // `instance-write-authority` gate; this is the additive single-call lister
    // a future toolbox revision can adopt). Same trusted-actor +
    // membership-reverify + per-instance gate.
    listAuthorizedInstances: () =>
      filterAuthorizedWordPressInstances(getWordPressAPISettings().instances),
    probeAdapter: probeWordPressInstanceMcpAdapter,
    resolveServerUrl: resolveWordPressMcpFallbackEndpoint,
    isPrivateUrl,
    // Instance hard-delete behind the connector's manage-gated relocated
    // action. Wrapped to discard the host fn's return (the contract is
    // Promise<void>).
    deleteInstance: async (id) => {
      await deleteWordPressInstance(id);
    },
    // Connection/instance-admin surface (cinatra#172 Stage H3). The webhook
    // writers (register/remove) sit behind the assistant connector's
    // manage-gated "use server" actions — identical posture to the static
    // imports they replace (see the contract's TRUST note).
    getAPIStatus: getWordPressAPIStatus,
    getAPISettings: getWordPressAPISettings,
    readInstanceById: readWordPressInstanceById,
    resolveEndpoint: resolveWordPressMcpEndpoint,
    webhookSubscriptions: {
      list: listWordPressWebhookSubscriptions,
      register: registerWordPressWebhookSubscription,
      remove: deleteWordPressWebhookSubscription,
    },
  } satisfies HostWordPressMcpService);

  // WordPress post/media CONTENT surface (cinatra#172 Stage H3) — a SEPARATE
  // capability id from the connection-focused `wordpress-mcp` service so
  // connection admin and content CRUD never evolve under one id. Basic-auth
  // resolution (Nango on the row's credential binding) runs host-side inside
  // each member. The contract keeps row timestamps OPTIONAL for skew while
  // the host API requires them — host rows always carry them, so the epoch
  // fallback only guards hand-built rows from a skewed companion.
  const asWordPressInstanceRow = (
    instance: WordPressInstanceRowShape,
  ): WordPressInstanceSettings => ({
    ...instance,
    createdAt: instance.createdAt ?? new Date(0).toISOString(),
    updatedAt: instance.updatedAt ?? new Date(0).toISOString(),
  });
  register(svc.wordpressContent, {
    createDraft: (input) =>
      createWordPressDraft({ instance: asWordPressInstanceRow(input.instance), payload: input.payload }),
    readPost: (input) =>
      readWordPressPost({
        instance: asWordPressInstanceRow(input.instance),
        wordpressPostId: input.wordpressPostId,
        postType: input.postType,
      }),
    readPostStatus: (input) =>
      readWordPressPostStatus({
        instance: asWordPressInstanceRow(input.instance),
        wordpressPostId: input.wordpressPostId,
      }),
    listPublishedPosts: (instance, options) =>
      listPublishedWordPressPosts(asWordPressInstanceRow(instance), options),
    deletePost: (input) =>
      deleteWordPressPost({
        instance: asWordPressInstanceRow(input.instance),
        wordpressPostId: input.wordpressPostId,
      }),
    uploadMedia: (input) =>
      uploadWordPressMedia({ ...input, instance: asWordPressInstanceRow(input.instance) }),
    updateDraftMeta: (input) =>
      updateWordPressDraftMeta({
        instance: asWordPressInstanceRow(input.instance),
        wordpressPostId: input.wordpressPostId,
        meta: input.meta,
      }),
    updatePost: (input) =>
      updateWordPressPost({
        instance: asWordPressInstanceRow(input.instance),
        wordpressPostId: input.wordpressPostId,
        postType: input.postType,
        fields: input.fields,
      }),
  } satisfies HostWordPressContentService);

  // Per-user / per-connector-instance WRITE authority (cinatra#409). The
  // wordpress/drupal content-editor MCP connectors resolve this service and
  // call `selectForConnector(<their kind>).requireWrite(...)` at the TOP of
  // every write primitive (after schema-parse + instance resolve, before any
  // host content writer). The host resolves the TRUSTED user actor from the
  // active MCP/llm/cookie frame (NEVER connector input), DENIES fail-closed when
  // no userId+orgId resolve, then enforces TWO host-side gates keyed on the
  // trusted actor's org: (1) PER-INSTANCE — resolves the instance row host-side
  // and asserts its persisted org binding (cinatra#274) == the actor's org, so a
  // forged instanceId (same-org-mismatch or different-org) is DENIED and an
  // unknown/unbound row is DENIED fail-closed; (2) CONNECTOR-PACKAGE — the
  // existing `requireConnectorAuthority` policy (emits a `connector_instance`
  // audit row). `selectForConnector` maps the connector KIND to BOTH the package
  // id and the instance reader host-side — neither is ever caller-supplied.
  register(svc.instanceWriteAuthority, createInstanceWriteAuthorityService() satisfies HostInstanceWriteAuthorityService);

  // Widget auth-config storage for the wordpress assistant widget (cinatra#172
  // Stage H3): `generate` MINTS+PERSISTS a fresh key + webhook secret
  // (manage-gated in the connector); `read` backs the settings page render.
  register(svc.wordpressWidgetAuth, {
    read: readWordPressWidgetAuthConfig,
    generate: generateWordPressWidgetAuthConfig,
  } satisfies HostWordPressWidgetAuthService);

  register(svc.runtimeMode, {
    isDevelopment: isAppDevelopmentMode,
  } satisfies HostRuntimeModeService);

  register(svc.notifications, {
    create: createNotification,
  } satisfies HostNotificationsService);

  // Skills catalog read for shell-tool skill delivery. Lazy `import()` so the
  // @cinatra-ai/skills -> @cinatra-ai/agents boot cycle never rides this
  // module's load: the skills module loads at call time, never boot.
  register(svc.skillsCatalog, {
    read: async () => {
      const { readSkillsCatalog } = await import("@cinatra-ai/skills");
      return readSkillsCatalog();
    },
  } satisfies HostSkillsCatalogService);

  // Provider-named host stores (the `googleOAuth` precedent): the openai /
  // anthropic connection rows live in the host metadata store and are read by
  // host configuration surfaces — NOT relocatable into the extensions.
  register(svc.openaiConnection, {
    readRowFromDatabase: readOpenAIConnectionFromDatabase,
    read: readOpenAIConnection,
    update: updateOpenAIConnection,
    clear: clearOpenAIConnection,
    updateLoggingEnabled: updateOpenAILoggingEnabled,
  } satisfies HostOpenAIConnectionService);

  register(svc.anthropicConnection, {
    readRowFromDatabase: readAnthropicConnectionFromDatabase,
  } satisfies HostAnthropicConnectionService);

  // Chat user-context providers register through each connector's own
  // `register(ctx)` (gmail-connector#7 / google-calendar-connector#7) via the
  // serverEntry loader. The LLM-platform and content-editor MCP transports'
  // deps slots bind the same way since the transport-DI inversion
  // (cinatra#151 Stage 3) — no static registrar call survives here.

  // Transport-tail connection services (cinatra#172 Stage H4): the last four
  // hostInternal edges (github / linkedin / media-feeds / twenty) invert onto
  // per-concern services here — the domain modules (`@/lib/github-api`,
  // `@/lib/linkedin-api`, `@/lib/youtube-api`, `@/lib/external-mcp-registry`)
  // stay host-side; the connectors adapt these services into their own deps
  // slots at activation.

  // GitHub OAuth/connection-admin surface. The writers
  // (saveOAuthSettings / saveRepositorySelection) sit behind the connector's
  // manage-gated "use server" actions — identical posture to the static
  // imports they replace (see the contract's TRUST note).
  register(svc.githubConnection, {
    getStatus: getGitHubAPIStatus,
    // The stored personal-access-token fallback is STRIPPED before
    // publication: it belongs to the host's skills-configuration fallback
    // path, not the connector's settings surface (least-privilege hardening
    // over the static import — codex H4 round-1 finding 2).
    getOAuthSettings: async () => {
      const { personalAccessToken: _hostOnlyPat, ...settings } = await getGitHubOAuthSettings();
      return settings;
    },
    listRepositories: listGitHubRepositories,
    saveOAuthSettings: saveGitHubOAuthSettings,
    saveRepositorySelection: saveGitHubRepositorySelection,
  } satisfies HostGitHubConnectionService);

  // LinkedIn connection-admin + publish surface. `publishPost` is the WRITER
  // (publishes to the remote LinkedIn network) — reached only through the
  // host's MCP dispatch + actor gating and the social-media facade's routing,
  // identical posture to the static imports replaced (contract TRUST note).
  // Token material never leaves the host through this service: legacy stored
  // account rows may carry an OAuth bearer (`accessToken`/`tokenExpiresAt`),
  // and the connector's `linkedin_accounts_list` MCP primitive returns these
  // rows to callers — STRIP both fields from every published row
  // (least-privilege hardening over the static import — codex H4 round-1
  // finding 1). The publish path resolves tokens host-side from the store.
  const stripLinkedInAccountTokens = (
    account: Awaited<ReturnType<typeof listLinkedInAccounts>>[number],
  ) => {
    const { accessToken: _hostOnlyToken, tokenExpiresAt: _hostOnlyExpiry, ...row } = account;
    return row;
  };
  register(svc.linkedinConnection, {
    getStatus: getLinkedInAPIStatus,
    getSettings: async () => {
      const { accounts, ...settings } = await getLinkedInAPISettings();
      return { ...settings, accounts: accounts.map(stripLinkedInAccountTokens) };
    },
    listAccounts: async () => (await listLinkedInAccounts()).map(stripLinkedInAccountTokens),
    listDestinations: listLinkedInDestinations,
    publishPost: publishLinkedInPost,
  } satisfies HostLinkedInConnectionService);

  // YouTube OAuth token mint (single reader; the bearer stays in-process —
  // the media-feeds scraper forwards it only to the YouTube Data API).
  register(svc.youtubeConnection, {
    getConfiguredAccessToken: getConfiguredYouTubeAccessToken,
  } satisfies HostYouTubeConnectionService);

  // Observability parity: agent extensions log per-package via
  // `[cinatra:extensions:agent]`; skill extensions log a scan summary via
  // flat `[cinatra:extensions]`. This line confirms the host-service
  // publication ran. The serverEntry transports log their own activation
  // through the loader result lines.
  //
  // Dev-gated for parity: the skill/agent scans are CINATRA_RUNTIME_MODE-gated,
  // so prod/worker boots stay lean (the publication still runs; only the
  // confirmation line is suppressed).
  if (process.env.CINATRA_RUNTIME_MODE === "development") {
    console.info(
      "[register-host-connector-services] published per-concern host connector " +
        "services (serverEntry transports self-bind at activation).",
    );
  }
}

// Auto-register on module load. Boot paths import this module at startup;
// the moment it loads, the host services are resolvable by activating
// serverEntry transports.
registerHostConnectorServices();
