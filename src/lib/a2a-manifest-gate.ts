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
// This is the LIFECYCLE gate. The visibility policy (exclude PRIVATE
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

/** The set of agent package names with an `active|locked` canonical manifest, or
 *  `null` when the gate read fails (fail-open signal). */
export async function readLiveAgentPackageNames(): Promise<Set<string> | null> {
  try {
    const manifests = await readActiveManifestsFromStore({ kind: "agent" });
    return new Set(manifests.map((m) => m.packageName));
  } catch {
    return null;
  }
}
