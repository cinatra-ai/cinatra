import "server-only";

export {
  createAgentTemplate,
  readAgentTemplates,
  readAgentTemplateById,
  updateAgentTemplate,
  createAgentVersion,
  readAgentVersionById,
  readAgentVersionsByTemplate,
  createAgentRun,
  updateAgentRunStatus,
  updateAgentRunTraceId,
  readAgentRunById,
  readAgentRunsByTemplate,
  readRunCoOwners,
  createAuditEvent,
  readAuditEventsByReviewTask,
  createRegistryEntry,
  readRegistryEntries,
  readRegistryEntryById,
  readRegistryEntriesByTemplate,
  readAllRegistryEntries,
  updateRegistryEntryStatus,
  createShareBinding,
  readShareBindingsForEntry,
  updateShareBinding,
  createAgentFork,
  readForksByEntry,
  readForkedTemplates,
  readTemplatesWithActivity,
  readAllAgentBuilderTemplates,
  readLatestRunPerTemplate,
  checkRegistryPermission,
  appendAgentRunMessage,
  readAgentRunMessages,
  updateAgentRunTitle,
  readAgentRunsBySourceId,
  findMostRecentRunBySource,
  readPublishedAgentTemplates,
  isAgentPubliclyDiscoverable,
  readAllAgentTemplatesWithPackageName,
  readInstalledAgentTemplates,
  updateAgentTemplatePackageVersion,
  readAgentRunByTaskId,
  readAgentRunByContextId,
  updateAgentRunA2ATaskId,
  updateAgentRunA2AContextId,
  readAgentRunsByParent,
  readAgentRuns,
} from "./store";

export type {
  AgentTemplateRecord,
  AgentVersionRecord,
  AgentRunRecord,
  CreateAgentTemplateInput,
  CreateAgentVersionInput,
  CreateAgentRunInput,
  CompiledStep,
  ApprovalPolicy,
  AuditEventRecord,
  CreateAuditEventInput,
  RegistryEntryRecord,
  CreateRegistryEntryInput,
  ShareBindingRecord,
  CreateShareBindingInput,
  AgentForkRecord,
  CreateAgentForkInput,
  AgentRunMessageRecord,
  AgentRunMessageBody,
  CreateAgentRunMessageInput,
} from "./store";

// ---------------------------------------------------------------------------
// Typed agent contract primitives
// ---------------------------------------------------------------------------
export type {
  CinatraAgentSpec,
  CinatraHandoff,
  CinatraTool,
  CinatraAgentProvider,
} from "./spec";

export { jsonSchemaToZod } from "./json-schema-to-zod";

