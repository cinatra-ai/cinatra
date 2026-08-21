"use server";

import {
  requireAdminSession,
  resolveOrgRoleForSession,
} from "@/lib/auth-session";
import {
  loadChangeSet,
  freshnessCheckForChangeSet,
  type LoadedChangeSet,
  type ChangeSetFreshnessResult,
} from "@/lib/object-history";
import { filterEventsForReadAccess } from "@/lib/object-history/server-views";
import { actorFromSession } from "@/lib/authz/build-actor-context";
import type { MutationResult } from "@/lib/object-history";

// UI server action wrapping the freshness probe.
// Mirrors the change-set detail page's authz: PLATFORM-ADMIN gate → org guard →
// per-event read redaction → freshness on readable events only (partial
// visibility). The MCP primitive freshness_check_for_change_set is the
// agent/direct-caller twin; both call freshnessCheckForChangeSet.
//
// cinatra#2700 (epic #2699) raised the session-only gate to platform-admin with
// the rest of the `/configuration/artifacts` action sweep: the only surface this
// probe belongs to is the artifacts console, which is admin-only throughout, and
// a server action never passes through the segment layout.
export async function freshnessCheckAction(input: {
  changeSetId: string;
}): Promise<MutationResult<ChangeSetFreshnessResult[]>> {
  const session = await requireAdminSession();
  const orgId = session.session?.activeOrganizationId ?? null;
  if (!orgId) {
    return { ok: false, error: "no active organization on session" };
  }
  const loaded = loadChangeSet(input.changeSetId, { orgId });
  if (!loaded) {
    return { ok: false, error: "change-set not found" };
  }
  const primitiveActor = actorFromSession(session);
  const orgRole = await resolveOrgRoleForSession(session);
  const filteredEvents = await filterEventsForReadAccess(
    loaded.events,
    primitiveActor,
    orgRole ? { orgRole } : undefined,
  );
  const view: LoadedChangeSet = {
    changeSet: loaded.changeSet,
    events: filteredEvents,
  };
  const results = await freshnessCheckForChangeSet(view, { orgId });
  return { ok: true, data: results };
}
