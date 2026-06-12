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
  type HostMcpPaginationService,
  type HostContentEditorDispatchService,
  type HostDrupalMcpService,
  type HostWordPressMcpService,
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
// The connector-authored nango-system surface (cinatra#151 Stage 1): resolved
// at CALL time behind the deprecation-window compat shim below — activation
// order never matters.
import { requireNangoSystem } from "@/lib/nango-system";
import type { NangoSystemSurface } from "@cinatra-ai/sdk-extensions";
// Shared host-side A2A content-editor dispatch helper (drupal + wordpress
// content-editor connectors). Carries the @cinatra-ai/llm + @cinatra-ai/a2a
// runtime edges host-side so neither connector imports them.
import { dispatchContentEditorViaA2A } from "./host-content-editor-dispatch";
// WordPress instance settings + hard-delete + LinkedIn account
// materialization for the nango connection-save flow — published as the
// BLOCKING `nango-connection-materializer` capability and the
// `wordpress-mcp` per-concern service.
import { deleteWordPressInstance, getWordPressAPISettings, saveWordPressInstanceFromNangoConnection } from "@/lib/wordpress-api";
import { saveLinkedInAccountFromNangoConnection } from "@/lib/linkedin-api";
// External-MCP toolbox surfaces — instance settings, the cached reachability
// probes, endpoint resolution, and the private-URL policy stay host-side and
// are published as the `wordpress-mcp` / `drupal-mcp` per-concern services so
// the connectors' `mcp-toolbox` modules carry no `@/` edge.
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

  // DEPRECATION-WINDOW COMPAT SHIM — the legacy nango connection-storage id.
  // The `@cinatra-ai/host:nango-connection-storage` adapter is RETIRED from
  // the SDK contract and from every in-tree consumer (each resolves the
  // connector-authored `nango-system` surface directly, cinatra#151 Stage 3).
  // The string id stays published ONLY for already-installed runtime
  // package-store digests (/data/extensions/packages) that predate the
  // re-point — their lazy resolution must keep working across a host upgrade
  // until the marketplace update path refreshes them. Removal is a NAMED
  // deliverable of the epic's governance end-state (cinatra#151 Stage 7).
  // Every member resolves the surface at CALL time; the const key maps are
  // getters for the same reason (this module evaluates at boot, BEFORE
  // activation).
  register("@cinatra-ai/host:nango-connection-storage", {
    isConfigured: () => requireNangoSystem().isNangoConfigured(),
    getStatus: () => requireNangoSystem().getNangoStatus(),
    getFrontendConfig: () => requireNangoSystem().getNangoFrontendConfig(),
    getPrimarySavedConnection: (
      ...args: Parameters<NangoSystemSurface["getPrimarySavedNangoConnection"]>
    ) => requireNangoSystem().getPrimarySavedNangoConnection(...args),
    ensureIntegration: (...args: Parameters<NangoSystemSurface["ensureNangoIntegration"]>) =>
      requireNangoSystem().ensureNangoIntegration(...args),
    ensureConnectorIntegration: (
      ...args: Parameters<NangoSystemSurface["ensureNangoConnectorIntegration"]>
    ) => requireNangoSystem().ensureNangoConnectorIntegration(...args),
    importConnection: (...args: Parameters<NangoSystemSurface["importNangoConnection"]>) =>
      requireNangoSystem().importNangoConnection(...args),
    getCredentials: (...args: Parameters<NangoSystemSurface["getNangoCredentials"]>) =>
      requireNangoSystem().getNangoCredentials(...args),
    saveConnectionRecord: (...args: Parameters<NangoSystemSurface["saveNangoConnectionRecord"]>) =>
      requireNangoSystem().saveNangoConnectionRecord(...args),
    removeConnectionRecord: (
      ...args: Parameters<NangoSystemSurface["removeNangoConnectionRecord"]>
    ) => requireNangoSystem().removeNangoConnectionRecord(...args),
    deleteConnection: (...args: Parameters<NangoSystemSurface["deleteNangoConnection"]>) =>
      requireNangoSystem().deleteNangoConnection(...args),
    clearConnectionRecords: (
      ...args: Parameters<NangoSystemSurface["clearNangoConnectionRecords"]>
    ) => requireNangoSystem().clearNangoConnectionRecords(...args),
    buildBearerAuthHeader: (
      ...args: Parameters<NangoSystemSurface["buildBearerAuthHeaderFromNango"]>
    ) => requireNangoSystem().buildBearerAuthHeaderFromNango(...args),
    get providerConfigKeys() {
      return requireNangoSystem().providerConfigKeys;
    },
    get connectionIds() {
      return requireNangoSystem().connectionIds;
    },
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

  register(svc.drupalMcp, {
    listInstances: () => getDrupalAPISettings().instances,
    probe: probeDrupalMcp,
    resolveServerUrl: resolveDrupalMcpServerUrl,
    isPrivateUrl,
  } satisfies HostDrupalMcpService);

  register(svc.wordpressMcp, {
    listInstances: () => getWordPressAPISettings().instances,
    probeAdapter: probeWordPressInstanceMcpAdapter,
    resolveServerUrl: resolveWordPressMcpFallbackEndpoint,
    isPrivateUrl,
    // Instance hard-delete behind the connector's manage-gated relocated
    // action. Wrapped to discard the host fn's return (the contract is
    // Promise<void>).
    deleteInstance: async (id) => {
      await deleteWordPressInstance(id);
    },
  } satisfies HostWordPressMcpService);

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

  // Remaining transport connectors (github, linkedin, youtube, media-feeds)
  // have only DOMAIN-lib imports (no host-internal infra deps), so no DI
  // registration is needed. Their `@/lib/<x>-api` imports are domain modules
  // that stay with the connector package.

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
