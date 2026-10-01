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

import {
  CLIENT_BUNDLE_EXTERNAL_ALLOWLIST,
  DESIGN_PRIMITIVES_CONTRACT_MISMATCH,
  HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION,
  HOST_DESIGN_PRIMITIVES_EXPORTS,
  HOST_DESIGN_PRIMITIVES_MODULE,
  checkDesignPrimitivesContract,
} from "@cinatra-ai/sdk-extensions/artifact-client-bundle";

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
  /**
   * The shared design-PRIMITIVES module (`@cinatra-ai/design-primitives`) —
   * the host's ONE instance of the components under `src/components/ui/`
   * (cinatra#3471 slice 2, epic #2926: "the host shares its primitives with
   * extension bundles at run time like React does"). Registered on the SAME
   * road React takes, so a bundle that leaves the id external mounts the host's
   * components and never a second copy.
   */
  designPrimitives: unknown;
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
    [HOST_DESIGN_PRIMITIVES_MODULE]: mods.designPrimitives,
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

/**
 * The design-primitives twin of {@link assertSingleReactIdentity}: the shared
 * primitives module a renderer observed (through the façade) MUST be the EXACT
 * host instance. A SECOND copy — a package that bundled `src/components/ui`
 * byte copies instead of leaving `@cinatra-ai/design-primitives` external — is
 * exactly what decision 407 removes, and it would otherwise surface as
 * mismatched theming and duplicated Radix portals/contexts rather than as a
 * loud failure. Returns the shared module on success.
 */
export function assertSingleDesignPrimitivesIdentity(observedPrimitives: unknown): unknown {
  const hostPrimitives = getHostModule(HOST_DESIGN_PRIMITIVES_MODULE);
  if (!isHostModuleRegistryInitialized() || hostPrimitives === undefined) {
    throw new Error(
      "[host-module-registry] design-primitives identity check ran before the shim was initialized — " +
        "initHostModuleRegistry must run before any dynamic renderer import",
    );
  }
  if (observedPrimitives === hostPrimitives) return hostPrimitives;
  // An ESM NAMESPACE object is not the registered object: the façade the host
  // serves for the externalized specifier re-exports the registered module, so a
  // renderer's `import * as p from "@cinatra-ai/design-primitives"` observes a
  // fresh namespace wrapper whose MEMBERS are the host's own components. That is
  // ONE copy, not two — reference identity is judged per export, not on the
  // wrapper. A vendored second copy fails this because its components are
  // different function objects.
  if (servesSamePrimitiveIdentities(observedPrimitives, hostPrimitives)) return hostPrimitives;
  throw new Error(
    `[host-module-registry] a dynamic renderer observed a DIFFERENT "${HOST_DESIGN_PRIMITIVES_MODULE}" ` +
      "instance than the host singleton — a second copy of the design primitives was mounted. " +
      "The module is an externalized host peer and the externals gate rejects a bundled copy.",
  );
}

/** Whether the candidate carries the host's OWN component identity for every
 * export of the frozen contract list (the namespace-wrapper case above). */
function servesSamePrimitiveIdentities(candidate: unknown, host: unknown): boolean {
  if (candidate === null || typeof candidate !== "object") return false;
  if (host === null || typeof host !== "object") return false;
  const c = candidate as Record<string, unknown>;
  const h = host as Record<string, unknown>;
  return HOST_DESIGN_PRIMITIVES_EXPORTS.every(
    (name) => h[name] !== undefined && c[name] === h[name],
  );
}

/**
 * The LOAD-TIME contract check (cinatra#3471 slice 2, item 5): a bundle built
 * against a `@cinatra-ai/design-primitives` contract MAJOR this host does not
 * serve FAILS CLOSED here, before the renderer is mounted, with a NAMED error
 * (`Error.name === DESIGN_PRIMITIVES_CONTRACT_MISMATCH`) instead of a cryptic
 * missing-export crash inside the renderer. Modelled on the pre-import
 * fail-closed ABI/React-peer checks in `runtime-renderer-descriptor.ts`.
 */
export function assertDesignPrimitivesContractServed(builtAgainst: string): void {
  const refusal = checkDesignPrimitivesContract({
    builtAgainst,
    hostServes: HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION,
  });
  if (refusal === null) return;
  const error = new Error(`[host-module-registry] ${refusal}`);
  error.name = DESIGN_PRIMITIVES_CONTRACT_MISMATCH;
  throw error;
}

/**
 * The LOAD-BOUNDARY conformance for the host-shared design primitives — what the
 * client loader seam runs on a freshly imported renderer module, the way it runs
 * the single-React-identity assert. A bundle declares what it was built against
 * and what it observed through the façade in its PREAMBLE (the optional
 * `__cinatraDesignPrimitivesContract` / `__cinatraDesignPrimitives` fields, the
 * road `__cinatraReact` already takes) — no publish-record or signature change.
 * A bundle that declares NEITHER is a bundle that does not use the shared module
 * and passes untouched; a declared value is checked fail-closed.
 */
export function assertDesignPrimitivesBundleConformance(loadedModule: unknown): void {
  if (loadedModule === null || typeof loadedModule !== "object") return;
  const mod = loadedModule as {
    __cinatraDesignPrimitivesContract?: unknown;
    __cinatraDesignPrimitives?: unknown;
  };
  if (mod.__cinatraDesignPrimitivesContract !== undefined) {
    assertDesignPrimitivesContractServed(mod.__cinatraDesignPrimitivesContract as string);
  }
  if (mod.__cinatraDesignPrimitives !== undefined) {
    assertSingleDesignPrimitivesIdentity(mod.__cinatraDesignPrimitives);
  }
}

/** @internal test-only reset. */
export function _resetHostModuleRegistryForTests(): void {
  holder[REGISTRY_KEY] = { initialized: false, modules: {} };
}
