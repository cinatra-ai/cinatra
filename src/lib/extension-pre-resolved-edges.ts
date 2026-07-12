import "server-only";

// PRE-RESOLVED EDGE MAPS — the SYNC consume side of edge-bound serving
// (cinatra#1392 S8; follow-up of the S7 wiring, which covered the ASYNC
// MCP-tool dispatch chokepoints).
//
// PROBLEM. `HostCapabilitiesPort.resolveProviders(capability)` is SYNCHRONOUS
// by ABI (see `extension-capabilities-registry.ts` — active-manifest gating is
// realized by the LIFECYCLE, not a resolve-time DB read). The edge-bound
// resolution the async surfaces use (`resolveEdgeBoundExtensionVersion`) reads
// canonical rows per dispatch, so it cannot back a sync port. Instead the
// runtime loader PRE-RESOLVES, at activation time, each live install's
// dependency edges into a map `targetPackageName → { version,
// resolvedInstallId }` of its NON-DEFAULT (versioned) pins, and publishes the
// maps here — keyed by the SAME (packageName, version|default) identity the
// loader keys records on. At request time `resolveProviders` consults its own
// record's map synchronously and substitutes a pinned target package's
// version-keyed retained provider for the default's global registration.
//
// FRESHNESS MODEL (deliberate, documented): the maps refresh on EVERY loader
// pass — boot, targeted hot-activation (`onlyPackage`), and default
// re-election all end in `loadRuntimePackageExtensions`, and each pass
// recomputes the maps from ALL live canonical rows (one batched read), not
// just the records it activates. Between passes the maps can lag a planner
// edge re-resolution; the ASYNC surfaces stay DB-fresh, and the sanctioned GC
// never reaps a version with live resolved dependents, so a lagging map can
// only pin a STILL-RETAINED version (or fail closed at the version-keyed
// lookup — never silently serve the default).
//
// FAIL-CLOSED MATRIX for the sync substitution (mirrors the S7 dispatch
// matrix, adapted to a capability SET query):
//   - pinned target's version-keyed lookup SERVES        → substitute the
//     retained provider(s) for the target's global entry (or ADD them when the
//     default registered none — the union);
//   - lookup refuses NO_SUCH_HANDLER                     → the pinned version
//     genuinely registered no provider for this capability: the target
//     contributes NOTHING (the default's provider is DROPPED — serving it
//     would violate the pin);
//   - lookup refuses UNKNOWN_VERSION / NOT_SERVABLE /
//     UNPINNED, or the lookup surface is ABSENT           → THROW with evidence
//     (torn retention: the pin exists but the pinned version is not servable —
//     never fall through to the default).
// A package with no published map, or a map with no pin for the target, is the
// byte-identical pre-S8 behavior (the global registry serves).

import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import type { CapabilityProvider } from "@/lib/extension-capabilities-registry";

/** A dependent's pre-resolved NON-DEFAULT pin for one target package. */
export type PreResolvedVersionedPin = {
  version: string;
  resolvedInstallId: string;
};

/** The (version|default) identity axis of a ctx-owning record. */
export type PreResolvedEdgeIdentity = {
  /** The record's version; `null` for a default/legacy identity. */
  version: string | null;
  /** Whether the record is the DEFAULT version (owns the map's default slot). */
  isDefault: boolean;
};

const LIVE_STATUSES = new Set(["active", "locked"]);

// CROSS-COMPILATION SINGLETON (same rationale as the sibling registries): the
// loader publishes at boot/activation (instrumentation compilation); the host
// ctx resolves at request time (route / RSC compilation).
const PRE_RESOLVED_EDGES_KEY = Symbol.for("@cinatra-ai/host:extension-pre-resolved-edges/v1");
type Holder = { [k: symbol]: Map<string, ReadonlyMap<string, PreResolvedVersionedPin>> | undefined };
const _holder = globalThis as unknown as Holder;
function store(): Map<string, ReadonlyMap<string, PreResolvedVersionedPin>> {
  return (
    _holder[PRE_RESOLVED_EDGES_KEY] ??
    (_holder[PRE_RESOLVED_EDGES_KEY] = new Map<string, ReadonlyMap<string, PreResolvedVersionedPin>>())
  );
}

// The DEFAULT identity uses an empty version slot; package names cannot contain
// a space, so the composite key is unambiguous (same scheme as the loader's
// identityKey and the version-keyed serving key).
function edgeMapKey(packageName: string, identity: PreResolvedEdgeIdentity): string {
  return identity.isDefault === false && identity.version
    ? `${packageName} ${identity.version}`
    : `${packageName} `;
}

/**
 * Compute the pre-resolved edge maps from the LIVE canonical rows (pure — the
 * loader passes one batched read). For each LIVE row, every dependency edge
 * whose `resolvedInstallId` points at a LIVE, NON-DEFAULT, version-carrying row
 * becomes a versioned pin. Default-resolved / unresolved / dangling edges add
 * NO pin: the sync port then serves the global registration exactly as before,
 * and the ASYNC dispatch surfaces (which re-read the DB) own the fail-closed
 * handling of dangling/not-live rows.
 */
