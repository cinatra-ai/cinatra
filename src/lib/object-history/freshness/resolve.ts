// Freshness resolver: walks the events in a change_set, looks up the right
// adapter per event, and produces the ExternalFreshnessMap that the
// eligibility engine consumes.

import {
  freshnessAllowsRestore,
  getFreshnessAdapter,
  type FreshnessState,
} from "./contract";
import type { LoadedChangeSet, ExternalFreshnessMap } from "../eligibility";
import type { ObjectChangeEvent } from "../types";

export async function resolveExternalFreshness(
  loaded: LoadedChangeSet,
  options: { orgId: string | null } = { orgId: null },
): Promise<ExternalFreshnessMap> {
  const out = new Map<string, FreshnessState>();
  for (const event of loaded.events) {
    // Only events with a remote_revision_ref participate in the
    // external-freshness check. Local-only mutations are governed by the
    // local-only eligibility path.
    const ref = event.remoteRevisionRef;
    if (!ref) continue;
    const adapter = getFreshnessAdapter(ref.connector);
    if (!adapter) {
      out.set(event.objectId, { state: "unsupported" });
      continue;
    }
    try {
      const verdict = await adapter.check({
        objectId: event.objectId,
        orgId: options.orgId,
        remoteRevisionRef: ref,
      });
      out.set(event.objectId, verdict);
    } catch (e) {
      out.set(event.objectId, {
        state: "unknown",
        reason: `adapter '${ref.connector}' threw: ${(e as Error).message}`,
      });
    }
  }
  return out;
}

// Per-event helper used by single-object surfaces.
export async function resolveEventFreshness(
  event: Pick<ObjectChangeEvent, "objectId" | "remoteRevisionRef">,
  options: { orgId: string | null } = { orgId: null },
): Promise<FreshnessState> {
  const ref = event.remoteRevisionRef;
  if (!ref) return { state: "unsupported" };
  const adapter = getFreshnessAdapter(ref.connector);
  if (!adapter) return { state: "unsupported" };
  try {
    return await adapter.check({
      objectId: event.objectId,
      orgId: options.orgId,
      remoteRevisionRef: ref,
    });
  } catch (e) {
    return {
      state: "unknown",
      reason: `adapter '${ref.connector}' threw: ${(e as Error).message}`,
    };
  }
}

export { freshnessAllowsRestore };
