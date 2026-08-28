// Data Safety: Undo & Versioning — type contracts.
//
// These are the contract types for the canonical history-aware writer API
// and the restore engine. Every mutation of cinatra.objects flows through
// the canonical writer and emits exactly one object_change_event in the
// same DB transaction as the object mutation + Graphiti outbox enqueue.

import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";

export type HistoryEffect =
  | "reversible-internal"
  | "irreversible-logged"
  | "compensating-action";

export type HistoryOperation =
  | "create"
  | "update"
  | "soft-delete"
  | "hard-delete"
  | "tombstone"
  | "restore";

export type ActorKind = "user" | "agent" | "system";

export type RestoreIneligibleReason =
  | "schema-version-mismatch"
  | "irreversible-no-compensating"
  | "compensating-template-unapproved"
  | "hard-deleted"
  | "referenced-object-hard-deleted"
  | "referenced-object-archived-project"
  | "referenced-object-unwritable"
  | "retention-expired"
  | "external-source-missing"
  | "external-source-changed"
  | "external-source-unknown";

export type RetentionPolicy =
  | { kind: "indefinite" }
  | { kind: "duration"; days: number }
  | { kind: "tombstone-after"; days: number };

export type CanonicalSnapshot = {
  // Full row payload at the boundary. Includes data + identity metadata
  // (org_id, project_id, owner_level, owner_id, visibility, parent_id,
  // parent_type, deleted_at, version, type, agent_id, run_id, source,
  // canonical_keys, external_id, package_version, agent_spec_version,
  // created_at, updated_at, exported_to). NEVER trimmed at write-time;
  // tombstones may overwrite fields per the per-type tombstone policy.
  payload: Record<string, unknown>;
};

export type ObjectChangeEvent = {
  id: string;
  changeSetId: string;
  sequence: number;
  objectId: string;
  objectType: string;
  operation: HistoryOperation;
  historyEffect: HistoryEffect;
  beforeSnapshot: CanonicalSnapshot | null;
  afterSnapshot: CanonicalSnapshot | null;
  baseVersion: number | null;
  resultVersion: number;
  objectSchemaVersion: string;
  restoreEligible: boolean;
  restoreIneligibleReason: RestoreIneligibleReason | null;
  compensatingTemplateId: string | null;
  remoteRevisionRef: RemoteRevisionRef | null;
  actorId: string | null;
  actorKind: ActorKind | null;
  runId: string | null;
  auditEventId: string | null;
  orgId: string | null;
  projectId: string | null;
  ownerLevel: string | null;
  ownerId: string | null;
  visibility: string | null;
  idempotencyKey: string;
  eventChecksum: string;
  createdAt: string;
  tombstonedAt: string | null;
};

