// Freshness probe for a change-set.
//
// Walks a change-set's events, resolves external freshness for those carrying
// a remoteRevisionRef, and returns a per-event verdict array. The CALLER is
// responsible for read-redaction first: a redacted event has its
// remoteRevisionRef scrubbed to null, so it is automatically skipped here
// (partial-visibility: never leak remote status for events the actor can't
// read).

import type { LoadedChangeSet } from "../eligibility";
import { resolveExternalFreshness } from "./resolve";
import type { FreshnessState } from "./contract";

export type ChangeSetFreshnessResult = {
  eventId: string;
  objectId: string;
  freshness: FreshnessState;
};

export async function freshnessCheckForChangeSet(
  loaded: LoadedChangeSet,
  options: { orgId: string | null },
): Promise<ChangeSetFreshnessResult[]> {
  const map = await resolveExternalFreshness(loaded, options);
  const results: ChangeSetFreshnessResult[] = [];
  for (const event of loaded.events) {
    // Only CMS-tagged events participate. Redacted events have a null
    // remoteRevisionRef and are skipped (no remote-status leak).
    if (!event.remoteRevisionRef) continue;
    const freshness: FreshnessState =
      map.get(event.objectId) ?? { state: "unknown", reason: "not resolved" };
    results.push({ eventId: event.id, objectId: event.objectId, freshness });
  }
  return results;
}