export { createAgentsModule, createAgentsModule as createAgentBuilderModule } from "./integration/module";
export { createAgentsPrimitiveHandlers, createAgentBuilderPrimitiveHandlers } from "./mcp/handlers";
export { registerAgentBuilderPrimitives } from "./mcp/registry";
export { sanitizePackageNameToToolName, setLiveAgentManifestProvider } from "./mcp/agent-tools-registry";
export type { LiveAgentManifestProvider } from "./mcp/agent-tools-registry";
export {
  runAgentBuilderExecutionJob,
  assertOrchestratorReady,
  // Sentinel error + backoff helper consumed by the BullMQ dispatcher in
  // src/lib/background-jobs.ts, which catches and re-queues the job via
  // job.moveToDelayed when the trigger gate is closed.
  TriggerGateClosedError,
  gateBackoffMs,
} from "./execution";
// Compile-time side-effects inference for the trigger gate and UI.
export {
  collectGatedSteps,
  deriveTriggerMode,
  inferStepSideEffects,
  SIDE_EFFECT_PATTERNS,
} from "./trigger-infer-side-effects";
export type {
  GatedStep,
  TriggerMode,
  InferenceCompiledOas,
  InferenceStep,
} from "./trigger-infer-side-effects";
// Trigger gate, schedule, and release job.
export { runAgentRunTriggerReleaseJob } from "./trigger-release-job";
export {
  scheduleTrigger,
  cancelTriggerSchedule,
  type ScheduleTriggerArgs,
  type ScheduleResult,
  type CancelTriggerArgs,
} from "./trigger-schedule";
export { isTriggerReleased, markTriggerReleased } from "./trigger-gate";
// Run-duration estimation combines history and LLM analysis tiers. The
// first-step form calls estimateRunDuration server-side and passes the result
// into the client component for the "Preparation usually takes …" banner.
export {
  estimateFromHistory,
  estimateFromCompiledOas,
  estimateRunDuration,
} from "./trigger-duration-estimate";
export type {
  DurationEstimate,
  DurationSource,
  ConfidenceLevel,
  EstimateRunDurationArgs,
} from "./trigger-duration-estimate";
// Actor-aware trigger CRUD service. MCP handlers and internal callers import
// these directly to avoid going through the server-action wrappers in
// run-actions.ts.
export {
  setRunTriggerForActor,
  getRunTriggerForActor,
  deleteRunTriggerForActor,
  type TriggerActorContext,
  type SetTriggerForActorArgs,
  type SetTriggerForActorResult,
  type GetTriggerForActorResult,
  type DeleteTriggerForActorResult,
} from "./trigger-service";
export {
  buildLedgerFromChildren,
  OrchestratorLedgerSchema,
  OrchestratorLedgerEntrySchema,
  TERMINAL_STATUSES,
  cancelOrchestratorRun,
} from "./orchestrator-execution";
export type {
  OrchestratorLedger,
  OrchestratorLedgerEntry,
} from "./orchestrator-execution";
export { compileWorkflow } from "./compiler";
export {
  approveReviewTask,
  rejectReviewTask,
  publishToRegistry,
  forkRegistryEntry,
  runFromRegistry,
  updateBindingPermission,
  addShareBinding,
  recompileAgentTemplate,
  rollbackAgentTemplate,
} from "./actions";
// Auth-neutral approval helper for external /api/a2a/resume callers.
export { approveReviewTaskInternal } from "./review-task-actions";
export {
  exportAgentTemplate,
  importAgentTemplate,
  createLocalAgentTemplateVersion,
  type LocalAgentTemplateSeed,
} from "./import-export-actions";
export {
  installRegistryPackage,
  updateRegistryPackage,
  uninstallRegistryPackage,
} from "./actions";
export {
  installAgentFromPackage,
  installAgentPackageWithDependencies,
} from "./install-from-package";
export type {
  InstallAgentFromPackageInput,
  InstallAgentFromPackageResult,
  InstallAgentPackageWithDependenciesInput,
  InstallAgentPackageWithDependenciesResult,
} from "./install-from-package";
// WayFlow hot-reload client.
export { triggerWayflowReload } from "./wayflow-reload-client";
export type { ReloadResult, ReloadReport } from "./wayflow-reload-client";
// Install-time disk materialization.
export {
  materializeAgentPackageToDisk,
  backfillPublishedMarkers,
  PUBLISHED_MARKER_FILENAME,
  commitMaterialize,
  rollbackMaterialize,
  withInstallLock,
  withGlobalExtensionLifecycleLock,
} from "./materialize-agent-package";
export type { MaterializeResult, BackfillResult } from "./materialize-agent-package";
export {
  buildAgentPackageFiles,
  type AgentPackageFiles,
  type BuildAgentPackageInput,
} from "./verdaccio/package-files";
export {
  CINATRA_AGENT_PACKAGE_TYPE,
  CINATRA_AGENT_MANIFEST_VERSION,
  AGENT_PACKAGE_FORMAT_VERSION,
  parseAgentPackageManifest,
  parseAgentPackagePayload,
  isAgentPackageManifest,
  agentPackageRiskLevelSchema,
  type AgentPackageManifest,
  type AgentPackagePayload,
  type CinatraAgentPackageMetadata,
} from "./verdaccio/package-contract";
export {
  loadVerdaccioConfig,
  requireVerdaccioConfig,
  requireVerdaccioToken,
  type VerdaccioConfig,
} from "./verdaccio/config";
export {
  publishAgentPackage,
  deprecateAgentPackageVersion,
  setRegistryDistTag,
  type PublishAgentPackageInput,
  type PublishAgentPackageResult,
} from "./verdaccio/client";

// Read-side registry client, resolver, lockfile, and install-tree helpers from
// @cinatra-ai/registries. Re-export under public names (extract/list/get) and
// Agent*Error aliases for existing callers.
export {
  listAgentPackages,
  getAgentPackage,
  extractAgentPackage,
  cleanupExtractedAgentPackage,
  resolveDependencyTree as resolveAgentDependencyTree,
  PluginDependencyCycleError as AgentDependencyCycleError,
  PluginDependencyConflictError as AgentDependencyConflictError,
  PluginDependencyResolutionError as AgentDependencyResolutionError,
  PluginDependencyLimitError as AgentDependencyLimitError,
  PluginDependencyScopeError as AgentDependencyScopeError,
  installResolvedTree,
  LOCKFILE_VERSION,
  readLockfile,
  writeLockfile,
  lockfileFromTree,
  stableStringifyLockfile,
  lockfileShapeSchema,
} from "@cinatra-ai/registries";
export type {
  AgentPackageSummary,
  AgentPackageDetail,
  ResolvedNode,
  DependencyTree,
  FetchPackument,
  Packument,
  PackumentVersionEntry,
  InstallSideEffect,
  LockfileShape,
} from "@cinatra-ai/registries";

