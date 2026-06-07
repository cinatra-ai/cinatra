import "server-only";

// Wire the host A2A connection-storage provider behind the SDK's
// `requireA2AConnectionProvider()` contract. The a2a-server-connector's two
// "use server" actions cannot close over the render-time `ctx`, so the host
// injects ONE provider binding the Nango connection-record store (reached
// through the already-baselined `@/lib/nango` shim, never the extension by name)
// + the external-agent-template store (`@cinatra-ai/agents`, a host package).
// Auto-registers on import; `src/instrumentation.node.ts` imports it at boot.

import { setA2AConnectionProvider } from "@cinatra-ai/sdk-extensions";
import {
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
  importNangoConnection,
  saveNangoConnectionRecord,
  removeNangoConnectionRecord,
} from "@/lib/nango";
import {
  upsertExternalAgentTemplate,
  deleteExternalAgentTemplatesByConnectorSlug,
} from "@cinatra-ai/agents";

setA2AConnectionProvider({
  providerConfigKeyFor: () => CINATRA_NANGO_PROVIDER_CONFIG_KEYS.a2aServer,
  // The connector's structural deps type narrows `connectorKey` to "a2aServer";
  // the host owns the real NangoConnectorKey union (see the apify/gemini note).
  importConnection: (input) =>
    importNangoConnection(input as Parameters<typeof importNangoConnection>[0]),
  saveConnectionRecord: (connectorKey, record, opts) =>
    saveNangoConnectionRecord(connectorKey, record, opts),
  removeConnectionRecord: (connectorKey, connectionId) =>
    removeNangoConnectionRecord(connectorKey, connectionId),
  upsertExternalAgentTemplate: (input) => upsertExternalAgentTemplate(input),
  deleteExternalAgentTemplatesByConnectorSlug: (slug) =>
    deleteExternalAgentTemplatesByConnectorSlug(slug),
});
