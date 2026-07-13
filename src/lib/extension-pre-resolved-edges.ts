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
// runtime loader PRE-RESOLVES each live install's dependency edges into a map
// `targetPackageName → pin` and publishes the maps here; at request time
// `resolveProviders` consults its own record's map synchronously and
// substitutes a pinned target package's version-keyed retained provider for
// the default's global registration.
//
// MAP KEYS (codex S8 round-0 #1). The canonical install-row identity includes
// the organization/owner axes, so a bare `(packageName, version|default)` key
// can collide across rows. Each row's map is therefore published under its
// EXACT row id (`id:<installId>`; the loader threads the id from the trusted
// anchor into the ctx identity), and ADDITIONALLY under the composite
// `(packageName, version|default)` key ONLY while that composite is
// UNAMBIGUOUS — a collision DROPS the composite entries entirely (a legacy
// identity-less consult then finds no pins and serves the global registration;
// it can never be served ANOTHER row's pins). Identity-less ctxs exist only
// for the dev static bundle and lifecycle-special ctxs, whose packages the
// platform-global loader refuses to activate ambiguously in the first place.
//
// FRESHNESS MODEL (deliberate, documented): the maps are published from the
// live canonical rows BEFORE each loader activation pass (so a dependent's
// `register(ctx)` already resolves under its pins — codex S8 round-0 #2) and
// REFRESHED after it; boot, targeted hot-activation (`onlyPackage`) and
// default re-election all end in `loadRuntimePackageExtensions`. Between
// passes the maps can lag a planner edge re-resolution; the ASYNC surfaces
// stay DB-fresh, and the sanctioned GC never reaps a version with live
// resolved dependents, so a lagging map can only pin a STILL-RETAINED version
// (or fail closed at the version-keyed lookup — never silently serve the
// default).
//
// FAIL-CLOSED MATRIX for the sync substitution (mirrors the S7 dispatch
// matrix, adapted to a capability SET query; codex S8 round-0 #2 made the
// unsafe edge states EXPLICIT refuse pins instead of silent omissions):
//   - edge resolved to a LIVE NON-DEFAULT versioned row               → a
//     `versioned` pin (substitute / union at consult time);
//   - edge resolved to the DEFAULT row                                → NO pin
//     (the global registration IS that version — correct serve);
//   - edge resolved to a MISSING / NOT-LIVE / versionless-non-default
//     row                                                             → a
//     `refuse` pin: ANY capability consult by that dependent THROWS with
//     evidence (never a silent downgrade to the default);
//   - pinned target's version-keyed lookup SERVES                     →
//     substitute the retained provider(s) for the target's global entry (or
//     ADD them when the default registered none — the union);
//   - lookup refuses NO_SUCH_HANDLER                                  → the
//     pinned version genuinely registered no provider for this capability: the
//     target contributes NOTHING (the default's provider is DROPPED — serving
//     it would violate the pin);
//   - lookup refuses UNKNOWN_VERSION / NOT_SERVABLE / UNPINNED, or the lookup
//     surface is ABSENT                                               → THROW
//     with evidence (torn retention — never fall through to the default).
// A record with no published map, or a map with no pin for the target, is the
// byte-identical pre-S8 behavior (the global registry serves).

import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import type { CapabilityProvider } from "@/lib/extension-capabilities-registry";

/** A dependent's pre-resolved pin for one target package (see the matrix above). */
export type PreResolvedPin =
  | { kind: "versioned"; version: string; resolvedInstallId: string }
  | {
      kind: "refuse";
      code:
        | "EDGE_BOUND_RESOLVED_MISSING"
        | "EDGE_BOUND_RESOLVED_NOT_LIVE"
        | "EDGE_BOUND_VERSION_UNPINNED";
      message: string;
    };

/** The identity axes of a ctx-owning record (host-injected at activation). */
export type PreResolvedEdgeIdentity = {
  /** The exact canonical install-row id, when the loader could thread it. */
  installId?: string | null;
  /** The record's version; `null` for a default/legacy identity. */
  version: string | null;
  /** Whether the record is the DEFAULT version (owns the map's default slot). */
  isDefault: boolean;
};

const LIVE_STATUSES = new Set(["active", "locked"]);

// CROSS-COMPILATION SINGLETON (same rationale as the sibling registries): the
// loader publishes at boot/activation (instrumentation compilation); the host
// ctx resolves at request time (route / RSC compilation).
const PRE_RESOLVED_EDGES_KEY = Symbol.for("@cinatra-ai/host:extension-pre-resolved-edges/v2");
type Holder = { [k: symbol]: Map<string, ReadonlyMap<string, PreResolvedPin>> | undefined };
const _holder = globalThis as unknown as Holder;
function store(): Map<string, ReadonlyMap<string, PreResolvedPin>> {
  return (
    _holder[PRE_RESOLVED_EDGES_KEY] ??
    (_holder[PRE_RESOLVED_EDGES_KEY] = new Map<string, ReadonlyMap<string, PreResolvedPin>>())
  );
}

// The EXACT row-id key (never ambiguous). The `id:` prefix cannot collide with
// a composite key (those always contain a space; row ids never do).
function rowIdKey(installId: string): string {
  return `id:${installId}`;
}

// The DEFAULT identity uses an empty version slot; package names cannot contain
// a space, so the composite key is unambiguous (same scheme as the loader's
// identityKey and the version-keyed serving key).
function compositeKey(packageName: string, identity: { version: string | null; isDefault: boolean }): string {
  return identity.isDefault === false && identity.version
    ? `${packageName} ${identity.version}`
    : `${packageName} `;
}

