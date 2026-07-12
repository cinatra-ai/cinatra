import "server-only";

// VERSION-KEYED SERVING REGISTRY — positive non-agent edge-bound serving
// (cinatra#1392 Gap 1, follow-up slice of #1040).
//
// PROBLEM. A package may be installed at several versions side by side. The
// DEFAULT version alone owns the package's unversioned GLOBAL names via the
// process-global registries (`extension-mcp-registry`, `extension-capabilities-
// registry`, `extension-ui-registry`, the object-type registry). A NON-DEFAULT
// sibling activates against `createNonDefaultVersionHostContext` (S4): its
// register-channel ports were INERT probe sinks whose recorder was DISCARDED, so
// a non-default version's mcp tools / capability providers / object types / ui
// surfaces were retained NOWHERE. A resolved dependent that is edge-bound to a
// non-default version therefore could not be SERVED that version's handlers.
//
// THIS MODULE is the missing substrate: a version-keyed retention of a
// non-default version's register-channel registrations, keyed by
// `(packageName, version)` — the SAME identity the runtime loader keys records
// on (`runtime-loader.ts` `identityKey`) and the exact `(name, version)` an
// edge-bound resolver produces for a dependent (`extension-edge-bound-agent.ts`
// returns `{ resolvedInstallId, version }`; the non-agent kinds resolve the same
// (name, version) pair). It NEVER writes the global registries, so the default's
// global names are never leaked or clobbered.
//
// FAIL-CLOSED CONTRACT (codex-converged). A version is servable ONLY after its
// register(ctx) fully succeeds and the driver COMMITS it. Every serve lookup
// REFUSES — it returns a discriminated `refuse` (never a value, never a silent
// fall-through to the default/global registration) — when the version is
// unpinned (no version), unknown (never retained / torn down), not-yet /
// no-longer servable (pre-commit, or a partial/failed register that was
// aborted), or servable-but-has-no-such-handler (a POINT lookup — mcp tool,
// object type, or capability provider — the version did not register). Only the
// BULK ui-surface lookups return `serve: []` for a version that registered none
// (an empty set is that version's genuine, complete surface list). The consuming
// per-kind serve surfaces MUST treat `refuse` as a hard stop, exactly as the
// agent path does with an unreachable non-default pin. The MCP-tool kind is
// CONSUMED live via `extension-edge-bound-serving.ts` (the cinatra#1392 S7
// wiring slice — both `mcp-server.ts` chokepoints); the capability / object /
// ui kinds' serve surfaces are still adjacent-lane follow-ups.
//
// LIFECYCLE + ATTEMPT OWNERSHIP. `beginVersionKeyedRegistration` (from the host
// makeContext, per non-default record) creates a FRESH, NON-servable entry and
// returns a SINK bound to THAT attempt's entry. The sink's register methods
// write into its own entry; `sink.commit()` / `sink.abort()` are guarded by
// ENTRY OWNERSHIP (`registry.get(key) === thisEntry`) so a stale settle from a
// SUPERSEDED activation pass (a concurrent re-activation of the same identity
// re-`begin`s and replaces the map entry) can neither mark the newer attempt's
// partial entry servable nor delete it. The driver's per-record settle hook
// (host wiring) holds the sink and calls commit on a successful register or
// abort otherwise. `clearVersionKeyedServingForPackage` is wired into the single
// capability teardown chokepoint (`teardownExtensionCapabilities`) so every
// retire path (archive / uninstall / force-delete / purge) and the defensive
// pre-reactivate teardown drop the package's retained versions in lockstep with
// its global registrations (a whole-package clear ignores attempt ownership by
// design — a teardown drops every version unconditionally).

import type { HostMcpToolRegistration } from "@cinatra-ai/sdk-extensions";

/** A version-keyed MCP tool, carrying the authoritative provider identity. */
export type RetainedVersionKeyedMcpTool = HostMcpToolRegistration & { packageName: string };

/** A version-keyed capability provider (identity already host-bound by the port). */
export type RetainedVersionKeyedCapabilityProvider = { packageName: string; impl: unknown };