export function computePreResolvedEdgeMaps(
  rows: readonly InstalledExtension[],
): Map<string, ReadonlyMap<string, PreResolvedVersionedPin>> {
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, ReadonlyMap<string, PreResolvedVersionedPin>>();
  for (const row of rows) {
    if (!LIVE_STATUSES.has(row.status)) continue;
    const pins = new Map<string, PreResolvedVersionedPin>();
    for (const edge of row.dependencyEdges ?? []) {
      if (edge.resolvedInstallId == null) continue;
      const resolved = rowById.get(edge.resolvedInstallId);
      if (!resolved || !LIVE_STATUSES.has(resolved.status)) continue;
      if (resolved.isDefault !== false) continue; // default pin = global serve, no substitution
      if (typeof resolved.version !== "string" || resolved.version.length === 0) continue;
      pins.set(edge.packageName, {
        version: resolved.version,
        resolvedInstallId: resolved.id,
      });
    }
    if (pins.size === 0) continue;
    const identity: PreResolvedEdgeIdentity = {
      version: row.version ?? null,
      isDefault: row.isDefault !== false,
    };
    out.set(edgeMapKey(row.packageName, identity), pins);
  }
  return out;
}

/**
 * Publish a freshly-computed edge-map set, REPLACING the previous one
 * atomically (each loader pass recomputes from ALL live rows, so replace —
 * never merge — keeps removed installs from leaving stale pins).
 */
export function publishPreResolvedEdgeMaps(
  maps: ReadonlyMap<string, ReadonlyMap<string, PreResolvedVersionedPin>>,
): void {
  _holder[PRE_RESOLVED_EDGES_KEY] = new Map(maps);
}

/** The versioned pins of one ctx-owning record, or undefined when it has none. */
export function getPreResolvedVersionedEdges(
  packageName: string,
  identity: PreResolvedEdgeIdentity,
): ReadonlyMap<string, PreResolvedVersionedPin> | undefined {
  return store().get(edgeMapKey(packageName, identity));
}

/** @internal Test-only reset. */
export function __resetPreResolvedEdgesForTests(): void {
  store().clear();
}

// ---------------------------------------------------------------------------
// SYNC capability substitution (consumed by `extension-host-context.ts`).
// ---------------------------------------------------------------------------

// The version-keyed capability lookup is read off the globalThis surface the
// serving registry publishes (`extension-version-keyed-serving.ts`), NOT via a
// static import — this module is statically imported by the host ctx factory,
// which is reachable from locked dev-perf routes (route-graph ratchet), and
// must not pull the serving registry into every graph that reaches it. A pin
// can only exist when the loader activated a non-default sibling, and that
// same loader pass dynamically imports the serving registry — so an ABSENT
// lookup while a pin exists is torn state and fails closed.
const VERSION_KEYED_CAPABILITY_LOOKUP_KEY = Symbol.for(
  "@cinatra-ai/host:extension-version-keyed-capability-lookup/v1",
);
type VersionKeyedCapabilityLookup = (
  packageName: string,
  version: string | null | undefined,
  capability: string,
) =>
  | { kind: "serve"; value: { packageName: string; impl: unknown }[] }
  | { kind: "refuse"; code: string; message: string };
type LookupHolder = { [k: symbol]: VersionKeyedCapabilityLookup | undefined };

/** Thrown when a versioned pin cannot be served (torn retention) — never a silent default serve. */
export class EdgeBoundCapabilityRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EdgeBoundCapabilityRefusal";
    this.code = code;
  }
}

/**
 * Apply a record's pre-resolved versioned pins to a SYNC capability
 * resolution. `base` is the global registry's provider list for `capability`;
 * the result substitutes/extends it per the fail-closed matrix in the module
 * header. With no published pins the `base` array is returned UNCHANGED
 * (byte-identical pre-S8 behavior).
 */
export function substituteEdgeBoundCapabilityProviders(
  packageName: string,
  identity: PreResolvedEdgeIdentity,
  capability: string,
  base: CapabilityProvider[],
): CapabilityProvider[] {
  const pins = getPreResolvedVersionedEdges(packageName, identity);
  if (!pins || pins.size === 0) return base;

  const lookup = (globalThis as unknown as LookupHolder)[VERSION_KEYED_CAPABILITY_LOOKUP_KEY];
  const resolvePin = (target: string, pin: PreResolvedVersionedPin): CapabilityProvider[] | null => {
    if (!lookup) {
      throw new EdgeBoundCapabilityRefusal(
        "EDGE_BOUND_RETENTION_UNAVAILABLE",
        `edge-bound capability resolution refused — "${packageName}" pins ${target}@${pin.version} ` +
          `but the version-keyed serving registry is not loaded in this process; refusing rather ` +
          `than serving the default provider`,
      );
    }
    const served = lookup(target, pin.version, capability);
    if (served.kind === "serve") {
      return served.value as CapabilityProvider[];
    }
    if (served.code === "NO_SUCH_HANDLER") {
      // The pinned version genuinely registered no provider for this
      // capability — the target contributes nothing (never the default's).
      return null;
    }
    throw new EdgeBoundCapabilityRefusal(
      served.code,
      `edge-bound capability resolution refused for "${packageName}" → ${target}@${pin.version} ` +
        `(capability "${capability}"): ${served.message}`,
    );
  };

  const out: CapabilityProvider[] = [];
  const seenTargets = new Set<string>();
  for (const provider of base) {
    const pin = pins.get(provider.packageName);
    if (!pin) {
      out.push(provider);
      continue;
    }
    if (seenTargets.has(provider.packageName)) continue; // already substituted once
    seenTargets.add(provider.packageName);
    const substituted = resolvePin(provider.packageName, pin);
    if (substituted) out.push(...substituted);
  }
  // UNION: a pinned target whose DEFAULT registered no provider for this
  // capability may still provide it in the pinned version.
  for (const [target, pin] of pins) {
    if (seenTargets.has(target)) continue;
    const added = resolvePin(target, pin);
    if (added) out.push(...added);
  }
  return out;
}