export type ChangeSetRecord = {
  id: string;
  orgId: string | null;
  openedAt: string;
  closedAt: string | null;
  closureReason: string | null;
  actorId: string | null;
  actorKind: ActorKind | null;
  runId: string | null;
  toolCallId: string | null;
  actionId: string | null;
  effectRollup: HistoryEffect;
  restorable: boolean;
  restorableReason: string | null;
  parentChangeSetId: string | null;
  restoreOfChangeSetId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RemoteRevisionRef = {
  // Pointer at a CMS-native revision (WordPress revision id, Drupal node
  // revision id, etc.). Surfaced uniformly on local history so the UI does
  // not need a second history surface.
  connector: string;
  kind: string;
  remoteId: string;
  revisionId?: string;
  modifiedAt?: string;
  extra?: Record<string, unknown>;
};

export type HistoryActor = {
  // CURRENT-actor identity: restore authz uses the CURRENT actor, not the
  // original actor that produced the event being restored. The original
  // actor is provenance only.
  actorId: string | null;
  actorKind: ActorKind;
  orgId: string | null;
  runId?: string | null;
  toolCallId?: string | null;
  actionId?: string | null;
};

export type ChangeSetHandle = {
  // Opaque to callers. The canonical writer auto-opens a change_set when no
  // handle is supplied (single-mutation case). A long-lived run may pass an
  // existing handle so multiple atomic mutations roll up under one change_set.
  changeSetId: string;
};

export type HistoryWriteOptions = {
  // CAS contract. REQUIRED for every write. When null, the writer asserts
  // the row does NOT yet exist (create-only). When
  // a number, the writer asserts the existing row's version matches before
  // mutating. Mismatch -> VersionConflictError.
  expectedBaseVersion: number | null;
  // Effect class for this mutation. Mandatory at the writer boundary; the
  // change_set's rollup is computed from member events.
  historyEffect: HistoryEffect;
  // Optional compensating template id when historyEffect is
  // "compensating-action". Required when historyEffect === "compensating-action".
  compensatingTemplateId?: string;
  // Optional pointer at a CMS-native revision.
  remoteRevisionRef?: RemoteRevisionRef;
  // Optional change_set handle. When omitted, the writer auto-opens and
  // auto-closes a change_set scoped to this single mutation.
  changeSet?: ChangeSetHandle;
  // Idempotency key (auto-generated when absent). Used to dedupe retries.
  idempotencyKey?: string;
  // Optional audit_events row id (RBAC trail). The history event links to
  // the decision; the snapshot lives here, NEVER in audit_events.
  auditEventId?: string;
  // Optional object_schema_version override. Defaults to the per-type
  // schema registry; restore-eligibility uses this to fence off unknown /
  // future schema versions.
  objectSchemaVersion?: string;
  // Actor context. Mandatory. The canonical writer never infers actor.
  actor: HistoryActor;
  // Org-write kernel authority (cinatra#1939 wave 3 Stage D). Mandatory —
  // minted host-side (verifySessionAuthority / sessionAuthorityFromResolvedRole
  // / a forwarded MCP-frame authority) and independently verified against
  // `actor.orgId` by the writer before any statement runs. The canonical writer
  // never mints one itself (dark-slice discipline, cinatra#1938).
  authority: OrgWriteAuthority;
  /**
   * CO-COMMIT statements (cinatra#1381) — caller SQL that must land in the SAME
   * transaction as this object write, or not at all. Consumed by
   * `historyAwareUpsert`, which appends them INSIDE the org-write-guarded batch
   * AHEAD of its own write statement, so they run under the same advisory lock
   * and the same capability guard, and a statement that RAISES rolls the write,
   * its history event and its Graphiti outbox row back with it.
   *
   * The one caller is memory row promotion, whose approve must transition the
   * promotion request and widen the row as a single commit (there is no
   * claimed-but-unapplied state to compensate). A caller that does NOT need
   * that atomicity must not use this: every statement here runs on the same
   * connection inside the write's transaction, so a slow or lock-taking
   * statement extends the org write lock's hold.
   *
   * The statements' RESULTS are not returned — the write's own result stays the
   * last batch entry. A co-commit statement therefore signals failure the only
   * way a batch can: by raising.
   *
   * STRUCTURAL, not documentary (cinatra#1381 review, finding 7): each entry
   * names a {@link CoCommitStatementKind} from a closed set, and the writer
   * refuses an unknown kind, a statement that is not one WITH/SELECT, and a
   * statement carrying a `;`. So the seam cannot be handed a transaction-control
   * statement that would end the guarded transaction out from under the write.
   */
  coCommitStatements?: ReadonlyArray<CoCommitStatement>;
};

/**
 * The CLOSED set of co-commit statement kinds. A co-commit statement runs
 * verbatim inside the write's guarded transaction, so the seam cannot be left
 * as "any string a caller passes": a caller that passed a transaction-control
 * statement would end the guarded transaction early, release the advisory lock
 * and leave the write running outside it. Naming each kind here makes the set
 * of statements that may ride the seam reviewable in one place, and the writer
 * refuses a kind it does not know (cinatra#1381 review, finding 7).
 *
 * Adding a kind is a deliberate act: add it here, and add the builder that
 * produces it to the list in the writer's guard comment.
 */
export type CoCommitStatementKind =
  /** `buildMemoryPromotionApproveClaim`: the pending -> approved CAS claim. */
  | "memory-promotion-approve-claim"
  /** `buildMemoryPromotionTeamContainmentAssert`: the locking team assert. */
  | "memory-promotion-team-containment-assert"
  /** `buildMemoryPromotionRequesterMembershipAssert`: the locking membership
   *  assert that re-checks the requester at approve time. */
  | "memory-promotion-requester-membership-assert";

/** A typed co-commit statement descriptor. */
export type CoCommitStatement = {
  readonly kind: CoCommitStatementKind;
  readonly text: string;
  readonly values?: readonly unknown[];
};

export type VersionConflictReason =
  | "stale-write"
  | "concurrent-mutation"
  | "schema-mismatch"
  | "row-missing"
  | "row-exists";

export type VersionConflictPayload = {
  objectId: string;
  currentVersion: number | null;
  expectedBaseVersion: number | null;
  latestSnapshot: CanonicalSnapshot | null;
  conflictingFields: string[];
  reason: VersionConflictReason;
};
