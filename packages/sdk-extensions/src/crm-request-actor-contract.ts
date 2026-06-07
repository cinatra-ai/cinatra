// Host-injected CRM request-actor resolver for the crm-connector.
//
// The crm-connector's MCP handlers mint a synthetic "pointer actor" for the
// actor-scoped objects_save pointer write, derived from the CURRENT MCP request's
// identity (userId / orgId / platformRole). That identity lives in the host's
// `mcpRequestContextStorage` AsyncLocalStorage (packages/mcp-server) — importing
// it by name re-anchors the connector to the host and breaks standalone
// extraction.
//
// Instead the host injects ONE resolver at boot via `setCrmRequestActorResolver`,
// and the connector calls `requireCrmRequestActorResolver().getActor()`. This is
// a DI slot (same class as action-guard / a2a-connection / google-oauth-connection),
// NOT a new ctx host-port, so it does not bump the SDK ABI version.
//
// NOTE on `platformRole`: it is NOT available on HostAuthSessionPort.getActor()
// (which exposes only userId/orgId), so this dedicated resolver returns it
// verbatim from the request store. The INLINE MCP-handler path is the only caller;
// the BullMQ worker replay path already carries orgId/userId in its job payload
// and rebuilds the actor without touching the request store.

/** The request identity the crm-connector needs to mint a pointer-write actor. */
export type CrmRequestActor = {
  userId: string | null;
  orgId: string | null;
  /** better-auth-derived platform role at the transport boundary (e.g. "platform_admin" | "member"); undefined for userless callers. */
  platformRole?: string;
};

/**
 * The host-supplied resolver. `getActor()` returns the current MCP request's
 * identity, or null when called outside an MCP request frame (the connector then
 * falls back to a userless model actor).
 */
export interface CrmRequestActorResolver {
  getActor(): CrmRequestActor | null;
}

const CRM_REQUEST_ACTOR_RESOLVER_KEY = Symbol.for(
  "@cinatra-ai/sdk-extensions:crm-request-actor-resolver/v1",
);
type ResolverHolder = { [k: symbol]: CrmRequestActorResolver | null | undefined };
const _holder = globalThis as unknown as ResolverHolder;

/**
 * Wire the host CRM request-actor resolver. Called exactly once at boot (host
 * instrumentation). Re-calling replaces — tests can swap a stub between blocks.
 */
export function setCrmRequestActorResolver(impl: CrmRequestActorResolver): void {
  _holder[CRM_REQUEST_ACTOR_RESOLVER_KEY] = impl;
}

/** @internal test-only — clear the resolver so a fresh wiring is required. */
export function _resetCrmRequestActorResolverForTests(): void {
  _holder[CRM_REQUEST_ACTOR_RESOLVER_KEY] = null;
}

/**
 * Resolve the host-bound CRM request-actor resolver. Fails CLOSED (throws) if the
 * host never wired it — an unbound resolver is a boot-wiring bug, never a silent
 * no-op that could mint a mis-scoped pointer-write actor.
 */
export function requireCrmRequestActorResolver(): CrmRequestActorResolver {
  const resolver = _holder[CRM_REQUEST_ACTOR_RESOLVER_KEY];
  if (!resolver) {
    throw new Error(
      "[sdk-extensions] requireCrmRequestActorResolver() was called before the host wired the CRM " +
        "request-actor resolver. The host must call setCrmRequestActorResolver(...) at boot " +
        "(src/lib/register-crm-request-actor.ts, imported from instrumentation.node.ts).",
    );
  }
  return resolver;
}
