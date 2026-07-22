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