export { VersionHistoryPanel } from "./version-history-panel";
export { VersionHistoryPage } from "./version-history-page";
export { VersionDiffView } from "./version-diff-view";
export { RollbackButton } from "./rollback-button";

export { RegistryPermissionsScreen } from "./screens";

export { RegistryEntryDetailScreen } from "./screens";
export { PublishModal } from "./publish-modal";

export {
  SetupScreen as AgentBuilderInstanceSetupScreen,
  PermissionsScreen as AgentBuilderInstancePermissionsScreen,
} from "./instance-screens";

export { agentPluginScreens } from "./screens";
export { readAgentTemplateBySlug, slugifyAgentTemplateName } from "./store";
export { readAgentTemplateByPackageName, setAgentTemplatePackageName, seedCodeBasedAgentIoSpec, deleteAgentTemplate } from "./store";
export { readHitlPromptsForRun, updateHitlPromptExcluded, readNonExcludedAgentIdsForRun } from "./store";
export { runSkillAutosaveOnRunCompletion } from "./skill-autosave";
export type { HitlPromptRecord } from "./store";
// External A2A template helpers for composite-key upsert and lookup.
export {
  upsertExternalAgentTemplate,
  renameExternalAgentTemplateRemoteId,
  readAgentTemplateByConnectorAndRemoteId,
  findSavedConnectionForAgentUrl,
  deleteExternalAgentTemplatesByConnectorSlugExcept,
  deleteExternalAgentTemplatesByConnectorSlug,
} from "./store";
export { resolveDefaultOrgId } from "./store";
export {
  createAgentTemplateVersion,
  readLatestAgentTemplateVersion,
  readAgentTemplateVersions,
  readAgentTemplateVersionById,
  readAgentTemplateVersionBySemver,
  computeSnapshotContentHash,
  diffSnapshots,
  buildSnapshotFromTemplate,
  createAgentTemplateVersionIfChanged,
  determineBumpType,
  rollbackAgentTemplateToVersion,
} from "./store";
export type {
  AgentTemplateVersionRecord,
  AgentTemplateVersionSnapshot,
  AgentTemplateVersionListPage,
  ReadAgentTemplateVersionsOptions,
} from "./store";
export {
  createAgentRunPendingInput,
  updateAgentRunInputParams,
  readLatestAgentVersionIdForTemplate,
  transitionRunStatus,
  RunTransitionError,
  TERMINAL_RUN_STATUSES,
  updateAgentRunMeta,
  readChildRunHitlContext,
} from "./store";
export type { AgentRunStatus, ChildRunHitlContext } from "./store";
export { updateAgentType } from "./actions";
export { ensureAgentPackage, ensureAgentPackageFromGitFile } from "./ensure-agent-package";
export {
  fetchCampaignRecipients,
  removeEmailOutreachRecipient,
  type StageRecipient,
} from "./email-outreach-stage-actions";
export {
  triggerAgentRun,
  createPendingRunForZeroInputTemplate,
  type TriggerAgentRunArgs,
  type TriggerAgentRunResult,
  type CreatePendingRunArgs,
  type CreatePendingRunResult,
  resetAgentRun,
  type ResetAgentRunArgs,
  type ResetAgentRunResult,
} from "./run-actions";
export { StartNewRunButton } from "./start-new-run-button";
export type { StartNewRunButtonProps } from "./start-new-run-button";
export { getFieldRendererContextForAgentBuilderAction } from "./server-actions";
export {
  sendAgentBuilderMessage,
  getAgentBuilderTask,
  type TaskSnapshot,
  type HitlContext as A2ATaskHitlContext,
} from "./a2a-actions";
// Run name lives on agent_runs.title; field validation happens at the
// dispatcher's setup loop using the inputSchema directly.

export {
  fieldRendererRegistry,
  type FieldRendererEntry,
  type FieldRendererProps,
  type FieldRendererCondition,
  type FieldRendererContext,
  type GmailSendAsAliasOption,
} from "./field-renderer-registry";
export { ensureDefaultFieldRenderersRegistered } from "./register-default-renderers";

