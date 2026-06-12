// Generic connector-config accessor for extension server actions.
//
// Extension server actions ("use server" functions a setup/settings page binds
// to a <form>) run OUTSIDE the render-time host-context: they cannot close over
// the `ctx` the dispatch route builds, and they must not import host modules
// (`@/lib/database`) directly — that re-anchors the package to the host `src/`
// tree and breaks standalone extraction.
//
// Mirrors the action-guard seam exactly: the host injects ONE store impl at boot
// via `setExtensionConnectorConfigStore`, and EVERY connector resolves
// `getExtensionConnectorConfig`/`setExtensionConnectorConfig`. There is NO
// per-connector host binding — adding a connector needs zero host change (vs a
// per-connector `registerXConnector(...)` host-service adaptation in each
// connector's `register(ctx)` (host services published by
// register-host-connector-services.ts),
// which is a host hardcode per connector). The SDK owns the shape; the host owns
// the storage. The `packageId` is carried for future per-extension scoping/audit;
// the legacy global-key storage uses the `key` directly today.

export type ExtensionConnectorConfigStore = {
  get<T>(packageId: string, key: string, fallback: T): T;
  set(packageId: string, key: string, value: unknown): void;
  delete(packageId: string, key: string): void;
};

// Anchor on `globalThis` via a namespaced+versioned Symbol so the host boot call
// and an extension's call resolve the SAME slot even when Next.js compiles
// `@cinatra-ai/sdk-extensions` into more than one module instance (server / RSC /
// route segments) — same cross-compilation reason as the action-guard.
const CONNECTOR_CONFIG_STORE_KEY = Symbol.for(
  "@cinatra-ai/sdk-extensions:connector-config-store/v1",
);
type StoreHolder = { [k: symbol]: ExtensionConnectorConfigStore | null | undefined };
const _holder = globalThis as unknown as StoreHolder;

/** Wire the host storage. Called exactly once at boot (host instrumentation). */
export function setExtensionConnectorConfigStore(impl: ExtensionConnectorConfigStore): void {
  _holder[CONNECTOR_CONFIG_STORE_KEY] = impl;
}

/** @internal test-only — clear the store so a fresh wiring is required. */
export function _resetExtensionConnectorConfigStoreForTests(): void {
  _holder[CONNECTOR_CONFIG_STORE_KEY] = null;
}

function requireStore(): ExtensionConnectorConfigStore {
  const store = _holder[CONNECTOR_CONFIG_STORE_KEY];
  if (!store) {
    throw new Error(
      "[sdk-extensions] getExtensionConnectorConfig/setExtensionConnectorConfig was called before the " +
        "host wired the connector-config store. The host must call setExtensionConnectorConfigStore(...) at boot.",
    );
  }
  return store;
}

export function getExtensionConnectorConfig<T>(packageId: string, key: string, fallback: T): T {
  return requireStore().get(packageId, key, fallback);
}

export function setExtensionConnectorConfig(packageId: string, key: string, value: unknown): void {
  requireStore().set(packageId, key, value);
}

export function deleteExtensionConnectorConfig(packageId: string, key: string): void {
  requireStore().delete(packageId, key);
}
