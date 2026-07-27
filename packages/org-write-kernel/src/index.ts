/**
 * @cinatra-ai/org-write-kernel — cinatra#1938 (archive epic S2).
 *
 * Curated public surface; internal modules are deliberately NOT exported as
 * subpaths (package.json exports the index only) and `mintPermit`/
 * `revokePermit` never leave the package boundary of the guard adapters.
 */
export {
  type OrgWriteCapability,
  type OrgLifecycleState,
  type CapabilityRuling,
  ORG_WRITE_CAPABILITIES,
  ORG_LIFECYCLE_STATES,
  ORG_WRITE_CAPABILITY_TABLE,
  lifecycleStateOf,
  ruleFor,
} from "./capabilities";
export {
  ORG_WRITE_LOCK_NAMESPACE,
  ORG_ARCHIVE_EPOCH_LOCK_NAMESPACE,
  type OrgLockRequest,
  type OrgWriteTx,
  type OrgWriteDb,
  orgLockStatements,
  orgLockQueries,
  acquireOrgLocks,
} from "./locks";
export {
  type LiveAttemptRow,
  type LiveAttemptClock,
  isLiveAttempt,
  liveAttemptSqlCondition,
} from "./live-attempt";
export {
  type OrgWritePermit,
  OrgWritePermitError,
  assertPermitUsable,
} from "./permit";
export {
  type OrgWriteState,
  readOrgWriteState,
  rowsOf,
  assertSafeSchemaName,
} from "./org-state";
export {
  ORG_ARCHIVE_LEASE_TABLE,
  type LeaseKey,
  leaseHeldQuery,
  leaseHeldStatement,
  snapshotLeasesQuery,
  invalidateLeasesBeforeEpochQuery,
  settleLeaseForRunStatement,
  settleLeaseForRunQuery,
} from "./leases";
export {
  type OrgWriteAuthority,
  type OrgWriteRefusalReason,
  type GuardOrgMutationRequest,
  OrgWriteRefusedError,
  guardOrgMutation,
  guardOrgLifecycleMutation,
} from "./guard";
export {
  type QueryInput,
  type GuardedOrgWriteBatch,
  type GuardedBatchRequest,
  guardQueryFor,
  buildGuardedOrgWriteBatch,
  guardedBatchQueries,
} from "./batch";
export {
  ORG_WRITE_COMPLETION_TICKET_TABLE,
  type RedeemTicketRequest,
  type RedeemOutcome,
  redeemCompletionTicket,
} from "./tickets";
