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
  deleteNangoConnectionStrict,
} from "@/lib/nango-system";
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
  // Authoritative scrub of the imported API_KEY bearer. UNCONDITIONAL (no
  // `isNangoConfigured` short-circuit): the strict delete propagates a real
  // failure — including Nango-unconfigured, where the scrub can't be confirmed —
  // so the connector's remove action aborts and retains its record rather than
  // dropping it while the bearer lingers. Idempotent on an already-absent
  // connection. (Same posture as the tailscale OAuth authoritative disconnect.)
  deleteConnection: ({ providerConfigKey, connectionId }) =>
    deleteNangoConnectionStrict(providerConfigKey, connectionId),
  upsertExternalAgentTemplate: (input) => upsertExternalAgentTemplate(input),
  deleteExternalAgentTemplatesByConnectorSlug: (slug) =>
    deleteExternalAgentTemplatesByConnectorSlug(slug),
});
