// Data Safety: Undo & Versioning — public surface.
//
// Import path for in-repo consumers: `@/lib/object-history`.

export type {
  HistoryEffect,
  HistoryOperation,
  ActorKind,
  HistoryActor,
  HistoryWriteOptions,
  ObjectChangeEvent,
  ChangeSetRecord,
  ChangeSetHandle,
  CanonicalSnapshot,
  RemoteRevisionRef,
  RestoreIneligibleReason,
  RetentionPolicy,
  VersionConflictPayload,
  VersionConflictReason,
} from "./types";

export { VersionConflictError, isVersionConflictError, HistoryWriterContractError } from "./errors";

export {
  historyAwareUpsert,
  historyAwareSoftDelete,
  historyAwareTombstone,
  historyAwareUndelete,
  type HistoryAwareUpsertInput,
  type HistoryAwareSoftDeleteInput,
  type HistoryAwareTombstoneInput,
  type HistoryAwareUndeleteInput,
  type HistoryAwareUpsertResult,
} from "./canonical-writer";

export {
  openChangeSet,
  closeChangeSet,
  readChangeSetById,
  listChangeSets,
  combineEffect,
  type OpenChangeSetInput,
  type ListChangeSetsFilter,
} from "./change-set";

export {
  checkEventEligibility,
  isEventRestoreEligible,
  loadChangeSet,
  listEventsForObject,
  readObjectScopeById,
  rowToEvent,
  summarizeChangeSetEligibility,
  type EligibilityVerdict,
  type ChangeSetEligibilitySummary,
  type LoadedChangeSet,
  type ExternalFreshnessMap,
  type ObjectScopeSnapshot,
} from "./eligibility";

export {
  restoreChangeSet,
  restoreObjectToVersion,
  RestoreNotEligibleError,
  type RestoreChangeSetInput,
  type RestoreChangeSetResult,
  type RestoreObjectToVersionInput,
} from "./restore-engine";

export {
  getRetentionPolicy,
  listRetentionDeclarations,
  hasRetentionDeclaration,
  listRegisteredObjectTypes,
} from "./retention-policy";

export {
  buildSnapshotFromRow,
  computeEventChecksum,
  diffSnapshotFields,
  newIdempotencyKey,
  canonicalJsonStringify,
} from "./event-snapshot";

// External freshness contract + WordPress reference.
export {
  freshnessAllowsRestore,
  getFreshnessAdapter,
  listFreshnessAdapters,
  registerFreshnessAdapter,
  resolveExternalFreshness,
  resolveEventFreshness,
  freshnessCheckForChangeSet,
  type FreshnessAdapter,
  type FreshnessState,
  type ChangeSetFreshnessResult,
} from "./freshness";

// CMS remote-effect state machine.
export {
  enqueueRemoteEffect,
  markRemoteEffectSucceeded,
  markRemoteEffectFailed,
  listRemoteEffectsByChangeEvent,
  runCmsRestore,
  // Attempts visibility + admin retry.
  getRemoteEffectAttemptById,
  listRemoteEffectAttemptsForChangeSet,
  registerCmsRestoreAdapter,
  getCmsRestoreCallable,
  retryRemoteEffect,
  type CmsRestoreCallable,
  type EnqueueRemoteEffectInput,
  type MarkRemoteEffectSucceededInput,
  type MarkRemoteEffectFailedInput,
  type RemoteEffectAttempt,
  type RemoteEffectAttemptStatus,
  type RetryRemoteEffectResult,
} from "./cms-state-machine";

// Merge-proposal pattern.
export {
  submitMergeProposal,
  listPendingMergeProposals,
  readMergeProposalById,
  approveMergeProposal,
  rejectMergeProposal,
  type MergeProposal,
  type MergeProposalStatus,
  type ProposedField,
  type FieldProvenance,
  type SubmitMergeProposalInput,
  type ApproveMergeProposalInput,
  type RejectMergeProposalInput,
} from "./merge-proposals";

// Canonical write-action result contract.
export type { MutationResult } from "./mutation-result";