/** A version-keyed object-type descriptor (opaque; validated host-side). */
export type RetainedVersionKeyedObjectType = { typeId: string; ioSpec?: unknown; [k: string]: unknown };

/** A version-keyed named ui action. */
export type RetainedVersionKeyedUiAction = { id: string; handler: (input: unknown) => Promise<unknown> };

type VersionKeyedEntry = {
  /** The identity the entry was begun under (for whole-registry listings). */
  packageName: string;
  version: string;
  /** Flipped true ONLY by an explicit commit after a fully-successful register. */
  servable: boolean;
  mcpTools: Map<string, RetainedVersionKeyedMcpTool>;
  // At most ONE provider per capability per package (the global registry is keyed
  // capability -> packageName -> provider), so a single version registers 0-or-1
  // provider per capability — a POINT lookup, not a growable list.
  capabilityProviders: Map<string, RetainedVersionKeyedCapabilityProvider>;
  objectTypes: Map<string, RetainedVersionKeyedObjectType>;
  uiSetupSurfaces: unknown[];
  uiSettingsSurfaces: unknown[];
  uiActions: RetainedVersionKeyedUiAction[];
};

// CROSS-COMPILATION SINGLETON: Next.js builds separate bundler compilations
// (instrumentation / route / RSC), each with its own module cache. The loader
// retains at boot/activation (instrumentation compilation); a serve surface
// resolves at request time (route / RSC compilation) — so the registry MUST be a
// true per-process singleton, anchored on a namespaced+versioned `Symbol.for(...)`
// key (the same pattern as the extension MCP / object-type / capability registries).
const VERSION_KEYED_SERVING_REGISTRY_KEY = Symbol.for(
  "@cinatra-ai/host:extension-version-keyed-serving/v1",
);
type RegistryHolder = { [k: symbol]: Map<string, VersionKeyedEntry> | undefined };
const _holder = globalThis as unknown as RegistryHolder;
const registry: Map<string, VersionKeyedEntry> =
  _holder[VERSION_KEYED_SERVING_REGISTRY_KEY] ??
  (_holder[VERSION_KEYED_SERVING_REGISTRY_KEY] = new Map<string, VersionKeyedEntry>());

// A NUL-free space join keeps the composite key unambiguous — a package name
// cannot contain a space, so no (name, version) pair can collide with another and
// no package name is a prefix of another up to the separator.
const KEY_SEP = " ";

/**
 * The composite retention key, or `null` when `version` is missing/blank — an
 * UNPINNED serve. A non-default side-by-side version is ALWAYS pinned (the
 * runtime loader fences un-versioned records out of side-by-side activation), so
 * an unpinned lookup is a caller/identity bug and MUST fail closed, never match a
 * default.
 */
function versionKey(packageName: string, version: string | null | undefined): string | null {
  if (typeof version !== "string" || version.length === 0) return null;
  if (typeof packageName !== "string" || packageName.length === 0) return null;
  return `${packageName}${KEY_SEP}${version}`;
}

function newEntry(packageName: string, version: string): VersionKeyedEntry {
  return {
    packageName,
    version,
    servable: false,
    mcpTools: new Map(),
    capabilityProviders: new Map(),
    objectTypes: new Map(),
    uiSetupSurfaces: [],
    uiSettingsSurfaces: [],
    uiActions: [],
  };
}

/**
 * The write + settle handle for ONE non-default registration attempt. The host
 * ports write via the `retain*` methods (they apply the same identity/authz
 * guards the live/probe ports apply BEFORE calling these — this sink only
 * validates the structural minimum, mirroring each global registry's own throw).
 * `commit`/`abort` are ATTEMPT-OWNERSHIP guarded: they act only while this
 * attempt still owns the registry slot, so a stale settle from a superseded
 * concurrent re-activation is a safe no-op.
 */
