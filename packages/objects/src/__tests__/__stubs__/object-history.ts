// Test stub for `@/lib/object-history` used by packages/objects tests.
//
// The real module imports `runPostgresQueriesSync` + `ensurePostgresSchema`
// which require a worker-thread Postgres bridge that is not initialised in
// vitest. Tests that need behaviour assertions on the canonical writer
// should `vi.mock("@/lib/object-history")` locally.

export const readObjectScopeById = () => null;
export const resolveExternalFreshness = async () => new Map();
export const resolveEventFreshness = async () => ({ state: "unsupported" as const });
export const freshnessAllowsRestore = () => ({ allowed: true });
export const getFreshnessAdapter = () => null;
export const listFreshnessAdapters = () => [];
export const registerFreshnessAdapter = () => undefined;
export const enqueueRemoteEffect = () => ({ id: "rea_stub", changeEventId: "", connectorName: "", targetKind: "", targetId: null, intendedState: null, status: "pending" as const, attemptCount: 0, lastError: null, remoteRevisionRef: null, readBackPayload: null, idempotencyKey: "rea_stub", startedAt: "", updatedAt: "", orgId: null });
export const markRemoteEffectSucceeded = (input: { idempotencyKey: string }) => ({ id: "rea_stub", changeEventId: "", connectorName: "", targetKind: "", targetId: null, intendedState: null, status: "succeeded" as const, attemptCount: 1, lastError: null, remoteRevisionRef: null, readBackPayload: null, idempotencyKey: input.idempotencyKey, startedAt: "", updatedAt: "", orgId: null });
export const markRemoteEffectFailed = (input: { idempotencyKey: string }) => ({ id: "rea_stub", changeEventId: "", connectorName: "", targetKind: "", targetId: null, intendedState: null, status: "failed" as const, attemptCount: 1, lastError: "stub", remoteRevisionRef: null, readBackPayload: null, idempotencyKey: input.idempotencyKey, startedAt: "", updatedAt: "", orgId: null });
export const listRemoteEffectsByChangeEvent = () => [];
export const runCmsRestore = async () => ({ id: "rea_stub", status: "succeeded" as const });
export const submitMergeProposal = () => { throw new Error("submitMergeProposal stub"); };
export const listPendingMergeProposals = () => [];
export const readMergeProposalById = () => null;
export const approveMergeProposal = () => { throw new Error("approveMergeProposal stub"); };
export const rejectMergeProposal = () => { throw new Error("rejectMergeProposal stub"); };
export const loadChangeSet = () => null;
export const listChangeSets = () => [];
export const listEventsForObject = () => [];
export const summarizeChangeSetEligibility = () => ({
  eligible: true,
  reasons: [],
  details: [],
  perEvent: [],
});
export const restoreChangeSet = () => ({
  restoreChangeSetId: "stub_cs",
  appliedEventCount: 0,
  affectedObjects: [],
});
export const restoreObjectToVersion = () => ({
  restoreChangeSetId: "stub_cs",
  appliedEventCount: 0,
  affectedObjects: [],
});
export class RestoreNotEligibleError extends Error {
  changeSetId = "";
  reasons: string[] = [];
  details: string[] = [];
}

export class VersionConflictError extends Error {
  objectId = "";
  currentVersion: number | null = null;
  expectedBaseVersion: number | null = null;
  latestSnapshot = null;
  conflictingFields: string[] = [];
  reason: "stale-write" = "stale-write";
}
export const isVersionConflictError = (_e: unknown): _e is VersionConflictError => false;
export class HistoryWriterContractError extends Error {
  code: "missing-actor" = "missing-actor";
}

export const historyAwareUpsert = () => {
  throw new Error("historyAwareUpsert stub: vi.mock @/lib/object-history to override");
};
export const historyAwareSoftDelete = () => {
  throw new Error("historyAwareSoftDelete stub: vi.mock @/lib/object-history to override");
};
export const historyAwareTombstone = () => {
  throw new Error("historyAwareTombstone stub: vi.mock @/lib/object-history to override");
};
export const historyAwareUndelete = () => {
  throw new Error("historyAwareUndelete stub: vi.mock @/lib/object-history to override");
};

export const openChangeSet = () => ({ changeSetId: "stub_cs" });
export const closeChangeSet = () => ({
  id: "stub_cs",
  orgId: null,
  openedAt: "",
  closedAt: null,
  closureReason: null,
  actorId: null,
  actorKind: null,
  runId: null,
  toolCallId: null,
  actionId: null,
  effectRollup: "reversible-internal",
  restorable: true,
  restorableReason: null,
  parentChangeSetId: null,
  restoreOfChangeSetId: null,
  createdBy: null,
  createdAt: "",
  updatedAt: "",
});
export const readChangeSetById = () => null;
export const combineEffect = (a: string, _b: string) => a;
export const checkEventEligibility = () => ({
  eligible: true,
  reason: "ok",
  details: "",
});

export const getRetentionPolicy = () => ({ kind: "indefinite" as const });
export const listRetentionDeclarations = () => [];
export const hasRetentionDeclaration = () => true;
export const listRegisteredObjectTypes = () => [];

export const buildSnapshotFromRow = (
  row: Record<string, unknown> | null | undefined,
) => (row ? { payload: row } : null);
export const computeEventChecksum = () => "stub_checksum";
export const diffSnapshotFields = () => [];
export const newIdempotencyKey = () => "che_stub";
export const canonicalJsonStringify = (v: unknown) => JSON.stringify(v);