// Grouped setup form renderer.
export {
  GroupedSetupFormRenderer,
  isGroupedSetupFormField,
  GROUPED_SETUP_FORM_RENDERER_ID,
} from "./grouped-setup-form-renderer";

// Trigger-agent HITL renderers.
export {
  TriggerConfigureFormRenderer,
  TriggerConfirmSummaryRenderer,
} from "./trigger-agent-renderers";

// Skill-recommender-agent HITL renderer.
export { SkillRecommenderRenderer } from "./skill-recommender-agent-renderers";

// ---------------------------------------------------------------------------
// Tier 2a Selective Override Registry
// ---------------------------------------------------------------------------
export {
  agentUIOverrideRegistry,
  type AgentUIOverrideEntry,
  type AgentUIOverrideRendererProps,
  type AgentUIEventType,
} from "./agent-ui-override-registry";
// The compiler does not emit x-setup-steps; field collection happens via
// per-field AG-UI INTERRUPTs.

// ---------------------------------------------------------------------------
// Orchestrator screen surface (data layer)
// ---------------------------------------------------------------------------
export { buildSubAgentNodes } from "./orchestrator-readiness";
export type { SubAgentNodeData, SubAgentDisplayStatus } from "./orchestrator-readiness";

// ---------------------------------------------------------------------------
// Orchestrator run panel, sub-agent node, and server actions
// ---------------------------------------------------------------------------
export { OrchestratorRunPanel } from "./orchestrator-run-panel";
// ---------------------------------------------------------------------------
// Orchestrator RSC screens (sole owner of OrchestratorRunScreen)
// ---------------------------------------------------------------------------
export { OrchestratorRunScreen } from "./orchestrator-screens";
export type { OrchestratorRunPanelProps } from "./orchestrator-run-panel";
export { SubAgentNode } from "./orchestrator-sub-agent-node";
export type { SubAgentNodeProps } from "./orchestrator-sub-agent-node";
export {
  cancelOrchestratorAction,
  revalidateOrchestratorStatusAction,
  resumeStoppedOrchestratorAction,
} from "./orchestrator-actions";

// ---------------------------------------------------------------------------
// OrchestratorStepperPanel (state-driven Run tab UX)
// ---------------------------------------------------------------------------
export { OrchestratorStepperPanel } from "./orchestrator-stepper-panel";
export type {
  StepperStep,
  OrchestratorStepperPanelProps,
} from "./orchestrator-stepper-panel";

// ---------------------------------------------------------------------------
// AgentAuthPolicy framework.
// ---------------------------------------------------------------------------
export {
  enforceRunAccess,
  buildActorContextFromPrimitive,
  checkConnectorAccess,
  DEFAULT_AGENT_AUTH_POLICY,
  AgentAuthPolicySchema,
  OPERATION_PERMISSION,
} from "./auth-policy";
export type {
  AgentAuthPolicy,
  AgentAuthPolicyVisibility,
  RunAccessOperation,
  RunForAccessCheck,
  ActorRoleHints,
} from "./auth-policy";

// ---------------------------------------------------------------------------
// Extension lifecycle store helpers for usage predicates and dependency cascade.
// ---------------------------------------------------------------------------
export {
  countRunsForTemplate,
  // Batch SQL aggregation keeps catalog screens from issuing N+1 calls.
  countRunsForTemplates,
  readActiveExtensionTemplates,
  readArchivedExtensionTemplates,
  readAgentTemplatesDependingOn,
  // Destructive helper for extensionRegistry.forceDelete. NOT for general use;
  // bypasses RESTRICT FKs.
  removeReferencingRunRows,
} from "./store";

// ---------------------------------------------------------------------------
// Origin JSONB helpers.
// readAgentTemplateOrigin: used by resolveInstallEnvironment to route install.
// updateAgentTemplateOrigin: called by every publish path after successful publish.
// ---------------------------------------------------------------------------
export {
  readAgentTemplateOrigin,
  updateAgentTemplateOrigin,
} from "./store";
export type { ExtensionOrigin } from "./schema";

// ---------------------------------------------------------------------------
// LLM provider/model/capability policy. Re-exported so downstream consumers can
// import from `@cinatra-ai/agents` without reaching into package internals.
// ---------------------------------------------------------------------------
export {
  LLM_PROVIDERS,
  LLM_CAPABILITIES,
  ALLOWED_MODEL_IDS,
  DEFAULT_OPENAI_MODEL_ID,
  OasCinatraLlmSchema,
} from "./llm-provider-policy";
export type {
  LlmProvider,
  LlmCapability,
  OasCinatraLlm,
} from "./llm-provider-policy";

