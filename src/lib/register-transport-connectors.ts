import "server-only";

// Host-side DI wiring for transport connector packages.
//
// Transport-registration cutover: the transport connectors that ship a `serverEntry`
// (`register(ctx)`) now BIND THEMSELVES at activation — the StaticBundleLoader
// (dev) / RuntimePackageLoader (prod package store) discovers them from the
// generated manifest and calls `register(ctx)`; each connector adapts the
// PER-CONCERN host services this module registers into the generic capability
// registry (legacy connector-config KV, the Nango connection-storage surface,
// google-oauth runtime, the secrets codec, the external-MCP registry, MCP
// self-client headers, instance identity) into its own deps slot. Adding or
// removing such a transport extension requires NO edit to this file — the
// manifest + capability registry carry the wiring.
//
// What REMAINS statically wired here (explicitly out of the the transport-registration cutover scope):
// the LLM-platform connectors (openai, anthropic — LLM-provider extensibility
// is deferred), and the drupal/wordpress content-editor MCP connectors. Their
// `register<X>Connector(deps)` calls stay until their own cutover phase.
//
// This file is imported at boot from `src/instrumentation.node.ts` (Next.js
// runtime entry) and the BullMQ worker boot path. `@/lib/*` is no longer
// reachable from any connector package itself.

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
import {
  upsertExternalMcpServer,
  deleteExternalMcpServer,
} from "@/lib/external-mcp-registry";
import { encryptSecret, decryptSecret } from "@/lib/instance-secrets";
import { buildAppMcpSelfClientHeaders } from "@/lib/mcp-self-client";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import { isAppDevelopmentMode } from "@/lib/runtime-mode";
import { createNotification } from "@/lib/notifications";
import { registerCapabilityProvider } from "@/lib/extension-capabilities-registry";
import {
  HOST_CONNECTOR_SERVICE_CAPABILITIES,
  NANGO_CONNECTION_MATERIALIZER_CAPABILITY,
  type NangoConnectionMaterializer,
  type NangoConnectionMaterializerInput,
  getObjectsProviderOrNull,
  lookupCrmProvider,
  requireExtensionAction,
} from "@cinatra-ai/sdk-extensions";
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

// Import the registrar from the LEAF `deps` subpath (not the package index): the
// openai index transitively pulls @cinatra-ai/skills → @cinatra-ai/agents, which
// (via agents server-actions) imports THIS module — a cycle that left the
// index-re-exported `registerOpenAIConnector` binding undefined at boot. deps.ts
// is leaf (only type imports), so this edge carries no cycle.
import { registerOpenAIConnector } from "@cinatra-ai/openai-connector/deps";
// anthropic-connector binds its host deps. Imported from the
// package INDEX (re-exports `registerAnthropicConnector` from its leaf `./deps`) —
// anthropic's index has no boot cycle, so this matches the drupal/wordpress
// imports and resolves in every context (the bare `/deps` subpath of a
// `"type":"module"` package does not).
import { registerAnthropicConnector } from "@cinatra-ai/anthropic-connector";
import { registerDrupalConnector } from "@cinatra-ai/drupal-mcp-connector";
import { registerWordPressConnector } from "@cinatra-ai/wordpress-mcp-connector";
// Nango connection-storage surface — host-owned impls bound into the remaining
// statically-wired connectors' `deps` slots AND published once as the
// per-concern nango host-service capability the serverEntry transports resolve.
import {
  buildBearerAuthHeaderFromNango,
  CINATRA_NANGO_CONNECTION_IDS,
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
  clearNangoConnectionRecords,
  deleteNangoConnection,
  ensureNangoConnectorIntegration,
  ensureNangoIntegration,
  getNangoCredentials,
  getNangoFrontendConfig,
  getNangoStatus,
  getPrimarySavedNangoConnection,
  importNangoConnection,
  isNangoConfigured,
  removeNangoConnectionRecord,
  saveNangoConnectionRecord,
} from "@cinatra-ai/nango-connector";
// Shared host-side A2A content-editor dispatch helper (drupal + wordpress
// content-editor connectors). Carries the @cinatra-ai/llm + @cinatra-ai/a2a
// runtime edges host-side so neither connector imports them.
import { dispatchContentEditorViaA2A } from "./host-content-editor-dispatch";
// WordPress instance hard-delete — bound into the wordpress connector's
// `deps.deleteInstance` so the connector's relocated delete action carries no
// `@/lib/wordpress-api` edge.
import { deleteWordPressInstance, getWordPressAPISettings, saveWordPressInstanceFromNangoConnection } from "@/lib/wordpress-api";
// LinkedIn/WordPress account materialization for the nango connection-save
// flow — published as the BLOCKING `nango-connection-materializer` capability
// so the nango gateway's save path can await the host-side materializers
// without importing `@/lib/*` (the inline fail-blocking semantics preserved
// behind a capability the connector resolves at save time).
import { saveLinkedInAccountFromNangoConnection } from "@/lib/linkedin-api";
// External-MCP toolbox surfaces — instance settings, the cached reachability
// probes, endpoint resolution, and the private-URL policy stay host-side and
// are bound into the wordpress/drupal connector deps so their `mcp-toolbox`
// modules carry no `@/` edge.
import {
  isPrivateUrl,
  probeWordPressInstanceMcpAdapter,
  resolveWordPressMcpFallbackEndpoint,
} from "@/lib/wordpress-mcp-connection";
import { probeDrupalMcp, resolveDrupalMcpServerUrl } from "@/lib/drupal-mcp-connection";
import { getDrupalAPISettings } from "@/lib/drupal-api";

