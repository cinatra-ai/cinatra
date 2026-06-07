// Host-injected blog-connector registration provider (the SDK DI seam that lets a
// site connector self-register into the host's blog-connector facade WITHOUT
// importing a non-SDK first-party package). Mirrors `objects-provider-contract`:
// the host binds ONE provider at boot (`setBlogConnectorProvider`), and a bundled
// site connector's `register(ctx)` calls `registerBlogConnectorViaProvider(...)` —
// importing ONLY `@cinatra-ai/sdk-extensions`, so the connector stays SDK-only
// (the `--strict-sdk-only` import gate) and the host never names any vendor scope.
//
// BOOT-ORDER INDEPENDENCE: a bundled connector's `register(ctx)` may run BEFORE the
// host's `setBlogConnectorProvider` boot call (the static-bundle loader and the
// host binder both run at startup with no enforced order). So a registration that
// arrives before the provider is bound is QUEUED and replayed the moment the host
// binds — neither order strands the connector.

import type { BlogConnector } from "./blog-connector-contract";

/** What the host binds: the one sink that registers a connector into the facade. */
export interface BlogConnectorProvider {
  registerBlogConnector(connector: BlogConnector): void;
}

// Anchor the provider + the pending queue on `globalThis` via namespaced+versioned
// Symbols so the host `setBlogConnectorProvider` boot call and an extension's
// `registerBlogConnectorViaProvider` call resolve the SAME slot even when Next.js
// compiles `@cinatra-ai/sdk-extensions` into more than one module instance (server /
// RSC / route segments / the BullMQ worker bundle) — same reason as the other DI
// contracts.
const BLOG_CONNECTOR_PROVIDER_KEY = Symbol.for("@cinatra-ai/sdk-extensions:blog-connector-provider/v1");
const BLOG_CONNECTOR_PENDING_KEY = Symbol.for("@cinatra-ai/sdk-extensions:blog-connector-pending/v1");

type Holder = {
  [BLOG_CONNECTOR_PROVIDER_KEY]?: BlogConnectorProvider | null;
  [BLOG_CONNECTOR_PENDING_KEY]?: BlogConnector[];
};
const _holder = globalThis as unknown as Holder;

/**
 * Wire the host blog-connector provider. Called once at boot (host instrumentation:
 * src/lib/register-blog-providers.ts). Replays any connectors that registered before
 * the binder ran (boot-order independence), then keeps serving subsequent
 * registrations. Re-calling replaces the impl — tests can swap a stub between blocks.
 */
export function setBlogConnectorProvider(impl: BlogConnectorProvider): void {
  _holder[BLOG_CONNECTOR_PROVIDER_KEY] = impl;
  const pending = _holder[BLOG_CONNECTOR_PENDING_KEY];
  if (pending && pending.length) {
    for (const connector of pending) impl.registerBlogConnector(connector);
    _holder[BLOG_CONNECTOR_PENDING_KEY] = [];
  }
}

/**
 * Register a site connector through the host-bound provider. If the host has not
 * bound the provider yet (the connector activated before the host binder ran), the
 * connector is QUEUED and replayed by the next `setBlogConnectorProvider` call —
 * NEVER silently dropped. Fail-open by design: registration is a boot-time wiring
 * step, not a privileged runtime call, and a queued connector is safe.
 */
export function registerBlogConnectorViaProvider(connector: BlogConnector): void {
  const provider = _holder[BLOG_CONNECTOR_PROVIDER_KEY];
  if (provider) {
    provider.registerBlogConnector(connector);
    return;
  }
  const pending = _holder[BLOG_CONNECTOR_PENDING_KEY] ?? [];
  pending.push(connector);
  _holder[BLOG_CONNECTOR_PENDING_KEY] = pending;
}

/** Resolve the host-bound provider, or null when unbound (e.g. `next build`). */
export function getBlogConnectorProviderOrNull(): BlogConnectorProvider | null {
  return _holder[BLOG_CONNECTOR_PROVIDER_KEY] ?? null;
}

/** @internal test-only — clear the provider + the pending queue. */
export function _resetBlogConnectorProviderForTests(): void {
  _holder[BLOG_CONNECTOR_PROVIDER_KEY] = null;
  _holder[BLOG_CONNECTOR_PENDING_KEY] = [];
}