export type VersionKeyedRegistrationSink = {
  retainMcpTool(tool: RetainedVersionKeyedMcpTool): void;
  retainCapabilityProvider(capability: string, provider: RetainedVersionKeyedCapabilityProvider): void;
  retainObjectType(descriptor: RetainedVersionKeyedObjectType): void;
  retainUiSetupSurface(surface: unknown): void;
  retainUiSettingsSurface(surface: unknown): void;
  retainUiAction(action: RetainedVersionKeyedUiAction): void;
  /** Make this attempt's retained registrations servable — iff it still owns the slot. */
  commit(): void;
  /** Discard this attempt's entry — iff it still owns the slot (never a newer attempt's). */
  abort(): void;
  /**
   * Whether this attempt has SETTLED (commit or abort was called). Diagnostic
   * companion of `isCommitted` below.
   */
  isSettled(): boolean;
  /**
   * Whether this attempt COMMITTED (register fully succeeded). The host ctx
   * factory gates the non-default `callPrimitive` on it (cinatra#1392 S8): a
   * `register(ctx)` must stay dispatch-free (side-effect-free contract), and a
   * FAILED/aborted registration's leaked callbacks must never dispatch either —
   * only a RETAINED handler served edge-bound after a successful register may
   * invoke host primitives (codex S8 round-0 #5).
   */
  isCommitted(): boolean;
};

/**
 * Begin a NON-DEFAULT version's registration attempt. Creates a FRESH,
 * NON-servable entry keyed by `(packageName, version)` (replacing any prior entry
 * for that exact identity, so a re-activation replaces rather than stacks) and
 * returns the sink bound to THIS attempt. Throws on a missing version — a
 * non-default serve must be pinned (fail-closed on unpinned).
 */
export function beginVersionKeyedRegistration(
  packageName: string,
  version: string | null | undefined,
): VersionKeyedRegistrationSink {
  const key = versionKey(packageName, version);
  if (key === null) {
    throw new Error(
      `[extension-version-keyed-serving] cannot retain registrations for "${packageName}" without a ` +
        `pinned version — a non-default side-by-side version must carry a version identity (fail-closed).`,
    );
  }
  const entry = newEntry(packageName, version as string);
  registry.set(key, entry);
  // ATTEMPT OWNERSHIP: this attempt owns the slot only while the map still points
  // at ITS entry object. A newer `begin` for the same identity replaces it, after
  // which this attempt's commit/abort are no-ops (they must not touch the newer
  // attempt's entry). retain* always write to THIS attempt's `entry` (even if
  // orphaned) so a superseded attempt never mutates the live one.
  const owns = () => registry.get(key) === entry;
  let settled = false;
  let committed = false;

  return {
    retainMcpTool: (tool) => {
      const name = tool?.name;
      if (!name || typeof name !== "string") {
        throw new Error(
          `[extension-version-keyed-serving] ${packageName}@${version} registered an MCP tool with no name`,
        );
      }
      if (typeof tool.handler !== "function") {
        throw new Error(
          `[extension-version-keyed-serving] ${packageName}@${version} MCP tool "${name}" has no handler`,
        );
      }
      entry.mcpTools.set(name, tool);
    },
    retainCapabilityProvider: (capability, provider) => {
      if (!capability || typeof capability !== "string") {
        throw new Error(
          `[extension-version-keyed-serving] ${packageName}@${version} registered a capability provider ` +
            `with no capability id`,
        );
      }
      entry.capabilityProviders.set(capability, provider);
    },
    retainObjectType: (descriptor) => {
      if (descriptor == null || typeof descriptor !== "object") {
        throw new Error(
          `[extension-version-keyed-serving] ${packageName}@${version}: registerType received a ` +
            `non-object descriptor`,
        );
      }
      const typeId = (descriptor as { typeId?: unknown }).typeId;
      if (!typeId || typeof typeId !== "string") {
        throw new Error(
          `[extension-version-keyed-serving] ${packageName}@${version}: registerType descriptor has no typeId`,
        );
      }
      entry.objectTypes.set(typeId, descriptor);
    },
    retainUiSetupSurface: (surface) => {
      entry.uiSetupSurfaces.push(surface);
    },
    retainUiSettingsSurface: (surface) => {
      entry.uiSettingsSurfaces.push(surface);
    },
    retainUiAction: (action) => {
      entry.uiActions.push(action);
    },
    commit: () => {
      settled = true;
      // COMMITTED only while this attempt still owns the slot (codex S8
      // round-1 #4): a SUPERSEDED attempt's entry never became servable, so
      // its leaked ctx callbacks must not pass the isCommitted dispatch gate.
      if (owns()) {
        entry.servable = true;
        committed = true;
      }
    },
    abort: () => {
      settled = true;
      if (owns()) registry.delete(key);
    },
    isSettled: () => settled,
    isCommitted: () => committed,
  };
}