let _registered = false;

/** The provider key the host registers its per-concern service impls under in
 * the capability registry. Not an extension package name (reserved host id). */
const HOST_PROVIDER_PACKAGE = "@cinatra-ai/host";

/**
 * Publish the per-concern host connector services into the capability
 * registry. A serverEntry transport's `register(ctx)` resolves exactly the
 * concerns it needs via `ctx.capabilities.resolveProviders(<id>)` and adapts
 * them into its own deps slot — the host names no transport here.
 */
function registerHostConnectorServices(): void {
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

  register(svc.nangoConnectionStorage, {
    isConfigured: isNangoConfigured,
    getStatus: getNangoStatus,
    getFrontendConfig: getNangoFrontendConfig,
    getPrimarySavedConnection: getPrimarySavedNangoConnection,
    ensureIntegration: ensureNangoIntegration,
    ensureConnectorIntegration: ensureNangoConnectorIntegration,
    importConnection: importNangoConnection,
    getCredentials: getNangoCredentials,
    saveConnectionRecord: saveNangoConnectionRecord,
    removeConnectionRecord: removeNangoConnectionRecord,
    deleteConnection: deleteNangoConnection,
    clearConnectionRecords: clearNangoConnectionRecords,
    buildBearerAuthHeader: buildBearerAuthHeaderFromNango,
    providerConfigKeys: CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
    connectionIds: CINATRA_NANGO_CONNECTION_IDS,
  });

  register(svc.googleOAuth, {
    getStatus: getGoogleOAuthStatus,
    apiFetch: googleApiFetch,
    refreshAccessTokenIfNeeded: refreshGoogleOAuthAccessTokenIfNeeded,
  });

  register(svc.secretsCodec, { encryptSecret, decryptSecret });

  register(svc.externalMcpRegistry, {
    upsertServer: upsertExternalMcpServer,
    deleteServer: deleteExternalMcpServer,
  });

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
}

/**
 * Wire host-runtime impls into the remaining statically-bound connectors and
 * publish the per-concern host services. Idempotent — safe to call from
 * multiple boot paths; only the first call wires (subsequent calls no-op so
 * test setups that re-import this module don't double-bind).
 */