// ---------------------------------------------------------------------------
// Re-export deterministic scanners so `/api/oas-lint/scan-all` can run them on
// behalf of `@cinatra-ai/lint-policy-agent`. Re-export normalizeReviewFindings
// and the authorized-source allowlist so the merge step can enforce blocker authority.
// ReviewFinding types are part of the public review-contract surface.
// ---------------------------------------------------------------------------
export {
  scanOasForLiteralSecrets,
  scanOasForUntrustedUrls,
  scanOasForLlmBridgeWiring,
  scanOasForLlmMetadata,
  scanOasForStartNodeInputsWithoutRequired,
  scanOasForPackageVersionSync,
  scanAgentForRequiredLicense,
  normalizeReviewFindings,
  BLOCKER_AUTHORIZED_SOURCES,
} from "./validate-agent-json";
export type {
  ReviewFinding,
  ReviewFindingSeverity,
  ReviewFindingSource,
} from "./validate-agent-json";

// Shared review-merge helper used by the /api/review/merge route and the
// agent_creation_review MCP primitive.
export {
  mergeReviewLanes,
  restampLaneSource,
} from "./review-merge";
export type {
  ReviewLaneSource,
  PerLaneFindings,
  MergedReviewReport,
} from "./review-merge";

// agent_creation_review primitive handler with a deterministic orchestration boundary.
export {
  AGENT_CREATION_REVIEW_PRIMITIVE_NAME,
  handleAgentCreationReview,
} from "./agent-creation-review";
export type {
  AgentCreationReviewInput,
  AgentCreationReviewResult,
} from "./agent-creation-review";

// Re-export the HITL-run visibility filter so the chat runner can build
// per-agent function tools matching exactly the agent set surfaced at /agents/run.
export {
  selectHitlRunVisibleTemplates,
  templateHasOwnHitl,
} from "./hitl-run-filter";
export type { HitlRunFilterTemplate } from "./hitl-run-filter";

// AuthorDraft typed-artifact contract and strict extractor for the
// @cinatra-ai/author-agent extension. The extractor is the typed-artifact gate:
// the assistant NEVER reinterprets prose into authoring actions.
export {
  extractAuthorDraftFromText,
  AuthorDraftExtractionError,
} from "./author-draft";
export type {
  AuthorDraft,
  AuthorDraftPackage,
  AuthorDraftSkillFile,
  AuthorDraftKind,
  AuthorDraftExtractionErrorCode,
} from "./author-draft";

// Config-driven agent-creation dispatch resolver plus sentinel errors for
// pin-config and dispatch-site abort guards. Reads the agent-creation pin,
// provider, and model configuration.
export {
  resolveAgentCreationDispatch,
  AgentCreationPinConfigError,
  AgentCreationDispatchAbortError,
} from "./resolve-agent-creation-dispatch";
export type {
  ResolvedAgentCreationDispatch,
  AgentCreationPinConfigErrorCode,
  AgentCreationDispatchAbortCode,
} from "./resolve-agent-creation-dispatch";

// STRICT catalog resolver shared by `preflightAgentCreation` and
// `runAuthorAgent`. Unlike `loadReviewerPrompt`'s tolerant fallback, this
// RETHROWS catalog errors.
export { resolveRequiredCreationSkillIds } from "./resolve-required-creation-skill-ids";
export type { ResolvedLaneSkillSet } from "./resolve-required-creation-skill-ids";

// `runAuthorAgent` dispatch helper. Wraps the @cinatra-ai/author-agent LLM
// dispatch and strict AuthorDraft extractor typed-artifact gate. The assistant
// NEVER reinterprets prose into authoring actions; callers receive a typed
// AuthorDraft or a sentinel error.
export { runAuthorAgent } from "./run-author-agent";
export type { RunAuthorAgentInput } from "./run-author-agent";

// Hard pre-enqueue preflight. Fails as a configuration error before any
// authoring writes; NEVER a mid-run partial failure. Wired at the top of
// `handleAgentCreationReview` after JSON validation but before the deterministic
// lint pass so preflight failures aggregate into the same blocker stream as
// lint blockers.
export { preflightAgentCreation } from "./preflight-agent-creation";
export type {
  AgentCreationPreflightFailure,
  AgentCreationPreflightResult,
  AgentCreationPreflightInput,
} from "./preflight-agent-creation";