/**
 * Drop EVERY retained version of a package. Wired into the single capability
 * teardown chokepoint so an archived / uninstalled / force-deleted / purged
 * package — and the defensive pre-reactivate teardown — clears its version-keyed
 * serving in lockstep with its global registrations. Unconditional (attempt
 * ownership does not apply to a whole-package teardown). Returns the retained
 * versions removed, mirroring the other per-kind teardowns.
 */
export function clearVersionKeyedServingForPackage(packageName: string): string[] {
  if (!packageName) return [];
  const prefix = `${packageName}${KEY_SEP}`;
  const removed: string[] = [];
  for (const key of registry.keys()) {
    if (key.startsWith(prefix)) {
      registry.delete(key);
      removed.push(key.slice(prefix.length));
    }
  }
  return removed;
}

/** Why a version-keyed serve lookup refused (carried as evidence to the caller). */
export type VersionKeyedRefuseCode =
  /** No version pin — a non-default serve is never unpinned. */
  | "UNPINNED"
  /** No retained entry for this (name, version) — never activated, or torn down. */
  | "UNKNOWN_VERSION"
  /** The version is retained but not yet / no longer servable (pre-commit / aborted). */
  | "NOT_SERVABLE"
  /** The version is servable but registered no handler under the requested name/id/capability. */
  | "NO_SUCH_HANDLER";

/**
 * A version-keyed serve decision. `serve` carries the retained value (for the
 * BULK ui-surface kinds, possibly an empty list — that is still "serve THIS
 * version's complete surface set", not a refusal); `refuse` carries the
 * fail-closed reason and NEVER a value, so a consumer physically cannot fall
 * through to a default/global registration.
 */
export type VersionKeyedServeResult<T> =
  | { kind: "serve"; value: T }
  | { kind: "refuse"; code: VersionKeyedRefuseCode; message: string };

function refuse<T>(code: VersionKeyedRefuseCode, message: string): VersionKeyedServeResult<T> {
  return { kind: "refuse", code, message };
}

/**
 * Resolve the servable entry for `(packageName, version)`, or a fail-closed
 * refusal. Shared by every per-kind lookup so the unpinned / unknown / not-servable
 * axes are enforced identically.
 */
function resolveServableEntry(
  packageName: string,
  version: string | null | undefined,
): VersionKeyedServeResult<VersionKeyedEntry> {
  const key = versionKey(packageName, version);
  if (key === null) {
    return refuse(
      "UNPINNED",
      `version-keyed serving refused — no version pin for "${packageName}" (a non-default serve must be pinned)`,
    );
  }
  const entry = registry.get(key);
  if (!entry) {
    return refuse(
      "UNKNOWN_VERSION",
      `version-keyed serving refused — no retained registrations for ${packageName}@${version} ` +
        `(never activated as a non-default sibling, or torn down)`,
    );
  }
  if (!entry.servable) {
    return refuse(
      "NOT_SERVABLE",
      `version-keyed serving refused — ${packageName}@${version} is retained but not servable ` +
        `(its register did not fully succeed)`,
    );
  }
  return { kind: "serve", value: entry };
}

/** Serve a non-default version's MCP tool by name, fail-closed (refuses an unregistered name). */
export function resolveVersionKeyedMcpTool(
  packageName: string,
  version: string | null | undefined,
  toolName: string,
): VersionKeyedServeResult<RetainedVersionKeyedMcpTool> {
  const e = resolveServableEntry(packageName, version);
  if (e.kind === "refuse") return e;
  const tool = e.value.mcpTools.get(toolName);
  if (!tool) {
    return refuse(
      "NO_SUCH_HANDLER",
      `version-keyed serving refused — ${packageName}@${version} registered no MCP tool "${toolName}"`,
    );
  }
  return { kind: "serve", value: tool };
}

