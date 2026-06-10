import "server-only";

// Wire the Better Auth oauthClient surface behind the SDK's MCP OAuth-client
// store.
//
// The mcp-client connector's setup page lists the external MCP clients
// registered with this deployment, and its "use server" disconnect action
// deletes one. Both resolve the store via `@cinatra-ai/sdk-extensions` (a leaf
// contract) instead of importing `@/lib/better-auth-db` directly — which would
// re-anchor the package to the host `src/` tree and break standalone
// extraction. This module supplies the ONE host implementation, bound ONCE
// (mirrors register-extension-connector-config-store).
//
// Auto-registers on import; `src/instrumentation.node.ts` imports it at boot.

import { setExtensionMcpOAuthClientStore } from "@cinatra-ai/sdk-extensions";
import {
  listExternalMcpOAuthClients,
  deleteExternalMcpOAuthClient,
} from "@/lib/better-auth-oauth-client";

setExtensionMcpOAuthClientStore({
  listExternalClients: () => listExternalMcpOAuthClients(),
  // The external-scoped delete: internal clients (self-client, LLM clients,
  // assistants, service accounts) stay out of reach even with a forged
  // clientId — same boundary predicate as the list.
  deleteClient: (clientId: string) => deleteExternalMcpOAuthClient(clientId),
});
