export type { ActionJson, ArtifactActionIdentity, PinnedActionRevision, ArtifactActionCheckInput, ArtifactActionCheckResult, ArtifactActionCheckProvider, VerifiedExecutedRunSource } from "./index";
// Host-only addressing id: defined here (reached through the dedicated
// ./artifact-action-check-contract subpath), not on the public root and not
// on ./internal, which holds the fenced constants only.
export const ARTIFACT_ACTION_CHECK_CAPABILITY = "artifact-action-check/v1";
export { parseVerifiedExecutedRunSource } from "./index";