/**
 * Serve a non-default version's COMPLETE retained MCP tool set (cinatra#1392 S8
 * — the tool DISCOVERY union). A BULK lookup: fail-closed on the servability
 * axes (UNPINNED / UNKNOWN_VERSION / NOT_SERVABLE), but a servable version that
 * registered NO tools serves `[]` — that empty set IS that version's genuine,
 * complete tool surface (advertising nothing for the package is the correct
 * discovery outcome for a dependent pinned to it), not a refusal. Point
 * dispatch stays on `resolveVersionKeyedMcpTool` (which DOES refuse an
 * unregistered name).
 */
export function resolveVersionKeyedMcpTools(
  packageName: string,
  version: string | null | undefined,
): VersionKeyedServeResult<readonly RetainedVersionKeyedMcpTool[]> {
  const e = resolveServableEntry(packageName, version);
  if (e.kind === "refuse") return e;
  return { kind: "serve", value: [...e.value.mcpTools.values()] };
}

/**
 * Every SERVABLE retained MCP tool across all retained versions (cinatra#1392
 * S8). Consumed by the in-process self-primitive map builder to UNION the
 * version-keyed tool names into its `name → handler` map (the map is memoised
 * per activation generation, so it cannot be per-caller; the strict
 * versioned-only dispatch wrapper enforces the caller's edge binding at call
 * time). Registration order within a version is preserved; versions enumerate
 * in retention order.
 */
export function listServableVersionKeyedMcpTools(): ReadonlyArray<{
  packageName: string;
  version: string;
  tool: RetainedVersionKeyedMcpTool;
}> {
  const out: Array<{ packageName: string; version: string; tool: RetainedVersionKeyedMcpTool }> = [];
  for (const entry of registry.values()) {
    if (!entry.servable) continue;
    for (const tool of entry.mcpTools.values()) {
      out.push({ packageName: entry.packageName, version: entry.version, tool });
    }
  }
  return out;
}

/**
 * Serve a non-default version's provider for a capability, fail-closed. A package
 * registers at most one provider per capability, so this is a POINT lookup: a
 * servable version that did NOT register a provider for the capability REFUSES
 * (NO_SUCH_HANDLER) rather than serving an empty set a consumer might treat as a
 * cue to fall back to the default. Served as a one-element list to match the
 * `HostCapabilitiesPort.resolveProviders(capability): Provider[]` shape.
 */
export function resolveVersionKeyedCapabilityProviders(
  packageName: string,
  version: string | null | undefined,
  capability: string,
): VersionKeyedServeResult<RetainedVersionKeyedCapabilityProvider[]> {
  const e = resolveServableEntry(packageName, version);
  if (e.kind === "refuse") return e;
  const provider = e.value.capabilityProviders.get(capability);
  if (!provider) {
    return refuse(
      "NO_SUCH_HANDLER",
      `version-keyed serving refused — ${packageName}@${version} registered no provider for ` +
        `capability "${capability}"`,
    );
  }
  return { kind: "serve", value: [provider] };
}

/** Serve a non-default version's object type by id, fail-closed (refuses an unregistered id). */
export function resolveVersionKeyedObjectType(
  packageName: string,
  version: string | null | undefined,
  typeId: string,
): VersionKeyedServeResult<RetainedVersionKeyedObjectType> {
  const e = resolveServableEntry(packageName, version);
  if (e.kind === "refuse") return e;
  const descriptor = e.value.objectTypes.get(typeId);
  if (!descriptor) {
    return refuse(
      "NO_SUCH_HANDLER",
      `version-keyed serving refused — ${packageName}@${version} registered no object type "${typeId}"`,
    );
  }
  return { kind: "serve", value: descriptor };
}

/**
 * Serve a non-default version's ui setup surfaces, fail-closed on the servability
 * axes. A BULK lookup: a servable version with no setup surface serves `[]` (its
 * complete, genuine surface set), NOT a refusal.
 */
