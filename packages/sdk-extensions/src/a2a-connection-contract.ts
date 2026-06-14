// Host-injected A2A connection-storage provider for the a2a-server-connector.
//
// The a2a-server-connector's two "use server" actions (add/remove an external
// A2A agent connection) run OUTSIDE the render-time host-context: they cannot
// close over the `ctx` the dispatch route builds, and they must not import host
// or sibling-extension modules directly (`@/lib/*`, `@cinatra-ai/nango-connector`,
// `@cinatra-ai/agents`) — that re-anchors the package and breaks standalone
// extraction. They also need privileged surfaces (the workspace-global Nango
// connection-record store + the external-agent-template store) that have no
// ctx port.
//
// Instead the host injects ONE provider implementation at boot via
// `setA2AConnectionProvider`, and the connector's actions call
// `requireA2AConnectionProvider()`. The SDK stays a leaf contract — it owns the
// shape, the host owns the binding (to the real nango + agents stores). This is
// a DI slot (same class as `action-guard` / `connector-config`), NOT a new
// `ctx` host-port, so it does not bump the SDK ABI version.

import { createHostDepsSlot } from "./dependencies";

/**
 * The host-supplied A2A connection-storage surface. Bound once at boot to the
 * real Nango connection-record store + the external-agent-template store. All
 * methods are async and MUST be resolved only AFTER the connector's action has
 * passed `requireExtensionAction(pkg, "manage")`.
 */
export interface A2AConnectionProvider {
  /** The Nango provider-config key for the a2aServer connector (a const lookup host-side). */
  providerConfigKeyFor(connectorKey: "a2aServer"): string;
  /** Import (or refresh) the Nango connection; returns null when Nango is unconfigured. */
  importConnection(input: {
    connectorKey: "a2aServer";
    providerConfigKey: string;
    connectionId: string;
    credentials: { type: string; apiKey: string };
    metadata?: Record<string, unknown>;
  }): Promise<unknown | null>;
  /** Persist a connection record in the workspace-global nango_connections store. */
  saveConnectionRecord(
    connectorKey: "a2aServer",
    record: { connectionId: string; providerConfigKey: string; metadata?: Record<string, unknown> },
    opts?: { multiple?: boolean },
  ): Promise<unknown>;
  /** Remove a connection record. */
  removeConnectionRecord(connectorKey: "a2aServer", connectionId: string): Promise<unknown>;
  /** Upsert the external-agent-template row backing this A2A connection. */
  upsertExternalAgentTemplate(input: {
    connectorSlug: string;
    remoteAgentId: string;
    name: string;
    description?: string | null;
    agentUrl: string;
    version?: string | null;
  }): Promise<{ id: string }>;
  /** Delete the external-agent-template rows for a connector slug; returns the count removed. */
  deleteExternalAgentTemplatesByConnectorSlug(connectorSlug: string): Promise<number>;
}

// Anchor the provider on `globalThis` via a namespaced+versioned Symbol so the
// host `setA2AConnectionProvider` boot call and the extension's
// `requireA2AConnectionProvider` action call resolve the SAME slot even when
// Next.js compiles `@cinatra-ai/sdk-extensions` into more than one module
// instance (server / RSC / route segments). Same cross-compilation reason as
// the action-guard + extension-mcp-registry.
// Built on the shared `createHostDepsSlot` primitive (see ./dependencies); the
// slot identity (the `Symbol.for` key) is unchanged.
const _slot = createHostDepsSlot<A2AConnectionProvider>(
  "@cinatra-ai/sdk-extensions:a2a-connection-provider/v1",
);

/**
 * Wire the host A2A connection provider. Called exactly once at boot (host
 * instrumentation). Re-calling replaces the previous impl — tests can swap a
 * stub between blocks.
 */
export function setA2AConnectionProvider(impl: A2AConnectionProvider): void {
  _slot.set(impl);
}

/** @internal test-only — clear the provider so a fresh wiring is required. */
export function _resetA2AConnectionProviderForTests(): void {
  _slot.reset();
}

/**
 * Resolve the host-bound A2A connection provider. Fails CLOSED (throws) if the
 * host never wired it — an unbound provider is a boot-wiring bug, never a silent
 * no-op that could strand a connection in a half-written state.
 */
export function requireA2AConnectionProvider(): A2AConnectionProvider {
  return _slot.require(
    "[sdk-extensions] requireA2AConnectionProvider() was called before the host wired the A2A " +
      "connection provider. The host must call setA2AConnectionProvider(...) at boot " +
      "(src/lib/register-a2a-connection-provider.ts, imported from instrumentation.node.ts).",
  );
}
