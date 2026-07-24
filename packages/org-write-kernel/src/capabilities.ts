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
  | "org.lifecycle"; // archive / unarchive / delete — epoch transitions

export type OrgLifecycleState = "active" | "archived";

export type CapabilityRuling = "allow" | "deny" | "lease-gated";

export const ORG_WRITE_CAPABILITIES: readonly OrgWriteCapability[] = [
  "content.write",
  "run.execute",
  "run.complete",
  "membership.write",
  "org.settings",
  "org.lifecycle",
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
 * `org.lifecycle` stays allowed while archived: unarchive (and delete of an
 * archived org) is how an organization leaves the state.
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
  },
  archived: {
    "content.write": "deny",
    "run.execute": "deny",
    "run.complete": "lease-gated",
    "membership.write": "deny",
    "org.settings": "deny",
    "org.lifecycle": "allow",
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
