// The HOST MODULE-REGISTRY SHIM (epic #1620 M1 Slice A — cinatra#1630, plan
// §2.2–§2.3). The load-bearing mechanism for sharing ONE React /
// ReactDOM / design-token instance with a main-realm dynamically-loaded renderer.
//
// WHY A SHIM (not an import map to a CDN / a second React): Next/Turbopack does
// NOT expose its internal React as native ESM, and a CDN or separately-bundled
// React would be a SECOND copy — "Invalid hook call", broken context/hooks. So
// the host publishes THIS registry, populated from the host's OWN actual
// React/ReactDOM/token imports, and initialized BEFORE any `import(runtimeURL)`
// (a cold-load-race guard). The ESM façade the host serves for the
// externalized bare specifiers (`react`, `react-dom`, …) re-exports EXACTLY
// these registered singletons, so a renderer's `import "react"` resolves to the
// host's instance — one React identity across host + renderer (AC-10).
//
// The registry is a process/realm-global `Symbol.for` singleton so the host
// graph and the dynamically-imported renderer module (same realm) observe the
// SAME object. Pure data plumbing — no React import here (it holds whatever the
// host injects), so it is unit-testable without a DOM.

import { CLIENT_BUNDLE_EXTERNAL_ALLOWLIST } from "@cinatra-ai/sdk-extensions/artifact-client-bundle";

/** The sanctioned host modules the shim shares (keyed by the exact external
 * specifier a renderer bundle leaves external). */
export interface HostSharedModules {
  react: unknown;
  "react/jsx-runtime": unknown;
  "react/jsx-dev-runtime"?: unknown;
  "react-dom": unknown;
  "react-dom/client": unknown;
  /** The design-token module (`@cinatra-ai/design`). */
  designTokens: unknown;
}

interface HostModuleRegistryState {
  initialized: boolean;
  modules: Partial<Record<string, unknown>>;
}

const REGISTRY_KEY = Symbol.for("@cinatra-ai/host:artifact-host-module-registry/v1");
type Holder = { [REGISTRY_KEY]?: HostModuleRegistryState };
const holder = globalThis as unknown as Holder;

function state(): HostModuleRegistryState {
  return (holder[REGISTRY_KEY] ??= { initialized: false, modules: {} });
}

/**
 * Initialize the shim from the host's ACTUAL module instances, BEFORE any
 * dynamic renderer import runs (call this at the host client entry, ahead of the
 * loader seam). Idempotent — re-initializing with the same instances is a no-op
 * that keeps a stable identity (the cold-load-race guard: the FIRST init wins,
 * so a racing dynamic import can never observe a half-populated registry).
 */
export function initHostModuleRegistry(mods: HostSharedModules): void {
  const s = state();
  if (s.initialized) return;
  s.modules = {
    react: mods.react,
    "react/jsx-runtime": mods["react/jsx-runtime"],
    "react/jsx-dev-runtime": mods["react/jsx-dev-runtime"] ?? mods["react/jsx-runtime"],
    "react-dom": mods["react-dom"],
    "react-dom/client": mods["react-dom/client"],
    "@cinatra-ai/design": mods.designTokens,
  };
  s.initialized = true;
}

/** Whether the registry was initialized (the loader MUST refuse to import a
 * dynamic renderer before this is true — plan §2.3 init-before-import). */
export function isHostModuleRegistryInitialized(): boolean {
  return state().initialized;
}

/**
 * Resolve a sanctioned external specifier to the host's shared instance — what
 * the served ESM façade re-exports so the renderer's externalized bare import
 * gets the HOST singleton. Returns undefined for an uninitialized registry or a
 * non-sanctioned specifier (the externals allowlist is the closed set).
 */
export function getHostModule(specifier: string): unknown {
  if (!isAllowedSharedSpecifier(specifier)) return undefined;
  return state().modules[specifier];
}

/** The closed set of specifiers the shim may serve = the externals allowlist. */
export function isAllowedSharedSpecifier(specifier: string): boolean {
  return CLIENT_BUNDLE_EXTERNAL_ALLOWLIST.includes(specifier);
}

/**
 * The AC-10 conformance assertion: the React a renderer observed (through the
 * façade) MUST be the EXACT host React instance. Throws with a precise message
 * otherwise — a second React copy (the metafile gate is meant to prevent it, but
 * this is the runtime belt) would fail HERE loudly instead of as a cryptic
 * "Invalid hook call". Returns the shared React on success.
 */
export function assertSingleReactIdentity(observedReact: unknown): unknown {
  const hostReact = getHostModule("react");
  if (!isHostModuleRegistryInitialized() || hostReact === undefined) {
    throw new Error(
      "[host-module-registry] React identity check ran before the shim was initialized — " +
        "initHostModuleRegistry must run before any dynamic renderer import",
    );
  }
  if (observedReact !== hostReact) {
    throw new Error(
      "[host-module-registry] a dynamic renderer observed a DIFFERENT React instance than the host " +
        "singleton — a second React copy was admitted (hooks/context would break). This must never happen: " +
        "React is an externalized host peer and the metafile gate rejects a bundled copy.",
    );
  }
  return hostReact;
}

/** @internal test-only reset. */
export function _resetHostModuleRegistryForTests(): void {
  holder[REGISTRY_KEY] = { initialized: false, modules: {} };
}