export function resolveVersionKeyedUiSetupSurfaces(
  packageName: string,
  version: string | null | undefined,
): VersionKeyedServeResult<readonly unknown[]> {
  const e = resolveServableEntry(packageName, version);
  if (e.kind === "refuse") return e;
  return { kind: "serve", value: e.value.uiSetupSurfaces };
}

/** Serve a non-default version's ui settings surfaces, fail-closed (bulk; empty is a valid serve). */
export function resolveVersionKeyedUiSettingsSurfaces(
  packageName: string,
  version: string | null | undefined,
): VersionKeyedServeResult<readonly unknown[]> {
  const e = resolveServableEntry(packageName, version);
  if (e.kind === "refuse") return e;
  return { kind: "serve", value: e.value.uiSettingsSurfaces };
}

/** Serve a non-default version's ui actions, fail-closed (bulk; empty is a valid serve). */
export function resolveVersionKeyedUiActions(
  packageName: string,
  version: string | null | undefined,
): VersionKeyedServeResult<readonly RetainedVersionKeyedUiAction[]> {
  const e = resolveServableEntry(packageName, version);
  if (e.kind === "refuse") return e;
  return { kind: "serve", value: e.value.uiActions };
}

/**
 * Whether a `(packageName, version)` is currently retained AND servable. A thin
 * predicate for a serve surface that only needs the gate (not the payload) —
 * still fail-closed (unpinned / unknown / not-servable all return false).
 */
export function isVersionKeyedServable(
  packageName: string,
  version: string | null | undefined,
): boolean {
  return resolveServableEntry(packageName, version).kind === "serve";
}

/** @internal Test-only reset — clears every retained version. */
export function __resetVersionKeyedServingForTests(): void {
  registry.clear();
}

// TEARDOWN WIRING WITHOUT A STATIC ROUTE-GRAPH EDGE (cinatra#732 route-graph
// ratchet is shrink-only). The single capability teardown chokepoint
// (`extension-capability-teardown`) is reachable from the locked dev-perf routes;
// a STATIC import of this module from there would add this module to those routes'
// reachable graphs (+1 each) and trip the ratchet. Instead this module — reached
// ONLY via the loader's DYNAMIC import (so it is NOT a static route-graph node) —
// publishes its package-scoped clear on the SAME globalThis singleton surface the
// registry Map uses (cross-compilation safe via `Symbol.for`). The teardown
// chokepoint reads it off globalThis and calls it synchronously, with no import of
// this module. Absent (this module never loaded ⇒ no retained entries) → the
// teardown safely no-ops.
const VERSION_KEYED_SERVING_TEARDOWN_KEY = Symbol.for(
  "@cinatra-ai/host:extension-version-keyed-serving-teardown/v1",
);
type TeardownHolder = { [k: symbol]: ((packageName: string) => string[]) | undefined };
(globalThis as unknown as TeardownHolder)[VERSION_KEYED_SERVING_TEARDOWN_KEY] =
  clearVersionKeyedServingForPackage;

// SYNC CAPABILITY LOOKUP WITHOUT A STATIC ROUTE-GRAPH EDGE (cinatra#1392 S8 —
// same shrink-only-ratchet rationale as the teardown seam above). The host ctx
// factory's `resolveProviders` is SYNC by ABI, and its edge-bound substitution
// (`extension-pre-resolved-edges.ts`) must consult THIS registry's capability
// retention at request time. A static import from that (locked-route-reachable)
// module would add this module to more route graphs; instead the point lookup is
// published on the SAME globalThis singleton surface (cross-compilation safe via
// `Symbol.for`) and read off it by the substitution. Absent (this module never
// loaded ⇒ nothing was ever retained ⇒ no pin can exist) the substitution FAILS
// CLOSED on any pin rather than serving the default.
const VERSION_KEYED_CAPABILITY_LOOKUP_KEY = Symbol.for(
  "@cinatra-ai/host:extension-version-keyed-capability-lookup/v1",
);
type CapabilityLookupHolder = {
  [k: symbol]: typeof resolveVersionKeyedCapabilityProviders | undefined;
};
(globalThis as unknown as CapabilityLookupHolder)[VERSION_KEYED_CAPABILITY_LOOKUP_KEY] =
  resolveVersionKeyedCapabilityProviders;