export function registerTransportConnectors(): void {
  if (_registered) return;
  _registered = true;

  registerHostConnectorServices();

  registerOpenAIConnector({
    readConnectorConfigFromDatabase,
    writeConnectorConfigToDatabase,
    readOpenAIConnectionFromDatabase,
    readOpenAIConnection,
    updateOpenAIConnection,
    clearOpenAIConnection,
    updateOpenAILoggingEnabled,
    buildAppMcpSelfClientHeaders,
    isAppDevelopmentMode,
    createNotification,
    // Nango connection-storage surface (SDK-only decouple): the connector
    // carries no `@cinatra-ai/nango-connector` import and resolves these via
    // `getOpenAIDeps().nango.*`.
    nango: {
      isConfigured: isNangoConfigured,
      getStatus: getNangoStatus,
      getFrontendConfig: getNangoFrontendConfig,
      getPrimarySavedConnection: getPrimarySavedNangoConnection,
      getCredentials: getNangoCredentials,
      ensureIntegration: ensureNangoIntegration,
      // Connector's structural deps type widens the nested `connectorKey`; the
      // host owns the real NangoConnectorKey union and the connector only ever
      // passes a valid key, so cast at this boundary.
      importConnection: (input) =>
        importNangoConnection(input as Parameters<typeof importNangoConnection>[0]),
      deleteConnection: deleteNangoConnection,
      clearConnectionRecords: clearNangoConnectionRecords,
      providerConfigKeys: CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
      connectionIds: CINATRA_NANGO_CONNECTION_IDS,
    },
    // Skills catalog read for shell-tool skill delivery. Lazy `import()` to avoid
    // the openai-index → @cinatra-ai/skills → @cinatra-ai/agents → host boot cycle:
    // defer the skills module load to call-time, never boot.
    readSkillsCatalog: async () => {
      const { readSkillsCatalog } = await import("@cinatra-ai/skills");
      return readSkillsCatalog();
    },
  });

  // anthropic-connector host deps (SDK-only): connector-config
  // + the anthropic connection row + runtime mode + the Nango connection-storage
  // surface, resolved at runtime via `getAnthropicDeps().*` (the connector carries
  // no `@/lib/*` or `@cinatra-ai/nango-connector` import).
  registerAnthropicConnector({
    readConnectorConfigFromDatabase,
    writeConnectorConfigToDatabase,
    readAnthropicConnectionFromDatabase,
    isAppDevelopmentMode,
    nango: {
      isConfigured: isNangoConfigured,
      getStatus: getNangoStatus,
      getFrontendConfig: getNangoFrontendConfig,
      getPrimarySavedConnection: getPrimarySavedNangoConnection,
      getCredentials: getNangoCredentials,
      ensureIntegration: ensureNangoIntegration,
      // Connector's structural deps type widens the nested `connectorKey`; the host
      // owns the real NangoConnectorKey union (same note as the openai block).
      importConnection: (input) =>
        importNangoConnection(input as Parameters<typeof importNangoConnection>[0]),
      deleteConnection: deleteNangoConnection,
      clearConnectionRecords: clearNangoConnectionRecords,
      providerConfigKeys: CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
      connectionIds: CINATRA_NANGO_CONNECTION_IDS,
    },
  });

  registerDrupalConnector({
    decodeCursor,
    buildListPage,
    // A2A blocking dispatch to wayflow-drupal-content-editor (host-side bearer
    // mint + external A2A client + history-walk → reply text).
    dispatchContentEditor: dispatchContentEditorViaA2A,
    // Nango-vault bearer header for the Drupal MCP HTTP client.
    buildNangoBearerHeader: buildBearerAuthHeaderFromNango,
    // External-MCP toolbox surfaces (consumed by the connector's mcp-toolbox
    // module): instance settings + cached probe + endpoint/URL policy.
    listMcpInstances: () => getDrupalAPISettings().instances,
    probeMcp: probeDrupalMcp,
    resolveMcpServerUrl: resolveDrupalMcpServerUrl,
    isPrivateUrl,
    isNangoConfigured,
  });

  registerWordPressConnector({
    decodeCursor,
    buildListPage,
    // A2A blocking dispatch to wordpress-content-editor (shared host helper).
    dispatchContentEditor: dispatchContentEditorViaA2A,
    // Instance hard-delete behind the connector's manage-gated relocated action.
    // Wrapped to discard the host fn's return (the dep contract is Promise<void>).
    deleteInstance: async (id) => {
      await deleteWordPressInstance(id);
    },
    // External-MCP toolbox surfaces (consumed by the connector's mcp-toolbox
    // module): instance settings + cached probe + endpoint/URL policy.
    listMcpInstances: () => getWordPressAPISettings().instances,
    probeMcpAdapter: probeWordPressInstanceMcpAdapter,
    resolveMcpServerUrl: resolveWordPressMcpFallbackEndpoint,
    isPrivateUrl,
  });

  // Chat user-context providers register through each connector's own
  // `register(ctx)` (gmail-connector#7 / google-calendar-connector#7) via the
  // serverEntry loader — the pre-#75 transitional boot bridge that registered
  // the same records here was dropped when the legacy named-import site was
  // removed by the serverEntry cutover (#75). The records carry their own
  // packageName, so registry keying/dedupe is unchanged.

  // Remaining transport connectors (github, linkedin, youtube, media-feeds)
  // have only DOMAIN-lib imports (no host-internal infra deps), so no DI
  // registration is needed. Their `@/lib/<x>-api` imports are domain modules
  // that stay with the connector package.

  // Observability parity: agent extensions log per-package via
  // `[cinatra:extensions:agent]`; skill extensions log a scan summary via
  // flat `[cinatra:extensions]`. This line confirms the host-DI bindings +
  // host-service publication ran. The serverEntry transports log their own
  // activation through the loader result lines.
  //
  // Dev-gated for parity: the skill/agent scans are CINATRA_RUNTIME_MODE-gated,
  // so prod/worker boots stay lean (the bindings still run; only the
  // confirmation line is suppressed).
  if (process.env.CINATRA_RUNTIME_MODE === "development") {
    console.info(
      "[register-transport-connectors] wired host-DI bindings (openai/claude/" +
        "drupal/wordpress) + published per-concern host connector services " +
        "(serverEntry transports self-bind at activation).",
    );
  }
}

// Auto-register on module load. Boot paths import this module at startup;
// the moment it loads, the statically-bound connectors are usable and the
// host services are resolvable by activating serverEntry transports.
registerTransportConnectors();
