import "server-only";

// Host-side DI wiring for transport connector packages.
//
// Each transport connector exports `register<X>Connector(deps)` as its boot
// contract. Host calls each at boot with concrete impls of the host's runtime
// infra (`@/lib/database`, `@/lib/nango`, etc.). After this module loads, every
// transport connector's functions resolve their deps from the injected
// singleton — `@/lib/*` is no longer reachable from the connector package
// itself.
//
// This file is imported at boot from `src/instrumentation.node.ts` (Next.js
// runtime entry) and the BullMQ worker entrypoint. Adding a new transport
// connector? Add its `register<X>Connector(...)` call here.

import {
  readConnectorConfigFromDatabase,
  writeConnectorConfigToDatabase,
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
import { requireAuthSession } from "@/lib/auth-session";
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

import { registerGmailConnector } from "@cinatra-ai/gmail-connector";
import { registerResendConnector } from "@cinatra-ai/resend-connector";
import { registerGoogleCalendarConnector } from "@cinatra-ai/google-calendar-connector";
import { registerApolloConnector } from "@cinatra-ai/apollo-connector";
import { emitUsageEvent } from "@cinatra-ai/metric-usage-api";
import { registerApifyConnector } from "@cinatra-ai/apify-connector";
import { registerGeminiConnector } from "@cinatra-ai/gemini-connector";
import { registerTailscaleConnector } from "@cinatra-ai/tailscale-connector";
// Import the registrar from the LEAF `deps` subpath (not the package index): the
// openai index transitively pulls @cinatra-ai/skills → @cinatra-ai/agents, which
// (via agents server-actions) imports THIS module — a cycle that left the
// index-re-exported `registerOpenAIConnector` binding undefined at boot. deps.ts
// is leaf (only type imports), so this edge carries no cycle.
import { registerOpenAIConnector } from "@cinatra-ai/openai-connector/deps";
// anthropic-connector binds its host deps. Imported from the
// package INDEX (re-exports `registerAnthropicConnector` from its leaf `./deps`) —
// anthropic's index has no boot cycle, so this matches gemini/apify and resolves in
// every context (the bare `/deps` subpath of a `"type":"module"` package does not).
import { registerAnthropicConnector } from "@cinatra-ai/anthropic-connector";
import { registerDrupalConnector } from "@cinatra-ai/drupal-mcp-connector";
import { registerWordPressConnector } from "@cinatra-ai/wordpress-mcp-connector";
// Nango connection-storage surface — host-owned impls bound into the Nango
// consumer connectors' `deps` slots so those connectors carry no
// `@cinatra-ai/nango-connector` sibling code import (SDK-only decouple).
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
import { deleteWordPressInstance, getWordPressAPISettings } from "@/lib/wordpress-api";
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

/**
 * Wire host-runtime impls into every transport connector. Idempotent — safe
 * to call from multiple boot paths; only the first call wires (subsequent
 * calls no-op so test setups that re-import this module don't double-bind).
 *
 * DI scope:
 * - Host-internal modules behind `@/` (`@/lib/database`,
 *   `@/lib/mcp-pagination`, `@/lib/external-mcp-registry`) → injected here.
 * - Workspace packages (`@cinatra-ai/nango-connector`,
 *   `@cinatra-ai/google-oauth-connection`) → imported directly inside each
 *   connector (legitimate cross-workspace dep, no DI needed).
 */
export function registerTransportConnectors(): void {
  if (_registered) return;
  _registered = true;

  registerGmailConnector({
    readConnectorConfigFromDatabase,
    writeConnectorConfigToDatabase,
    nango: {
      getPrimarySavedConnection: getPrimarySavedNangoConnection,
      clearConnectionRecords: clearNangoConnectionRecords,
    },
    oauth: {
      getStatus: getGoogleOAuthStatus,
      apiFetch: googleApiFetch,
      refreshAccessTokenIfNeeded: refreshGoogleOAuthAccessTokenIfNeeded,
    },
    requireSessionUserId: async () => (await requireAuthSession()).user.id,
  });

  registerResendConnector({
    readConnectorConfigFromDatabase,
    writeConnectorConfigToDatabase,
    encryptSecret,
    decryptSecret,
  });

  registerGoogleCalendarConnector({
    readConnectorConfigFromDatabase,
    writeConnectorConfigToDatabase,
    requireSessionUserId: async () => (await requireAuthSession()).user.id,
  });

  registerApolloConnector({
    nango: {
      isConfigured: isNangoConfigured,
      getPrimarySavedConnection: getPrimarySavedNangoConnection,
      ensureIntegration: ensureNangoIntegration,
      // Apollo imports WITHOUT `connectorKey` (verified write-then-read-back),
      // then saves the pointer explicitly — so the nested-key cast the other
      // connectors need does not apply here.
      importConnection: (input) =>
        importNangoConnection(input as Parameters<typeof importNangoConnection>[0]),
      getCredentials: getNangoCredentials,
      saveConnectionRecord: saveNangoConnectionRecord,
      deleteConnection: deleteNangoConnection,
      clearConnectionRecords: clearNangoConnectionRecords,
      providerConfigKeys: CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
      connectionIds: CINATRA_NANGO_CONNECTION_IDS,
    },
    emitUsage: emitUsageEvent,
  });

  registerApifyConnector({
    readConnectorConfigFromDatabase,
    writeConnectorConfigToDatabase,
    upsertExternalMcpServer,
    deleteExternalMcpServer,
    nango: {
      isConfigured: isNangoConfigured,
      ensureConnectorIntegration: ensureNangoConnectorIntegration,
      // The connector's structural deps type widens the nested `connectorKey` to
      // `string`; the host owns the real `NangoConnectorKey` union and the
      // connector only ever passes a valid key, so cast at this boundary.
      importConnection: (input) =>
        importNangoConnection(input as Parameters<typeof importNangoConnection>[0]),
      getCredentials: getNangoCredentials,
      saveConnectionRecord: saveNangoConnectionRecord,
      removeConnectionRecord: removeNangoConnectionRecord,
      deleteConnection: deleteNangoConnection,
      // Nango-vault bearer header for the connector's external-MCP toolbox.
      buildBearerAuthHeader: buildBearerAuthHeaderFromNango,
      providerConfigKeys: CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
      connectionIds: CINATRA_NANGO_CONNECTION_IDS,
    },
  });

  registerGeminiConnector({
    readConnectorConfigFromDatabase,
    writeConnectorConfigToDatabase,
    buildAppMcpSelfClientHeaders,
    nango: {
      isConfigured: isNangoConfigured,
      getPrimarySavedConnection: getPrimarySavedNangoConnection,
      ensureIntegration: ensureNangoIntegration,
      // Connector's structural deps type omits the nested `connectorKey`; the
      // host owns the real NangoConnectorKey union (see the apify note above).
      importConnection: (input) =>
        importNangoConnection(input as Parameters<typeof importNangoConnection>[0]),
      getCredentials: getNangoCredentials,
      saveConnectionRecord: saveNangoConnectionRecord,
      deleteConnection: deleteNangoConnection,
      clearConnectionRecords: clearNangoConnectionRecords,
      providerConfigKeys: CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
      connectionIds: CINATRA_NANGO_CONNECTION_IDS,
    },
  });

  registerTailscaleConnector({
    readConnectorConfigFromDatabase,
    writeConnectorConfigToDatabase,
    readInstanceIdentity,
    nango: {
      isConfigured: isNangoConfigured,
      ensureIntegration: ensureNangoIntegration,
      // See the apify note above — cast the widened nested `connectorKey`.
      importConnection: (input) =>
        importNangoConnection(input as Parameters<typeof importNangoConnection>[0]),
      getCredentials: getNangoCredentials,
      deleteConnection: deleteNangoConnection,
      clearConnectionRecords: clearNangoConnectionRecords,
      providerConfigKeys: CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
    },
  });

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
      // host owns the real NangoConnectorKey union (see the gemini/apify note).
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
      // owns the real NangoConnectorKey union (same note as openai/gemini/apify).
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

  // Remaining transport connectors (github, linkedin, youtube, media-feeds)
  // have only DOMAIN-lib imports (no host-internal infra deps), so no DI
  // registration is needed. Their `@/lib/<x>-api` imports are domain modules
  // that stay with the connector package.

  // Observability parity: agent extensions log per-package via
  // `[cinatra:extensions:agent]`; skill extensions log a scan summary via
  // flat `[cinatra:extensions]`. Connectors need a boot confirmation so they
  // do not appear unloaded. This line confirms the host-DI bindings ran.
  //
  // Dev-gated for parity: the skill/agent scans are CINATRA_RUNTIME_MODE-gated,
  // so prod/worker boots stay lean (the bindings still run; only the
  // confirmation line is suppressed).
  if (process.env.CINATRA_RUNTIME_MODE === "development") {
    console.info(
      "[register-transport-connectors] wired host-DI connector bindings: " +
        "gmail, resend, google-calendar, apollo, drupal, wordpress " +
        "(github/linkedin/youtube/media-feeds/openai/gemini/claude/nango/" +
        "tailscale/apify/email need no DI — domain-lib or workspace-compiled).",
    );
  }
}

// Auto-register on module load. Boot paths import this module at startup;
// the moment it loads, transport connectors are usable.
registerTransportConnectors();