/**
 * Compute the pre-resolved edge maps from the LIVE canonical rows (pure — the
 * loader passes one batched read). For each LIVE row, every dependency edge
 * with a `resolvedInstallId` becomes a pin per the module-header matrix
 * (`versioned` / no-pin-for-default / explicit `refuse` for the unsafe
 * states). Each row's map is keyed by its EXACT row id; the composite
 * `(packageName, version|default)` alias is added only while unambiguous
 * (a collision drops the alias for every claimant — fail-closed against
 * serving another row's pins).
 */
export function computePreResolvedEdgeMaps(
  rows: readonly InstalledExtension[],
): Map<string, ReadonlyMap<string, PreResolvedPin>> {
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, ReadonlyMap<string, PreResolvedPin>>();
  // Composite key → EVERY live claimant row id (codex round-1 #1: a PINLESS
  // same-shape row is still a claimant — publishing the pinned sibling's alias
  // would hand the pinless row's identity-less consult ANOTHER row's edges).
  const compositeOwners = new Map<string, string[]>();
  for (const row of rows) {
    if (!LIVE_STATUSES.has(row.status)) continue;
    const composite = compositeKey(row.packageName, {
      version: row.version ?? null,
      isDefault: row.isDefault !== false,
    });
    const owners = compositeOwners.get(composite);
    if (owners) owners.push(row.id);
    else compositeOwners.set(composite, [row.id]);
    const pins = new Map<string, PreResolvedPin>();
    for (const edge of row.dependencyEdges ?? []) {
      if (edge.resolvedInstallId == null) continue;
      const resolved = rowById.get(edge.resolvedInstallId);
      if (!resolved) {
        pins.set(edge.packageName, {
          kind: "refuse",
          code: "EDGE_BOUND_RESOLVED_MISSING",
          message:
            `dependent install ${row.id} resolved its edge to ${edge.packageName} install ` +
            `${edge.resolvedInstallId}, but that row is gone`,
        });
        continue;
      }
      if (!LIVE_STATUSES.has(resolved.status)) {
        pins.set(edge.packageName, {
          kind: "refuse",
          code: "EDGE_BOUND_RESOLVED_NOT_LIVE",
          message:
            `dependent install ${row.id} resolved its edge to ${edge.packageName} install ` +
            `${resolved.id}, which is "${resolved.status}" (not live)`,
        });
        continue;
      }
      if (resolved.isDefault !== false) continue; // default pin = global serve, no substitution
      if (typeof resolved.version !== "string" || resolved.version.length === 0) {
        pins.set(edge.packageName, {
          kind: "refuse",
          code: "EDGE_BOUND_VERSION_UNPINNED",
          message:
            `dependent install ${row.id} resolved its edge to a NON-DEFAULT install of ` +
            `${edge.packageName} (install ${resolved.id}) that carries NO version pin`,
        });
        continue;
      }
      pins.set(edge.packageName, {
        kind: "versioned",
        version: resolved.version,
        resolvedInstallId: resolved.id,
      });
    }
    if (pins.size === 0) continue;
    out.set(rowIdKey(row.id), pins);
  }
  // Composite aliases: only where EXACTLY ONE live row claims the shape at all
  // (codex round-0 #1 / round-1 #1 — an ambiguity, pinned or pinless, must
  // never let one row's identity-less consult read another row's pins).
  for (const [composite, owners] of compositeOwners) {
    if (owners.length !== 1) continue;
    const pins = out.get(rowIdKey(owners[0]));
    if (pins) out.set(composite, pins);
  }
  return out;
}

/**
 * Publish a freshly-computed edge-map set, REPLACING the previous one
 * atomically (each loader pass recomputes from ALL live rows, so replace —
 * never merge — keeps removed installs from leaving stale pins).
 */
export function publishPreResolvedEdgeMaps(
  maps: ReadonlyMap<string, ReadonlyMap<string, PreResolvedPin>>,
): void {
  _holder[PRE_RESOLVED_EDGES_KEY] = new Map(maps);
}

/**
 * The pre-resolved pins of one ctx-owning record, or undefined when it has
 * none. Row-id key first (exact); the composite alias only for a legacy
 * identity the loader could not thread an install id into.
 */
export function getPreResolvedVersionedEdges(
  packageName: string,
  identity: PreResolvedEdgeIdentity,
): ReadonlyMap<string, PreResolvedPin> | undefined {
  const s = store();
  if (identity.installId) {
    // An id-carrying identity NEVER falls back to the composite alias: the id
    // is exact, so an absent id entry means THIS row has no pins (falling back
    // could serve a same-shape sibling's pins).
    return s.get(rowIdKey(identity.installId));
  }
  return s.get(compositeKey(packageName, identity));
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
 * Apply a record's pre-resolved pins to a SYNC capability resolution. `base`
 * is the global registry's provider list for `capability`; the result
 * substitutes/extends it per the fail-closed matrix in the module header.
 * With no published pins the `base` array is returned UNCHANGED
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
  const resolvePin = (target: string, pin: PreResolvedPin): CapabilityProvider[] | null => {
    if (pin.kind === "refuse") {
      // An UNSAFE edge state recorded at compute time (dangling / not-live /
      // versionless target) — never a silent downgrade to the default.
      throw new EdgeBoundCapabilityRefusal(
        pin.code,
        `edge-bound capability resolution refused for "${packageName}" → ${target} ` +
          `(capability "${capability}"): ${pin.message}; refusing rather than serving the default provider`,
      );
    }
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
