import "server-only";

// Host-side registry backing `ctx.ui`.
//
// `ctx.ui` is a REGISTRATION channel, not a bag of host components: an extension
// declares its setup/settings surfaces and named actions at `register(ctx)`; the
// host records them here. This is the schema-driven UI substrate the
// runtime installer reads (build-bundled React setup pages remain a separate
// concern; `ctx.ui` is the portable, install-time-discoverable surface).
//
// Keyed by packageName so an uninstall can drop a package's surfaces/actions
// wholesale (lifecycle parity with the capability registry).
//
// CROSS-COMPILATION SINGLETON: Next.js 16 builds separate bundler compilations
// (instrumentation / route / RSC), each with its own module cache. Extensions
// register surfaces/actions at boot (instrumentation compilation); routes read
// them at request time (route compilation) — so the registry MUST be a true
// per-process singleton, anchored on a namespaced+versioned `Symbol.for(...)`
// key (same pattern as `extension-mcp-registry.ts`).

export type ExtensionUiAction = {
  packageName: string;
  id: string;
  handler: (input: unknown) => Promise<unknown>;
};

type PackageUi = {
  setupSurfaces: Map<string, unknown>;
  settingsSurfaces: Map<string, unknown>;
  actions: Map<string, ExtensionUiAction>;
};

const EXTENSION_UI_REGISTRY_KEY = Symbol.for("@cinatra-ai/host:extension-ui-registry/v1");
type RegistryHolder = { [k: symbol]: Map<string, PackageUi> | undefined };
const _holder = globalThis as unknown as RegistryHolder;
const registry: Map<string, PackageUi> =
  _holder[EXTENSION_UI_REGISTRY_KEY] ??
  (_holder[EXTENSION_UI_REGISTRY_KEY] = new Map<string, PackageUi>());

function ensure(packageName: string): PackageUi {
  let entry = registry.get(packageName);
  if (!entry) {
    entry = { setupSurfaces: new Map(), settingsSurfaces: new Map(), actions: new Map() };
    registry.set(packageName, entry);
  }
  return entry;
}

// Surfaces are opaque `unknown` data. Derive a stable identity so re-registering
// the same surface (e.g. re-activating a package in one process) REPLACES rather
// than appends a duplicate — mirroring the replace-by-id behavior of actions.
// Prefer an explicit `id`, then `title`, falling back to a structural key.
function surfaceId(surface: unknown): string {
  if (surface && typeof surface === "object") {
    const rec = surface as Record<string, unknown>;
    if (typeof rec.id === "string" && rec.id) return rec.id;
    if (typeof rec.title === "string" && rec.title) return rec.title;
  }
  try {
    return JSON.stringify(surface) ?? String(surface);
  } catch {
    return String(surface);
  }
}

export function registerExtensionSetupSurface(packageName: string, surface: unknown): void {
  ensure(packageName).setupSurfaces.set(surfaceId(surface), surface);
}

export function registerExtensionSettingsSurface(packageName: string, surface: unknown): void {
  ensure(packageName).settingsSurfaces.set(surfaceId(surface), surface);
}

export function registerExtensionUiAction(action: ExtensionUiAction): void {
  ensure(action.packageName).actions.set(action.id, action);
}

/** Resolve a registered action handler (host action dispatch). */
export function resolveExtensionUiAction(
  packageName: string,
  actionId: string,
): ExtensionUiAction | null {
  return registry.get(packageName)?.actions.get(actionId) ?? null;
}

/** Lifecycle: drop everything a package registered (uninstall/archive). */
export function invalidateExtensionUiForPackage(packageName: string): void {
  registry.delete(packageName);
}

/** Test/teardown helper. */
export function __resetExtensionUiRegistry(): void {
  registry.clear();
}
