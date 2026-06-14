// Host-injected MCP OAuth-client store for the mcp-client connector.
//
// The connector's setup page lists every external MCP client (Claude Desktop,
// Claude.ai, ChatGPT, any other MCP-compatible client) registered with this
// deployment's OAuth server, and its "use server" disconnect action deletes
// one. Neither may import host modules (`@/lib/better-auth-db`) directly —
// that re-anchors the package to the host `src/` tree and breaks standalone
// extraction — and the action additionally runs OUTSIDE the render-time
// host-context (no `ctx`).
//
// Instead the host injects ONE store implementation at boot via
// `setExtensionMcpOAuthClientStore`, and the connector resolves it through
// `listExternalMcpOAuthClients` / `deleteExternalMcpOAuthClient`. The SDK
// stays a leaf contract — it owns the shape, the host owns the binding (to
// its OAuth-provider client storage). This is a DI slot (same class as
// `action-guard` / `connector-config` / `a2a-connection-contract`), NOT a new
// `ctx` host-port, so it does not bump the SDK ABI version.

import { createHostDepsSlot } from "./dependencies";

/** An externally-registered MCP OAuth client. */
export type ExternalMcpOAuthClient = {
  id: string;
  clientId: string;
  name: string | null;
  redirectURLs: string[];
  createdAt: Date | null;
  updatedAt: Date | null;
};

/**
 * The host-supplied OAuth-client surface. Bound once at boot to the host's
 * OAuth-provider client table. `deleteClient` MUST be resolved only AFTER the
 * connector's action has passed `requireExtensionAction(pkg, "manage")`.
 */
export type ExtensionMcpOAuthClientStore = {
  /**
   * Externally-registered MCP clients only, newest first — the host impl
   * excludes its own internal OAuth clients (app self-client, per-LLM-provider
   * clients, assistant users).
   */
  listExternalClients(): Promise<ExternalMcpOAuthClient[]>;
  /** Delete one OAuth-client registration by clientId. */
  deleteClient(clientId: string): Promise<void>;
};

// Anchor the store on `globalThis` via a namespaced+versioned Symbol so the
// host boot call and the connector's calls resolve the SAME slot even when
// Next.js compiles `@cinatra-ai/sdk-extensions` into more than one module
// instance (server / RSC / route segments) — same cross-compilation reason as
// the action-guard. Built on the shared `createHostDepsSlot` primitive (see
// ./dependencies); the slot identity (the `Symbol.for` key) is unchanged.
const _slot = createHostDepsSlot<ExtensionMcpOAuthClientStore>(
  "@cinatra-ai/sdk-extensions:mcp-oauth-client-store/v1",
);

/** Wire the host store. Called exactly once at boot (host instrumentation). */
export function setExtensionMcpOAuthClientStore(impl: ExtensionMcpOAuthClientStore): void {
  _slot.set(impl);
}

/** @internal test-only — clear the store so a fresh wiring is required. */
export function _resetExtensionMcpOAuthClientStoreForTests(): void {
  _slot.reset();
}

function requireStore(): ExtensionMcpOAuthClientStore {
  return _slot.require(
    "[sdk-extensions] listExternalMcpOAuthClients/deleteExternalMcpOAuthClient was called before " +
      "the host wired the MCP OAuth-client store. The host must call setExtensionMcpOAuthClientStore(...) at boot.",
  );
}

// `async` so an unwired store always surfaces as a rejected promise (the
// callers' natural error path), never a synchronous throw from a Promise-
// returning signature.
export async function listExternalMcpOAuthClients(): Promise<ExternalMcpOAuthClient[]> {
  return requireStore().listExternalClients();
}

export async function deleteExternalMcpOAuthClient(clientId: string): Promise<void> {
  return requireStore().deleteClient(clientId);
}
