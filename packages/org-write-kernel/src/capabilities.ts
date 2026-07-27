/**
 * The capability table — cinatra#1938 (archive epic S2).
 *
 * One total table answers "may this class of org write proceed in this
 * lifecycle state?". Totality is enforced by the types: adding a capability or
 * a state without ruling on every cell is a compile error (the same total-
 * Record discipline that caught the S1 permission-icon gap).
 *
 * "lease-gated" is NOT an allow: the guard must find an unexpired
 * `org_archive_lease` row matching {org_id, archive_epoch, run_id,
 * execution_attempt_id} in the same transaction, else it refuses (fail-closed).
 */

export type OrgWriteCapability =
  | "content.write" // dashboards, artifacts, objects — organization content
  | "run.execute" // agent-run lifecycle writes (dispatch, transitions)
  | "run.complete" // landing a run's outputs (the lease-gated archive path)
  | "membership.write" // member / invitation / team furniture
  | "org.settings" // organization row updates (name, slug, metadata)
  | "org.lifecycle" // archive / unarchive — epoch transitions
  // Delete of an organization — cinatra#1939 wave 3. Archived-only end state:
  // active → deny, archived → allow (delete is how an archived org leaves the
  // state entirely). DISTINCT from org.lifecycle, which is active-allow because
  // it authorizes ARCHIVING an active org — a single capability cannot express
  // both "archive active: yes" and "delete active: no". Transitional note
  // (Decision 1): until the org_archive_activation gate flips (S6), the delete
  // writer instead demands org.lifecycle (registry conditionalCapabilities) so
  // active-org delete keeps working; the S6 closeout removes that fallback.
  | "org.delete";

export type OrgLifecycleState = "active" | "archived";

export type CapabilityRuling = "allow" | "deny" | "lease-gated";

export const ORG_WRITE_CAPABILITIES: readonly OrgWriteCapability[] = [
  "content.write",
  "run.execute",
  "run.complete",
  "membership.write",
  "org.settings",
  "org.lifecycle",
  "org.delete",
];

export const ORG_LIFECYCLE_STATES: readonly OrgLifecycleState[] = [
  "active",
  "archived",
];

/**
 * The ruling table. Two steady states only: archive/unarchive transitions hold
 * both org locks and bump the archive epoch atomically (the kernel's
 * transition-atomicity contract), so no intermediate state is ever observable
 * by a guarded writer — an "unarchiving" row is a design error, not a state.
 *
 * `org.lifecycle` stays allowed while archived: unarchive is how an archived
 * org re-enters active life. `org.delete` is the archived-only exit
 * (active → deny): deleting an archived org is how it leaves existence — a
 * separate capability so archiving an active org (org.lifecycle, active-allow)
 * and deleting an active org (org.delete, active-deny) never share one ruling.
 */
export const ORG_WRITE_CAPABILITY_TABLE: Record<
  OrgLifecycleState,
  Record<OrgWriteCapability, CapabilityRuling>
> = {
  active: {
    "content.write": "allow",
    "run.execute": "allow",
    "run.complete": "allow",
    "membership.write": "allow",
    "org.settings": "allow",
    "org.lifecycle": "allow",
    "org.delete": "deny", // delete is archived-only — never an active org
  },
  archived: {
    "content.write": "deny",
    "run.execute": "deny",
    "run.complete": "lease-gated",
    "membership.write": "deny",
    "org.settings": "deny",
    "org.lifecycle": "allow",
    "org.delete": "allow", // delete of an archived org is its final exit
  },
};

/** Derive the lifecycle state from the org row's archive marker. */
export function lifecycleStateOf(row: {
  archivedAt: Date | string | null;
}): OrgLifecycleState {
  return row.archivedAt === null ? "active" : "archived";
}

export function ruleFor(
  state: OrgLifecycleState,
  capability: OrgWriteCapability,
): CapabilityRuling {
  return ORG_WRITE_CAPABILITY_TABLE[state][capability];
}
