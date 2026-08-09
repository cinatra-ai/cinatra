import "server-only";

import { readActiveManifestsFromStore } from "@cinatra-ai/extensions/runtime-discovery-host";

// ---------------------------------------------------------------------------
// A2A canonical install/lifecycle gate.
//
// Both A2A agent-exposure surfaces — the cached `/api/a2a` mount and the public,
// unauthenticated `/.well-known/agent.json` discovery card — build their
// AgentCard from `readPublishedAgentTemplates()`. Published status alone is NOT
// a lifecycle check: an agent can be `status='published'` while its
// `installed_extension` manifest is archived/uninstalled. This gate intersects
// the published set with the `active|locked` agent manifest set so an
// archived/uninstalled/never-installed agent is not advertised over A2A.
//
// Since cinatra#2605 the same set ALSO drops an agent whose required dependency
// is not installed — a published agent that every other surface refuses to run
// must not stay publicly advertised. This is the LIFECYCLE + PROVISIONING gate.
// The visibility policy (exclude PRIVATE
// agents) is applied SEPARATELY by the callers via isAgentPubliclyDiscoverable
// BEFORE calling this — so by the time templates reach here they are already
// public-only. Fail-OPEN: a gate read error / null set
// keeps every published template (the pre-gate behavior — never a NEW federation
// exposure; the published filter + per-run auth still apply).
//
// Shared (not duplicated per surface) so both A2A surfaces gate identically.
// ---------------------------------------------------------------------------

/** Keep only templates whose package is in the live manifest set. `null` set =
 *  inert/fail-open → return all. Pure; unit-tested. */
export function filterTemplatesToLiveManifest<T extends { packageName?: string | null }>(
  templates: T[],
  livePackageNames: Set<string> | null,
): T[] {
  if (!livePackageNames) return templates;
  return templates.filter((t) => t.packageName != null && livePackageNames.has(t.packageName));
}

/** A candidate published template's identity for the run-availability
 *  narrowing below — exactly the fields {@link resolveAgentRunAvailabilityMap}
 *  keys and fences on. */
export type LiveAgentPackageQueryItem = {
  packageName?: string | null;
  packageVersion?: string | null;
};

/**
 * The set of agent package names that may be ADVERTISED and RUN, or `null` when
 * the gate read fails (fail-open signal).
 *
 * Two conditions, one set (cinatra#659 + cinatra#2605):
 *   1. an `active|locked` canonical manifest — the lifecycle gate this function
 *      has always been;
 *   2. a `runnable` verdict from the SHARED agent run gate — so a published
 *      agent whose REQUIRED dependency is archived or was never installed is not
 *      advertised over A2A or registered as an MCP tool while `/agents`,
 *      `agent_list`, `agent_run`, the interactive run-start and project dispatch
 *      all refuse it. One verdict, every surface.
 *
 * `publishedItems` are the CALLER's published templates' `{packageName,
 * packageVersion}` pairs — round 3: the canonical manifest carries no version,
 * but the availability layer's dependency arm is only safe to evaluate when it
 * is fenced against the version that would actually run (see the SCOPE/version
 * fence notes on `resolveAgentRunAvailability`). Passing bare names (the
 * pre-round-3 shape) left the fence permanently open: an active published agent
 * at a NEWER version than its bundled catalog record had the catalog's stale
 * edges applied unconditionally. Threading each template's own packageVersion
 * lets the shared narrowing fence a mismatch (`state: "runnable"`, arm
 * skipped) and mark `versionAmbiguous` when the caller holds several templates
 * for one package at different versions — identical to every other consumer
 * (`assertAgentPackageRunnable`, `partitionRunnableAgentPackages`).
 *
 * Fail-OPEN at BOTH steps and independently: a manifest read failure returns
 * `null` (the callers keep every published template, the pre-gate behaviour),
 * and an availability failure returns the manifest set unnarrowed — a degraded
 * gate never removes a public federation surface that already works.
 *
 * Shared by both A2A surfaces and (via `setLiveAgentManifestProvider`) by the
 * dynamic published-agent MCP tool registration, so all three gate identically.
 */
export async function readLiveAgentPackageNames(
  publishedItems: ReadonlyArray<LiveAgentPackageQueryItem>,
): Promise<Set<string> | null> {
  let liveManifestNames: Set<string>;
  try {
    const manifests = await readActiveManifestsFromStore({ kind: "agent" });
    liveManifestNames = new Set(manifests.map((m) => m.packageName));
  } catch {
    return null;
  }
  try {
    // Dynamic import: this module is loaded by the public `/.well-known` route
    // and the A2A mount, and the gate pulls the canonical store + the generated
    // catalog behind it — kept off their static graph, as the agents package
    // does for the same reason.
    const { resolveAgentRunAvailabilityMap } = await import(
      "@cinatra-ai/agents/runtime-install-gate"
    );
    const versionedItems = publishedItems
      .filter(
        (item): item is { packageName: string; packageVersion?: string | null } =>
          typeof item.packageName === "string" && item.packageName.length > 0,
      )
      .map(({ packageName, packageVersion }) => ({
        packageName,
        packageVersion: packageVersion ?? null,
      }));
    const availability = await resolveAgentRunAvailabilityMap(versionedItems);
    return new Set(
      [...liveManifestNames].filter(
        (name) => (availability.get(name)?.state ?? "runnable") === "runnable",
      ),
    );
  } catch (err) {
    console.warn(
      "[a2a-manifest-gate] run-availability narrowing skipped (fail-open to the manifest set):",
      err instanceof Error ? err.message : err,
    );
    return liveManifestNames;
  }
}
