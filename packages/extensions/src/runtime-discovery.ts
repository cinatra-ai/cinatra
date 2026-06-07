// Runtime capability discovery — the single active-manifest dispatcher.
//
// This is the true-IoC spine and the guard against split-brain state
// (DB says uninstalled but a stale static/native path still exposes it). ALL
// runtime "what capabilities are active" discovery flows through here:
//
//   installed_extension (active|locked) → group by kind → kind reader facet
//
// `installed_extension` is the UNIFORM active gate; each kind's native store
// (agent_templates / skills catalog+SkillSource / object-artifact registry /
// workflow_template+dashboard / connector capability set) is the capability
// AUTHORITY, but is read ONLY for the manifests the gate reports active. A
// surface that reads a native store directly to discover "what's installed"
// bypasses the gate and is forbidden (enforced by an audit gate).
//
// The dispatcher is a pure function over injected dependencies (a manifest
// reader + a handler resolver) so it is fully unit-testable without a database
// and reusable from any boot/runtime/worker context.

import type {
  ActiveExtensionManifest,
  Actor,
  ExtensionDiscoveryScope,
  ExtensionTypeHandler,
} from "@cinatra-ai/extension-types";

/** The discoverable lifecycle statuses — the only ones the dispatcher passes to readers. */
export const DISCOVERABLE_STATUSES = ["active", "locked"] as const;
export type DiscoverableStatus = (typeof DISCOVERABLE_STATUSES)[number];

export function isDiscoverableStatus(status: string): status is DiscoverableStatus {
  return (DISCOVERABLE_STATUSES as readonly string[]).includes(status);
}

export interface RuntimeDiscoveryDeps {
  /**
   * Read the lifecycle-live status-candidate manifests (one per kind+packageName
   * with an effective `active`|`locked` status). This is a COARSE lifecycle gate
   * only — NOT a visibility authority. It takes no actor/scope: per-kind reader
   * facets apply the actor's visibility. When `kind` is provided, scope to it.
   */
  readActiveManifests(input: { kind?: string }): Promise<ActiveExtensionManifest[]>;
  /**
   * Resolve the registered handler for a kind, or null when no handler is
   * registered (an unknown kind in a manifest is logged + skipped, never fatal).
   */
  resolveHandler(kind: string): ExtensionTypeHandler | null;
}

export type DiscoveredCapabilities = {
  /** Native descriptors keyed by kind, in manifest order. */
  byKind: Record<string, unknown[]>;
  /** Flat list across all kinds. */
  all: unknown[];
  /** Kinds present in the active set whose handler has not adopted the reader facet. */
  unmigratedKinds: string[];
};

/**
 * Discover active capabilities across (optionally one) kind.
 *
 * Defensive contract:
 * - Filters the manifest set to discoverable statuses even if the reader leaks
 *   a non-discoverable row (belt-and-suspenders against the split-brain risk).
 * - A kind whose handler lacks `listActive` contributes nothing and is recorded
 *   in `unmigratedKinds` (so callers/tests can assert the cutover frontier).
 * - A handler that throws is isolated: that kind yields `[]` and the failure is
 *   surfaced via `onError`, never crashing the whole discovery.
 */
export async function discoverActiveCapabilities(
  input: { kind?: string; actor: Actor; scope: ExtensionDiscoveryScope },
  deps: RuntimeDiscoveryDeps,
  options?: { onError?: (kind: string, error: unknown) => void },
): Promise<DiscoveredCapabilities> {
  const manifests = (await deps.readActiveManifests({ kind: input.kind })).filter(
    (m) =>
      isDiscoverableStatus(m.status) &&
      // Defensively re-assert the requested kind even if the manifest reader
      // leaks a wrong-kind row — a `skill` row must never reach the `agent`
      // reader (the other half of the split-brain guard).
      (!input.kind || m.kind === input.kind),
  );

  const byKindManifests = new Map<string, ActiveExtensionManifest[]>();
  for (const m of manifests) {
    const list = byKindManifests.get(m.kind);
    if (list) list.push(m);
    else byKindManifests.set(m.kind, [m]);
  }

  const byKind: Record<string, unknown[]> = {};
  const unmigratedKinds: string[] = [];

  for (const [kind, kindManifests] of byKindManifests) {
    const handler = deps.resolveHandler(kind);
    if (!handler) {
      // Unknown kind in an active manifest — not fatal; record as unmigrated.
      unmigratedKinds.push(kind);
      continue;
    }
    if (typeof handler.listActive !== "function") {
      unmigratedKinds.push(kind);
      continue;
    }
    try {
      const descriptors = await handler.listActive({
        actor: input.actor,
        scope: input.scope,
        manifests: kindManifests,
      });
      byKind[kind] = descriptors;
    } catch (error) {
      options?.onError?.(kind, error);
      byKind[kind] = [];
    }
  }

  return {
    byKind,
    all: Object.values(byKind).flat(),
    unmigratedKinds,
  };
}
