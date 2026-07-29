import "server-only";

/**
 * @cinatra-ai/llm — Unified LLM orchestration layer.
 *
 * All LLM interactions in the application should go through this package.
 * Provider adapters translate the unified interface to each SDK's native format.
 */

// Types
export type {
  LlmProvider,
  LlmCapabilityRequirement,
  LlmTool,
  LlmFunctionTool,
  LlmMcpServerTool,
  LlmWebSearchTool,
  LlmContainerSkillsTool,
  LlmToolParameterSchema,
  LlmMessage,
  LlmAttachmentRef,
  LlmAttachmentManifest,
  LlmToolCall,
  LlmToolResult,
  LlmUsageData,
  LlmResponse,
  SkillDeliveryMode,
  SkillExposureEntry,
  LlmStreamCallbacks,
  LlmCitation,
  LlmFileReference,
  UploadFileInput,
  LlmConnectionConfig,
  LlmConnectionStatus,
  LlmProviderAdapter,
  GenerateInput,
  StreamInput,
  FileInputGenerateInput,
  OrchestrateGenerateInput,
  OrchestrateStreamInput,
  OrchestrateFileInputGenerateInput,
  OrchestrateUploadFileInput,
  OrchestrateDeleteFileInput,
  // Batch API surface
  LlmBatchRequest,
  LlmBatchSubmitInput,
  LlmBatchSubmitResult,
  LlmBatchResult,
  LlmBatchStatus,
  LlmBatchOutputLine,
} from "./types";

// Attachment capability registry (pure).
export {
  CAPABILITY_RULES,
  resolveAttachmentCapability,
  extensionForIngestibleMime,
  filenameExtensionMatchesMime,
} from "./attachments/capability-registry";
export type {
  LlmProviderId,
  AttachmentNativeKind,
  CapabilityRule,
  CapabilityDecision,
} from "./attachments/capability-registry";
export {
  resolveAttachments,
  manifestToModelText,
} from "./attachments/resolve-attachments";
export type {
  ResolvedAttachmentPart,
  ResolvedAttachments,
  AttachmentResolverPorts,
} from "./attachments/resolve-attachments";

// External-MCP provider materializer (pure; llm-providers S2, #1713). Not
// wired into any adapter yet — the adapter-facing serialization lands in the
// post-#1707 adapter half. Exported here for the adapters + their tests.
export {
  materializeExternalMcpServers,
  normalizeMcpServerName,
  validateMcpServerUrl,
  resolveSingleAuthorization,
} from "./mcp-materializer";
export type {
  McpTransport,
  McpMaterializerInput,
  MaterializedMcpServer,
  McpMaterializerSkip,
  McpMaterializerResult,
} from "./mcp-materializer";

// Batch errors
export { BatchNotSupportedError } from "./errors";

// Cross-realm STRUCTURAL error discriminators (#1715 D1) — recognize a
// connector-inlined copy of these sentinels (different constructor identity)
// where `instanceof` fails. See errors.ts.
export {
  isAnthropicSkillDeliveryError,
  isBatchNotSupportedError,
  isNativeMcpCapabilityRequiredError,
  isMcpApprovalUnsupportedError,
  ANTHROPIC_SKILL_DELIVERY_ERROR_CODES,
} from "./errors";

// Registry — resolve adapters from connection config
export {
  resolveProviderAdapter,
  resolveFirstAvailableAdapter,
  resolveDefaultAdapter,
  // S6 exact binding (cinatra#2093): the throwing variant + the shared
  // implicit-global order helper + the named unavailability error.
  resolveBoundDefaultAdapter,
  resolveImplicitGlobalProviderOrder,
  BoundDefaultProviderUnavailableError,
  resolveDefaultImageAdapter,
  hasConfiguredLlmRuntime,
  resolveChatExternalMcpTools,
} from "./registry";

// Connection config type. The adapter + its `getConfiguredOpenAIConnection`
// resolver relocated into the openai connector (cinatra#1715); this host-local
// structural type is the shared shape the host runtime API still threads
// (`ResolvedLlmRuntime`, `DeterministicLlmExecutionInput.connection`). It is
// kept dependency-free and mirrors the connector's `OpenAILlmConnection`.
export type OpenAIConnectionConfig = {
  apiKey?: string;
  projectId?: string;
  organizationId?: string;
  defaultModel?: string;
  serviceTier?: string;
  loggingEnabled?: boolean;
  promptCachingEnabled?: boolean;
  lastValidatedAt?: string;
  availableModels?: string[];
};
// Exec-plane S2 (cinatra#1707): the restricted named skill-read surface OpenAI
// emits for skills-without-execution requests (singular-native-shell rule).
// Dependency-free leaf (NOT ./providers/openai — test mocks of the provider
// modules must not have to stub it).
export { SKILL_FILE_READ_TOOL_NAME } from "./tools/skill-read-tool";
// Per-model capability facts (hosted-shell support) — the single set shared by
// every shell-skill-delivery surface (chat runner gate, llm-bridge route).
export {
  OPENAI_SHELL_INCOMPATIBLE_MODEL_IDS,
  openAiModelSupportsShell,
} from "./providers/openai-model-capabilities";

// Skill tools. `createShellTool` (the connector-Docker executor) is RETIRED
// (exec-plane S2, cinatra#1707): skill execution runs on the execution plane.
// cinatra#2091 S4: `buildSkillTools` — the RAW shell-mount builder — is
// deliberately NOT re-exported from the package index any more. It is the
// delivery seam's own primitive (and rides to a relocated connector adapter
// through the core-owned `SkillDeliveryFloor`, never through this barrel), so
// removing it from the public surface makes the bypass the arch gate forbids
// unavailable rather than merely unused.
export {
  createLocalSkillShellTool,
  createMcpServerTool,
  createWebSearchTool,
  buildMcpTools,
  resolveSkillSummaries,
  resolveStagedSkillFiles,
} from "./tools/skills";

// SkillDeliveryAdapter centralizes provider-specific skill delivery.
export {
  selectSkillDeliveryAdapter,
  OpenAiShellSkillDelivery,
  GeminiInlineSkillDelivery,
  AnthropicContainerSkillDelivery,
  type SkillDeliveryAdapter,
  type SkillDeliveryResult,
  type SkillSelectionMode,
} from "./tools/skill-delivery";
export {
  getAnthropicSkillSyncMap,
  setAnthropicSkillSyncMap,
  resetAnthropicSkillSyncMap,
  type AnthropicSkillSyncMap,
  type AnthropicSyncedSkillRef,
} from "./tools/anthropic-skill-sync-map";
export {
  isAnthropicSkillUploadAllowed,
  defaultAnthropicSkillUploadGate,
  type AnthropicSkillUploadGate,
  // Upload-on-install consent policy (cinatra#2092, epic #2086 S5) — the pure
  // fail-closed decision every install surface shares.
  ANTHROPIC_SKILL_UPLOAD_EGRESS_ADVISORY,
  closureConsentDigest,
  buildAnthropicUploadConsentPrompt,
  resolveAnthropicUploadConsentDecision,
  type ConsentClosureMember,
  type ConsentPrompt,
  type ConsentDecision,
  type ConsentDecisionReason,
  type AnthropicUploadConsentInput,
} from "./tools/anthropic-skill-upload-gate";
export {
  AnthropicSkillDeliveryError,
  AnthropicSkillNotSyncedError,
  AnthropicSkillCapError,
  AnthropicFunctionToolSkillError,
  AnthropicSkillPreflightError,
} from "./errors";
export {
  computeSkillContentHash,
  normalizeBundledRelPath,
  ANTHROPIC_SKILL_MAX_UPLOAD_BYTES,
  buildCanonicalSkillZip,
  checkSkillBoundary,
  deriveAnthropicDisplayTitle,
  deriveSkillRootDir,
  type SkillBundledFile,
  type CanonicalSkillZip,
  type SkillZipFile,
  type SkillBoundaryCheck,
} from "./tools/anthropic-skill-content-hash";
export {
  FetchAnthropicCustomSkillsClient,
  ANTHROPIC_SKILLS_BETAS,
  isDisplayTitleConflict,
  type AnthropicCustomSkillsClient,
  type AnthropicSkillUpload,
  type CreateSkillResult,
  type CreateSkillVersionResult,
  FetchAnthropicCustomSkillsGcClient,
} from "./tools/anthropic-custom-skills-client";
export {
  AnthropicSkillGcEngine,
  type AnthropicSkillGcStatePort,
  type AnthropicSkillGcClientPort,
  type GcSyncRow,
  type GcResult,
  type GcReclaimed,
  type GcSkipped,
  type GcSkipReason,
} from "./tools/anthropic-skill-gc-engine";
export {
  AnthropicSkillSyncEngine,
  AnthropicSkillSyncFailedError,
  AnthropicSkillExpectedSetError,
  preflightAnthropicSkillSyncSizes,
  preflightSkillRequestSet,
  ANTHROPIC_SKILL_MAX_BYTES,
  type SyncCandidateSkill,
  type SyncRow,
  type SyncResult,
  type SyncOutcome,
  type ExpectedSetVerification,
  type AnthropicSkillSyncStatePort,
} from "./tools/anthropic-skill-sync-engine";
export {
  TableBackedAnthropicSkillSyncMap,
  type AnthropicSyncMapStatePort,
  type AnthropicSkillUsePermissionPort,
  type AnthropicSkillLeasePort,
} from "./tools/anthropic-skill-sync-map-table";

// Telemetry helpers. The anthropic in-core log writer + its dependency-free
// leaves (log directory, logging-state cache) relocated into the anthropic
// connector (cinatra#1715); the host now writes anthropic logs through the
// connector's `llm-provider-surface` `writeLogFile` (see telemetry.ts). Only
// the provider-transparent `writeLlmLogFile` router stays host-owned.
export { writeLlmLogFile } from "./telemetry";

// LLM MCP access helpers
export {
  getLlmMcpCredentials,
  hasLlmMcpAccess,
  getLlmMcpAccessStatus,
  getPublicMcpServerUrl,
  buildA2aBearerToken,
  buildLlmMcpServerTool,
  buildLlmMcpServerToolForChat,
  buildLlmMcpServerToolForAgentRun,
  buildLlmMcpServerToolForWidget,
  checkPublicMcpReachability,
} from "./mcp-access";
export type {
  ChatMcpActor,
  ChatMcpActorTokenIssuer,
  AgentRunMcpActor,
  AgentRunMcpActorTokenIssuer,
  WidgetMcpActor,
  WidgetMcpActorTokenIssuer,
  PublicMcpReachability,
} from "./mcp-access";

// Provider-neutral structured-JSON extraction (relocated from the openai
// connector — cinatra#151 Stage 2; identical signature and behavior).
export { parseStructuredJson } from "./structured-json";
// Core-owned INLINE skill delivery (cinatra#2091 S4). Exported so the assistant
// runtime — which assembles its own request rather than going through the
// deterministic entry points — can short-circuit an inline-mechanism provider
// through the SAME core expansion the entry points use.
export { deliverInjectedSkillsInline } from "./tools/skills";
export type { InlineSkillDeliveryResult } from "./tools/skills";
// The typed skill-injection contract (cinatra#2091, epic #2086 S4). Re-exported
// so an orchestration caller has ONE import site; the canonical home stays
// `@cinatra-ai/skills/injection` (a pure leaf).
export {
  resolveInjectedSkillSet,
  injectedSkillMembers as injectedSkillSetMembers,
  injectedCatalogSkillIds as injectedSkillSetCatalogIds,
  injectedSkillDrops as injectedSkillSetDrops,
  INJECTED_SKILL_CAP,
  SkillInjectionAuthorizationError,
  UnattributedSkillContentError,
  type ResolvedInjectedSkillSet,
  type InjectionIntent,
  type InjectionResolverPorts,
  type InjectedSkillDrop,
} from "@cinatra-ai/skills/injection";

// Legacy compatibility — skill artifact loader (used by campaign-email-outreach)
// `packages/llm/src/skills.ts` — the pre-contract skill-ARTIFACT loader and its
// markdown renderers — is DELETED (cinatra#2091 S4). It was the last vestige of
// the `{ skillIds, customSkillContent }` shape this slice removes: a loader that
// took an arbitrary id list plus an unattributed content blob and rendered them
// into a prompt. It had no consumer anywhere in the repo, and the typed
// injection contract is what replaces it.

// AsyncLocalStorage carrier for the triggering ActorContext.
// All four orchestration entry points wrap their bodies in withActorContext
// when input.actorContext is provided.
export {
  actorContextStorage,
  withActorContext,
  getActorContext,
  getActorContextOrThrow,
} from "./actor-context";

// Execution plane (exec-plane S1, cinatra#1706): the sandbox_execute tool
// contract, trusted session minting + sealing, and the single injection site.
export {
  EXECUTION_SURFACES,
  mintExecutionSession,
  sealExecutionSession,
  openSealedSession,
  UnidentifiableExecutionCallerError,
  ExecutionBrokerSecretMissingError,
  DEFAULT_CARRIER_TTL_MS,
  isExecutionPlaneRolloutEnabled,
  shouldSuppressExecutionForTask,
  ensureToolAwareStepBudget,
  composeExecutionCue,
  SANDBOX_EXECUTE_TOOL_NAME,
  isSandboxExecutionTool,
  hasSandboxExecutionTool,
  buildSandboxExecutionTool,
  stripSandboxExecutionTools,
  injectExecutionCapability,
} from "./execution-plane";
export type {
  ExecutionSurface,
  ExecutionSession,
  MintExecutionSessionInput,
  OpenSealedSessionResult,
  ExecutionAvailability,
  ExecutionCapabilityError,
  ExecutionInjectionResult,
  ExecutionInjectionParams,
} from "./execution-plane";
// Execution plane S2 (cinatra#1707): the executor-binding + staged-skill
// contract consumed by @cinatra-ai/execution-plane and the app wiring layer.
export type {
  SandboxExecutor,
  SandboxExecuteAction,
  SandboxExecuteOutput,
  SandboxStagedSkill,
  SandboxStagedSkillFile,
  SealedExecutionSessionCarrier,
  LlmSandboxExecutionTool,
  // Execution plane S3 (cinatra#1708): the resolved L1 declared-environment
  // mount projection the app wiring layer resolves and threads through.
  SandboxEnvironmentMount,
} from "./types";

// ---------------------------------------------------------------------------
// Backward-compatible wrapper functions
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { ExtensionToolboxBuildContext } from "@cinatra-ai/sdk-extensions";
import type { LlmProvider, LlmCapabilityRequirement, LlmProviderAdapter, LlmFileReference, GenerateInput, LlmTool, LlmUsageData, LlmResponse, LlmMcpServerTool, OrchestrateGenerateInput, OrchestrateStreamInput, OrchestrateUploadFileInput, OrchestrateFileInputGenerateInput, LlmAttachmentRef, SandboxExecutor, SandboxEnvironmentMount } from "./types";
// `OpenAIConnectionConfig` is defined+exported above (host-local structural type;
// the openai provider that once owned it relocated into its connector, #1715).
// Shared orchestration-entry attachment step plus the app-injected
// resolver-ports type used by the entry input types.
import {
  resolveEntryAttachments,
  resolveStreamMessageAttachments,
} from "./attachments/entry-resolve";
import type { AttachmentResolverPorts } from "./attachments/resolve-attachments";
import {
  resolveProviderAdapter,
  resolveFirstAvailableAdapter,
  resolveDefaultAdapter,
  resolveImplicitGlobalProviderOrder,
  resolveMcpToolsForDeclaredIds,
} from "./registry";
import { deliverInjectedSkillsInline } from "./tools/skills";
import { selectSkillDeliveryAdapter } from "./tools/skill-delivery";
import type { SkillSelectionMode } from "./tools/skill-delivery";
// The typed injection contract (cinatra#2091, epic #2086 S4). Pure leaf — no
// server-only, no fs, no DB — so importing it here adds no module graph.
import {
  assertAttributedInjectedSkillSet,
  describeInjectedSelection,
  injectedCatalogSkillIds,
  injectedIntentLabel,
  injectedPersonalDelta,
  injectedSkillDrops,
  injectedSkillMembers,
  isEmptyInjectedSkillSet,
  isInlineSkillMechanism,
} from "@cinatra-ai/skills/injection";
import type {
  InjectedSkillDrop,
  ResolvedInjectedSkillSet,
} from "@cinatra-ai/skills/injection";
import {
  injectExecutionCapability,
  stripSandboxExecutionTools,
  ensureToolAwareStepBudget,
} from "./execution-plane";
import type {
  ExecutionSession,
  ExecutionAvailability,
} from "./execution-plane";
import { emitUsageEvent } from "@cinatra-ai/metric-usage-api";
import type { ActorContext } from "@/lib/authz/actor-context";
import { withActorContext, getActorContext } from "./actor-context";
import {
  assertScriptedProviderNotProduction,
  isScriptedTestProviderEnabled,
  runScriptedStream,
} from "./scripted-test-provider";

// Fail-closed gate for LLM entry points.
// If no surrounding ALS frame exists AND the caller did not provide
// input.actorContext, throw ACTOR_CONTEXT_MISSING (unless explicitly
// disabled via CINATRA_REQUIRE_ACTOR_CONTEXT="false" for transitional
// non-prod environments). Production NEVER bypasses this gate.
function requireActorFrame<T>(
  entryPointName: string,
  ctx: ActorContext | undefined,
  run: () => T | Promise<T>,
): T | Promise<T> {
  if (getActorContext()) {
    return run();
  }
  if (ctx) {
    return withActorContext(ctx, run);
  }
  const requireFlag = process.env.CINATRA_REQUIRE_ACTOR_CONTEXT;
  const isProd = process.env.NODE_ENV === "production";
  const throwMissing = (): never => {
    const err = new Error(
      `${entryPointName} requires actorContext (no ALS frame established)`,
    );
    (err as Error & { code: string }).code = "ACTOR_CONTEXT_MISSING";
    throw err;
  };
  if (isProd) throwMissing();
  if (requireFlag === "false") return run();
  return throwMissing();
}

// ---------------------------------------------------------------------------
// Usage emission helpers
// ---------------------------------------------------------------------------

function emitLlmUsage(params: {
  provider: LlmProvider;
  model: string | undefined;
  operation: "generate" | "stream";
  logLabel: string | undefined;
  skillLabel: string | null;
  usage: LlmUsageData;
  idempotencyKey: string;
  requestedProvider?: string | null;
  effectiveProvider?: string | null;
}): void {
  emitUsageEvent({
    source: "llm",
    provider: params.provider,
    model: params.model ?? "unknown",
    operation: params.operation,
    agentLabel: params.logLabel ?? null,
    skillLabel: params.skillLabel,
    inputTokens: params.usage.inputTokens,
    outputTokens: params.usage.outputTokens,
    cachedInputTokens: params.usage.cachedInputTokens,
    reasoningOutputTokens: params.usage.reasoningOutputTokens,
    cacheReadInputTokens: params.usage.cacheReadInputTokens,
    cacheCreationInputTokens: params.usage.cacheCreationInputTokens,
    idempotencyKey: params.idempotencyKey,
    occurredAt: new Date().toISOString(),
    requestedProvider: params.requestedProvider ?? null,
    effectiveProvider: params.effectiveProvider ?? null,
  });
}

/**
 * Creates an onUsageData callback that emits a usage event.
 * Pass this into StreamInput.onUsageData to automatically capture streaming usage.
 */
export function createStreamUsageEmitter(params: {
  provider: LlmProvider;
  model: string | undefined;
  logLabel: string | undefined;
  skillLabel?: string | null;
}): (usage: LlmUsageData) => void {
  const idempotencyKey = randomUUID();
  return (usage) => {
    emitLlmUsage({
      provider: params.provider,
      model: params.model,
      operation: "stream",
      logLabel: params.logLabel,
      skillLabel: params.skillLabel ?? null,
      usage,
      idempotencyKey,
    });
  };
}

// NOTE: Streaming calls (adapter.stream()) capture usage via the onUsageData callback
// on StreamInput. Use createStreamUsageEmitter() to create a callback that automatically
// emits usage events. The generate()-based wrappers below handle emission automatically.

export type ResolvedLlmRuntime =
  | { provider: "openai"; connection: OpenAIConnectionConfig }
  | { provider: "anthropic" }
  | { provider: "gemini" };

export type DeterministicLlmExecutionInput = {
  provider: LlmProvider;
  system: string;
  user: string;
  connection?: OpenAIConnectionConfig | null;
  model?: string;
  maxSteps?: number;
  maxOutputTokens?: number;
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  logLabel?: string;
  reasoningEffort?: "low" | "medium" | "high";
  /**
   * Optional list of toolbox ids the calling agent declared from compiled
   * CompiledAgentOas.toolboxes. Threaded through to the adapter's
   * GenerateInput.declaredToolboxIds so both direct adapter calls and the
   * runSkillAwareDeterministicLlmTask path honor per-agent toolbox filtering.
   */
  declaredToolboxIds?: string[];
  /**
   * llm-providers S1 (#1712): the capability the dispatching agent pinned via
   * `metadata.cinatra.llm.capabilityRequired`. Threaded to the adapter's
   * `GenerateInput.capabilityRequired`. Absent ⇒ no capability gate. Today only
   * `"native_mcp"` is adapter-consumed (Anthropic native-fallback fail-closed).
   */
  capabilityRequired?: LlmCapabilityRequirement;
  /**
   * When provided AND no outer ALS frame is active, the entry point wraps its
   * body in withActorContext so downstream consumers (MCP handlers,
   * BullMQ-rehydrated workers, A2A callbacks) can read the originating actor
   * without explicit threading.
   */
  actorContext?: ActorContext;
  /**
   * Optional artifact attachments for THIS deterministic generation. Resolved
   * by the entry point (ingestible → provider-native part; non-ingestible →
   * manifest prepended to system). Omitted ⇒ byte-for-byte text-only behavior.
   */
  attachments?: LlmAttachmentRef[];
  /**
   * App-injected resolver ports (cache + provider upload), supplied by the
   * caller so llm never imports @/lib. Omitted ⇒ attachments
   * (if any) are NOT resolved (byte-identical text-only behavior).
   */
  attachmentResolverPorts?: AttachmentResolverPorts;
  /**
   * Execution plane (exec-plane S1, cinatra#1706). A pre-minted execution
   * session bound to `{orgId,userId,surface,runId?}`, supplied by the trusted
   * surface-layer issuer (agent execution / llm-bridge AFTER run-token
   * verification). Omitted ⇒ no attributable caller ⇒ the capability is
   * withheld (fail-closed). Only consulted when the rollout flag is on; live
   * behavior is byte-identical while the flag is off (default).
   */
  executionSession?: ExecutionSession;
  /**
   * Execution plane: the D4 per-org / per-agent availability posture. Defaults
   * to `"enabled"`; `"disabled"` (opt-out) yields a distinguishable
   * `capability_unavailable` and the model stays usable.
   */
  executionAvailability?: ExecutionAvailability;
  /**
   * Execution plane (exec-plane S2, cinatra#1707): the broker-backed executor
   * binding supplied by the app wiring layer. Absent ⇒ the capability is
   * withheld (`capability_unavailable`, fail-closed) even when the rollout
   * flag is on — a tool schema is never delivered without a live executor.
   */
  executionExecutor?: SandboxExecutor;
  /**
   * Execution plane (exec-plane S3, cinatra#1708): the run's resolved L1
   * declared-environment mount, supplied by the app wiring layer. Threaded to
   * the broker so the job mounts the declared layer. Absent ⇒ the L0 base
   * (byte-identical S1/S2 dispatch).
   */
  executionEnvironment?: SandboxEnvironmentMount;
  /**
   * Host-built, identity-free toolbox build context (cinatra#2019 S4),
   * threaded to `injectMcpTools` → first-party toolbox
   * `buildTools(provider, context)`. Carries WHERE the injection is being
   * assembled (`surface`) and, on run surfaces, WHICH connector instance the
   * run is pinned to (`connectorInstancePin` — host-derived run data only,
   * never request payload). Identity NEVER rides here — per-instance
   * authority derives host-side from the ambient trusted actor stores.
   * Absent ⇒ the deterministic entry points supply
   * `{ surface: "agent_run" }` at their own `injectMcpTools` call sites
   * (every entry point of this package is agent-plane orchestration;
   * chat/widget turns resolve their external tools via
   * `resolveChatExternalMcpTools` in the host runtime instead).
   */
  toolboxBuildContext?: ExtensionToolboxBuildContext;
};

export type SkillAwareDeterministicLlmExecutionInput = DeterministicLlmExecutionInput & {
  /**
   * The AUTHORITATIVE injected-skill set for this request (cinatra#2091, epic
   * #2086 S4). This replaces the former `skillIds: string[]` /
   * `customSkillContent` / `customSkillId` triple platform-wide.
   *
   * It is an OPAQUE BRANDED value constructible only by
   * `resolveInjectedSkillSet` (`@cinatra-ai/skills/injection`), so no caller can
   * name skills directly and no unattributed content can reach a provider: every
   * member carries a catalog skill id and a delivery mode, the personal delta is
   * a first-class member, and the hard cap of 8 TOTAL (delta included) has
   * already been applied by the resolver.
   *
   * REQUIRED — an intentionally skill-free call belongs on
   * `runDeterministicLlmTask` (the non-skill-aware API), not on an empty array
   * here.
   */
  injectedSkills: ResolvedInjectedSkillSet;
  /**
   * Skill-selection policy mode forwarded to the provider's delivery adapter,
   * whose per-provider cap is now a DEFENCE-IN-DEPTH invariant only (the
   * authoritative cap lives in the injection contract and has already run).
   * Absent ⇒ `"creation"` semantics at the adapter.
   */
  skillSelectionMode?: SkillSelectionMode;
  /**
   * Structured injection DROPS (cap truncation + inline-budget overflow), handed
   * back to the caller so it can feed the exposure/efficacy ledger. A core-owned
   * callback on the ENTRY input deliberately, so no new skill-delivery payload
   * field has to cross the provider-adapter v1 ABI. Called at most once, only
   * when something was dropped.
   */
  onInjectionDrops?: (drops: readonly InjectedSkillDrop[]) => void;
  useLiveTooling?: boolean;
  extraRequestBody?: Record<string, unknown>;
  /** Additional tools to pass alongside skill tools (e.g. createWebSearchTool()). */
  extraTools?: LlmTool[];
  /**
   * When true, skip injecting globally registered external MCP servers (e.g. Apify).
   * Use this for internal execution contexts where only explicitly declared MCPs
   * (passed via extraTools) should be available.
   */
  skipExternalMcpRegistry?: boolean;
  /**
   * Telemetry only. When set, the emitted LlmUsageEvent carries
   * `requestedProvider` (what `metadata.cinatra.llm.preferredProvider` asked
   * for, NULL when no preference) and `effectiveProvider` (the provider that
   * actually dispatched). The metric-cost subscriber persists both to
   * `usage_events.requested_provider` and `usage_events.effective_provider` so
   * operators can measure provider-preference honor rate.
   *
   * These fields do NOT affect dispatch — `preferredProvider` (above) controls
   * that. The bridge route sets both telemetry fields from the dispatch
   * outcome.
   */
  telemetryRequestedProvider?: string | null;
  telemetryEffectiveProvider?: string | null;
  /**
   * Optional override for the cinatra-mcp self-MCP tool. When provided AND
   * non-null, the orchestration layer substitutes the override's return value
   * for the default `cinatra-mcp` resolution (which mints a machine
   * `client_credentials` Bearer with no user/org identity). Used by
   * `/api/llm-bridge` to mint a run-scoped delegated MCP token
   * (`cinatra.agent-run.mcp-obo`) carrying the dispatching user's identity +
   * the run's org id + the run id. Without the override, agent runs hit
   * `not_org_member` at the MCP boundary because the machine actor has no
   * userId/orgId.
   *
   * Override is consulted only for the `cinatra-mcp` toolbox id. External
   * MCP toolboxes resolve through the normal registry path. A present
   * override owns the machine-token fallback too (#1195: the bridge mints
   * it itself to key the durable run-context binding to the exact bearer);
   * its null result is authoritative — no second mint in this layer.
   */
  cinatraMcpToolOverride?: () => Promise<LlmMcpServerTool | null>;
};

export type ResolvedDeterministicLlmExecutionInput = Omit<DeterministicLlmExecutionInput, "provider" | "connection"> & {
  runtime: ResolvedLlmRuntime;
};

export type ResolvedSkillAwareDeterministicLlmExecutionInput = Omit<
  SkillAwareDeterministicLlmExecutionInput,
  "provider" | "connection"
> & {
  runtime: ResolvedLlmRuntime;
  /**
   * Preferred-provider precedence. When set, the orchestration helper looks up
   * the adapter for this provider via `resolveProviderAdapter` rather than
   * honoring the `runtime.provider` carried in from `resolveConfiguredLlmRuntime`.
   * If the requested adapter is unavailable (no API key, factory returns null),
   * a `PreferredProviderUnavailableError` is thrown — the bridge route catches
   * it and decides between soft fallback (no capability gate) or 503
   * (capability gate set).
   *
   * When undefined, the existing `runtime.provider` path runs unchanged
   * (byte-for-byte identical fallback behavior).
   */
  preferredProvider?: LlmProvider;
  /**
   * When set alongside `preferredProvider`, this model id is forwarded into
   * `adapter.generate({ model })`. The bridge route is responsible for
   * validating the model belongs to `ALLOWED_MODEL_IDS[preferredProvider]`
   * before calling the orchestration helper; orchestration does not duplicate
   * that check.
   */
  preferredModel?: string;
};

// ---------------------------------------------------------------------------
// Preferred provider unavailability signal
// ---------------------------------------------------------------------------

/**
 * Thrown by `runResolvedSkillAwareDeterministicLlmTask` when the caller-
 * supplied `preferredProvider` cannot be resolved (no API key, adapter
 * factory returns null). The bridge route catches this and decides between
 * soft fallback (no `capabilityRequired`) or HTTP 503 (capability gate set).
 *
 * `reason` distinguishes the failure path so callers can build precise
 * error responses. "adapter_not_resolvable" today maps 1:1 to
 * "missing_api_key" — `resolveProviderAdapter` returns null exactly when
 * `getConfigured*Connection` returns no `apiKey`. The two-value union is
 * future-proofing for adapter factories that may distinguish them.
 */
export class PreferredProviderUnavailableError extends Error {
  readonly requestedProvider: LlmProvider;
  readonly reason: "adapter_not_resolvable" | "missing_api_key";
  constructor(requestedProvider: LlmProvider, reason: "adapter_not_resolvable" | "missing_api_key") {
    super(
      `Preferred LLM provider "${requestedProvider}" is unavailable (${reason}).`,
    );
    this.name = "PreferredProviderUnavailableError";
    this.requestedProvider = requestedProvider;
    this.reason = reason;
  }
}

async function getAdapter(provider: LlmProvider): Promise<LlmProviderAdapter> {
  const adapter = await resolveProviderAdapter(provider);
  if (!adapter) {
    throw new Error(`No ${provider} connection configured.`);
  }
  return adapter;
}

// ---------------------------------------------------------------------------
// MCP injection — single site for all orchestration entry points
// ---------------------------------------------------------------------------

/**
 * @internal
 * Centralized MCP tool injection — single site for all 4 orchestration entry
 * points (`runDeterministicLlmTask`, `runSkillAwareDeterministicLlmTask`,
 * `generate`, `stream`). Keeps MCP injection centralized
 * instead of wrapping provider adapters in `registry.ts`.
 *
 * Behavior preserved exactly from the prior wrapper:
 *   1. Gemini provider → returns `params.tools` unchanged (no native MCP)
 *   2. `skipMcpInjection: true` → returns `params.tools` unchanged
 *      (stream-only opt-out retained for callers)
 *   3. `params.tools` already contains `type: "mcp"` → unchanged (dedup)
 *   4. `resolveMcpToolsForDeclaredIds` returns `[]` (e.g. `declaredToolboxIds: []`,
 *      or credentials/tunnel unavailable) → unchanged
 *   5. `preserveFunctionTools: true` → keep `type: "function"` tools alongside
 *      MCP (client-side actions path); otherwise strip them
 *   6. Otherwise → return `[...mcpTools, ...filteredTools]`
 *
 * Stream-only flags (`skipMcpInjection`, `preserveFunctionTools`) are
 * accepted but only `stream` populates them. Generate-arm callers
 * omit both. `skipExternalMcpRegistry` is populated only by
 * `runSkillAwareDeterministicLlmTask` (forwards from
 * `SkillAwareDeterministicLlmExecutionInput.skipExternalMcpRegistry`).
 *
 * Exported (not declared inside the file body) so unit tests can call it
 * directly without booting all 4 entry points.
 */
export async function injectMcpTools(params: {
  provider: LlmProvider;
  tools: LlmTool[] | undefined;
  declaredToolboxIds: string[] | undefined;
  skipMcpInjection?: boolean;
  preserveFunctionTools?: boolean;
  skipExternalMcpRegistry?: boolean;
  /**
   * Optional override for the cinatra-mcp self-MCP tool. When provided it
   * fully owns the resolution: a delegated-actor MCP tool (run-scoped
   * agent-run-OBO token) or the bridge-minted machine fallback whose exact
   * bearer keys the durable run-context binding (#1195). A null result is
   * authoritative (no cinatra self-MCP tool this step) — this layer never
   * re-mints. External MCP toolboxes resolve through the normal registry
   * path either way.
   */
  cinatraMcpToolOverride?: () => Promise<LlmMcpServerTool | null>;
  /**
   * Host-built toolbox build context (cinatra#2019 S4) — see
   * `DeterministicLlmExecutionInput.toolboxBuildContext`. PASS-THROUGH:
   * this exported helper never invents a context — an absent value stays
   * absent all the way to the toolbox boundary, where surface-gating
   * toolboxes emit nothing (the fail-closed rule for unwidened callers).
   * The four orchestration entry points (`runDeterministicLlmTask`,
   * `runSkillAwareDeterministicLlmTask`, `generate`, `stream`) each supply
   * `{ surface: "agent_run" }` themselves — they are agent-plane surfaces;
   * the chat/widget runtime assembles its external MCP tools via
   * `resolveChatExternalMcpTools` and reaches this site only with MCP tools
   * already present (dedup passthrough above).
   */
  toolboxBuildContext?: ExtensionToolboxBuildContext;
}): Promise<LlmTool[] | undefined> {
  // Gemini has no native MCP — pass through.
  if (params.provider === "gemini") return params.tools;
  // Explicit opt-out for the stream/client-action path.
  if (params.skipMcpInjection) return params.tools;
  // Already-present MCP tool dedup.
  if (
    params.tools?.some(
      (t) => "type" in t && (t as { type: string }).type === "mcp",
    )
  ) {
    return params.tools;
  }
  const mcpTools = await resolveMcpToolsForDeclaredIds({
    provider: params.provider as "openai" | "anthropic",
    declaredToolboxIds: params.declaredToolboxIds,
    skipExternalMcpRegistry: params.skipExternalMcpRegistry,
    cinatraMcpToolOverride: params.cinatraMcpToolOverride,
    context: params.toolboxBuildContext,
  });
  if (mcpTools.length === 0) return params.tools;
  // Stream-only function-tool stripping.
  // The native MCP server tools cover every function capability dynamically.
  // Strip ALL type:"function" tools so the model gets exactly one canonical
  // call path via the MCP servers. Non-function tools (mcp, shell, web_search)
  // survive because they carry their own provider-native semantics.
  // Exception: when preserveFunctionTools is true, function tools are
  // intentionally passed by the caller (client-side action tools path)
  // and must NOT be stripped.
  const baseTools = params.preserveFunctionTools
    ? (params.tools ?? [])
    : (params.tools ?? []).filter(
        (t) => "type" in t && (t as { type: string }).type !== "function",
      );
  return [...mcpTools, ...baseTools];
}

/**
 * @internal
 * Run the single execution-capability injection site for an orchestration entry
 * point — the sibling of `injectMcpTools`, run alongside it and independent of
 * it (the sandbox tool is not `type:"function"`, so the MCP function-tool strip
 * leaves it alone; it is not `type:"mcp"`, so it is never an MCP dedup hit).
 *
 * S2 SCOPE (cinatra#1707) — the injected result IS delivered: the adapters
 * translate the `sandbox_execution` tool per provider (OpenAI native
 * `type:"shell"` with function-tool fallback under the singular-native-shell
 * rule; Anthropic/Gemini named function tool) and dispatch model calls back to
 * `tool.execute`. Tool + cue + step budget are delivered together — the
 * injection PRIMITIVE (`injectExecutionCapability`) composes them as one
 * inseparable unit, so they cannot diverge. The sealed session carrier lives
 * only in the tool's execute closure (S2 contract change), so it never crosses
 * the provider boundary even though the tool object now does.
 *
 * SECURITY — on every NON-injected status (passthrough incl. the flag-off
 * default, and unavailable) the returned `tools` are still stripped of every
 * `sandbox_execution` member: only THIS injection site may deliver the
 * capability, so a smuggled or stale sandbox tool never reaches a provider.
 * For every existing caller (none construct a `sandbox_execution` tool) the
 * strip is a structural no-op, so the provider payload is unchanged while the
 * rollout flag is off.
 *
 * `unavailable` (`no_session` / `capability_unavailable`) is logged as a
 * structured, non-fatal warning — the model stays usable.
 */
function applyExecutionInjection(params: {
  entryPoint: string;
  tools: LlmTool[] | undefined;
  session: ExecutionSession | undefined;
  availability: ExecutionAvailability | undefined;
  executor: SandboxExecutor | undefined;
  environment: SandboxEnvironmentMount | undefined;
  streaming: boolean;
  requestedMaxSteps: number | undefined;
  outputSchema: unknown;
}): {
  injected: boolean;
  tools: LlmTool[] | undefined;
  systemCue: string;
  maxSteps: number | undefined;
} {
  const result = injectExecutionCapability({
    tools: params.tools,
    session: params.session,
    availability: params.availability,
    executor: params.executor,
    ...(params.environment ? { environment: params.environment } : {}),
    task: {
      outputSchema: params.outputSchema,
      maxSteps: params.requestedMaxSteps,
    },
  });
  if (result.status === "injected") {
    // Deliver tool + cue + budget together. Streaming loops are already
    // tool-aware multi-step; non-streaming calls get the ≥1-post-tool-step
    // guarantee (never lowering a larger requested budget).
    return {
      injected: true,
      tools: result.tools,
      systemCue: result.systemCue,
      maxSteps: params.streaming
        ? params.requestedMaxSteps
        : ensureToolAwareStepBudget(params.requestedMaxSteps),
    };
  }
  if (result.status === "unavailable") {
    // Structured, non-fatal: distinguishable kind (`no_session` vs
    // `capability_unavailable`) preserved in the log for operability. The model
    // keeps its (stripped) tools and runs without the sandbox capability.
    console.warn(
      `[execution-plane] ${params.entryPoint}: capability ${result.error.kind} — ` +
        "model continues without sandbox_execute",
    );
  }
  // Non-injected (passthrough / unavailable): provider-boundary strip — only
  // the injection site may deliver the capability (see the SECURITY note).
  return {
    injected: false,
    tools: stripSandboxExecutionTools(params.tools),
    systemCue: "",
    maxSteps: params.requestedMaxSteps,
  };
}

export async function runDeterministicLlmTask(input: DeterministicLlmExecutionInput) {
  return requireActorFrame("runDeterministicLlmTask", input.actorContext, () =>
    runDeterministicLlmTaskImpl(input),
  );
}

async function runDeterministicLlmTaskImpl(input: DeterministicLlmExecutionInput) {
  const idempotencyKey = randomUUID();
  const adapter = await getAdapter(input.provider);
  // Explicit MCP injection. Behavior preserved: when input.declaredToolboxIds
  // is undefined, the always-inject set is applied; Gemini short-circuits to
  // undefined inside injectMcpTools.
  const tools = await injectMcpTools({
    provider: input.provider,
    tools: undefined,
    declaredToolboxIds: input.declaredToolboxIds,
    // Agent-plane entry point: default the build context HERE (not inside
    // the exported injectMcpTools) so direct helper callers keep the
    // absent-context fail-closed semantics (cinatra#2019 S4).
    toolboxBuildContext: input.toolboxBuildContext ?? { surface: "agent_run" },
  });
  // Execution-capability injection — exactly once, alongside (independent of)
  // MCP injection. Passthrough + byte-identical while the rollout flag is off.
  const exec = applyExecutionInjection({
    entryPoint: "runDeterministicLlmTask",
    tools,
    session: input.executionSession,
    availability: input.executionAvailability,
    executor: input.executionExecutor,
    environment: input.executionEnvironment,
    streaming: false,
    requestedMaxSteps: input.maxSteps,
    outputSchema: input.outputSchema,
  });
  // Resolve attachments AFTER MCP injection, BEFORE the adapter call. No-op +
  // byte-identical when no attachments / no ports.
  const resolved = await resolveEntryAttachments({
    attachments: input.attachments,
    ports: input.attachmentResolverPorts,
    provider: input.provider,
    model: input.model ?? adapter.defaultModel,
    system: input.system,
  });
  // Byte-identical when no cue (passthrough): preserve resolved.system exactly.
  const system = exec.systemCue
    ? [resolved.system, exec.systemCue].filter(Boolean).join("\n\n")
    : resolved.system;
  const response = await adapter.generate({
    system,
    prompt: input.user,
    model: input.model,
    tools: exec.tools,
    maxSteps: exec.maxSteps,
    maxTokens: input.maxOutputTokens,
    outputSchema: input.outputSchema,
    signal: input.signal,
    logLabel: input.logLabel,
    reasoningEffort: input.reasoningEffort,
    declaredToolboxIds: input.declaredToolboxIds,
    // llm-providers S1 (#1712): forward the pinned capability (Anthropic
    // native_mcp fail-closed). Absent ⇒ existing behavior.
    capabilityRequired: input.capabilityRequired,
    ...(resolved.resolvedAttachments
      ? { resolvedAttachments: resolved.resolvedAttachments }
      : {}),
  });

  if (response.usage) {
    emitLlmUsage({
      provider: input.provider,
      model: response.model ?? input.model,
      operation: "generate",
      logLabel: input.logLabel,
      skillLabel: null,
      usage: response.usage,
      idempotencyKey,
    });
  }

  return response;
}

export async function runResolvedDeterministicLlmTask(input: ResolvedDeterministicLlmExecutionInput) {
  return runDeterministicLlmTask({
    ...input,
    provider: input.runtime.provider,
    connection: input.runtime.provider === "openai" ? input.runtime.connection : undefined,
  });
}

export async function runSkillAwareDeterministicLlmTask(input: SkillAwareDeterministicLlmExecutionInput) {
  return requireActorFrame("runSkillAwareDeterministicLlmTask", input.actorContext, () =>
    runSkillAwareDeterministicLlmTaskImpl(input),
  );
}

async function runSkillAwareDeterministicLlmTaskImpl(input: SkillAwareDeterministicLlmExecutionInput) {
  const adapter = await getAdapter(input.provider);

  let skillTools: LlmTool[] = [];
  let skillContext = "";
  // Populated ONLY when the general selectable Anthropic path deterministically
  // rank-and-truncated an over-cap skill set.
  let skillSelection: LlmResponse["skillSelection"];
  // S10 efficacy loop (cinatra#1368). `skillExposure` accumulates every skill
  // delivered to the model on this call (adapter modes + the personal delta);
  // `invokedSkillIds` collects attributable per-skill invocations observed
  // during generate() (OpenAI shell reads). Both are surfaced on the response
  // for the bridge to record against the run.
  const skillExposure: LlmResponse["skillExposure"] = [];
  const invokedSkillIds = new Set<string>();

  // The typed injection contract is the ONLY source of delivered skills
  // (cinatra#2091 S4). Refuse unattributed content BEFORE any provider work —
  // the runtime half of "every member carries a skill id and a delivery mode".
  assertAttributedInjectedSkillSet(input.injectedSkills);

  // The contract's own drops (cap truncation) plus any inline-expansion drops
  // below. Surfaced on the response and recorded in the efficacy ledger.
  const injectionDrops: InjectedSkillDrop[] = [
    ...injectedSkillDrops(input.injectedSkills),
  ];
  // The personal delta is a first-class MEMBER of the set, always inline.
  const deltaMember = injectedPersonalDelta(input.injectedSkills);
  let personalContext = "";

  if (!isEmptyInjectedSkillSet(input.injectedSkills)) {
    // Core-owned provider -> mechanism map. An INLINE provider SHORT-CIRCUITS
    // here: core performs the budgeted one-hop reference expansion itself and
    // never consults a delivery adapter or a connector surface, so a router
    // skill's reference files are reachable on an inline provider exactly as
    // they are through tool-mount / container delivery.
    if (isInlineSkillMechanism(input.provider)) {
      const inline = await deliverInjectedSkillsInline({
        set: input.injectedSkills,
      });
      skillContext = inline.systemContext;
      skillExposure.push(...inline.exposure);
      injectionDrops.push(...inline.dropped);
    } else {
      // Provider-specific skill delivery stays centralized in the
      // `SkillDeliveryAdapter` seam (OpenAI native shell / Anthropic
      // container.skills). The adapter receives the ALREADY-CAPPED catalog
      // member ids; its own cap is a defence-in-depth invariant.
      const catalogSkillIds = injectedCatalogSkillIds(input.injectedSkills);
      // Resolve the adapter only when there IS something catalog-backed to
      // deliver — a delta-only set never touches the provider seam.
      if (catalogSkillIds.length > 0) {
        const delivery = selectSkillDeliveryAdapter(input.provider);
        const result = await delivery.deliver({
          skillIds: catalogSkillIds,
          selectionMode: input.skillSelectionMode,
          // Attributable per-skill invocations (OpenAI shell reads) accrue here.
          onSkillRead: (id) => invokedSkillIds.add(id),
        });
        skillTools = result.tools;
        skillContext = result.systemContext;
        skillExposure.push(...result.exposure);
      }
      // On a non-inline provider the delta still rides the system prompt.
      if (deltaMember?.content) {
        personalContext = `\n\nCustom skill instructions:\n${deltaMember.content}`;
        skillExposure.push({
          skillId: deltaMember.skillId,
          deliveryMode: "personal_inline",
          invocationAttributable: false,
        });
      }
    }
  }

  if (injectionDrops.length > 0) {
    // The contract's own cap drops come first (they were resolved before this
    // call); anything appended after them is an inline-expansion drop this call
    // produced. Both are surfaced, each described by the layer that made it —
    // the cap summary understates on its own.
    const capDropCount = injectedSkillDrops(input.injectedSkills).length;
    const capSummary = describeInjectedSelection(input.injectedSkills);
    const expansionDrops = injectionDrops.slice(capDropCount);
    skillSelection = {
      droppedSkillIds: injectionDrops.map((d) => d.skillId),
      selectionReason: [
        capSummary?.selectionReason,
        expansionDrops.length > 0
          ? `Core-side inline expansion additionally dropped ` +
            `${expansionDrops.length} whole skill(s): ` +
            expansionDrops.map((d) => `${d.skillId} (${d.reason})`).join(", ") +
            "."
          : null,
      ]
        .filter(Boolean)
        .join(" "),
    };
    // Structured drops go back to the CALLER through a core-owned callback,
    // NOT through the provider-adapter response: no new skill-delivery payload
    // field crosses either v1 ABI.
    input.onInjectionDrops?.(injectionDrops);
    console.warn(
      `[skill-injection] ${injectionDrops.length} skill(s) dropped for intent ` +
        `"${injectedIntentLabel(input.injectedSkills)}": ` +
        injectionDrops.map((d) => `${d.skillId} (${d.reason})`).join(", "),
    );
  }

  // Merge extraTools (e.g. createWebSearchTool()) into the tools array.
  const baseTools: LlmTool[] = [...skillTools, ...(input.extraTools ?? [])];
  // Single MCP injection site. The helper handles Gemini passthrough, MCP
  // dedup, and skipExternalMcpRegistry forwarding internally.
  const allTools = (await injectMcpTools({
    provider: input.provider,
    tools: baseTools,
    declaredToolboxIds: input.declaredToolboxIds,
    skipExternalMcpRegistry: input.skipExternalMcpRegistry,
    cinatraMcpToolOverride: input.cinatraMcpToolOverride,
    // Agent-plane entry point: default the build context HERE (not inside
    // the exported injectMcpTools) — see runDeterministicLlmTaskImpl.
    toolboxBuildContext: input.toolboxBuildContext ?? { surface: "agent_run" },
  })) ?? baseTools;

  // Resolve attachments AFTER MCP/skill injection, BEFORE the adapter call.
  // The not-readable manifest is prepended at the TOP of the composed system
  // prompt (highest-priority system note). No-op + byte-identical when no
  // attachments / no ports.
  const resolved = await resolveEntryAttachments({
    attachments: input.attachments,
    ports: input.attachmentResolverPorts,
    provider: input.provider,
    model: input.model ?? adapter.defaultModel,
    system: input.system,
  });
  // Execution-capability injection — exactly once, alongside (independent of)
  // MCP + skill injection. S1 is byte-identical at the provider boundary (the
  // injection is validated + logged but delivers nothing until S2 translates
  // the tool); `exec.tools` === `allTools`, `exec.systemCue` === "".
  const exec = applyExecutionInjection({
    entryPoint: "runSkillAwareDeterministicLlmTask",
    tools: allTools,
    session: input.executionSession,
    availability: input.executionAvailability,
    executor: input.executionExecutor,
    environment: input.executionEnvironment,
    streaming: false,
    requestedMaxSteps: input.maxSteps,
    outputSchema: input.outputSchema,
  });
  const execTools = exec.tools ?? allTools;
  const system = [resolved.system, personalContext, skillContext, exec.systemCue]
    .filter(Boolean)
    .join("\n\n");

  const idempotencyKey = randomUUID();
  const response = await adapter.generate({
    system,
    prompt: input.user,
    model: input.model,
    tools: execTools.length > 0 ? execTools : undefined,
    // Injected calls carry the tool-aware budget from applyExecutionInjection
    // (≥1 post-tool step, never lowering a larger request); non-injected calls
    // keep the existing default byte-identically.
    maxSteps: exec.injected
      ? (exec.maxSteps ?? input.maxSteps ?? 6)
      : (input.maxSteps ?? (allTools.length > 0 ? 6 : 1)),
    maxTokens: input.maxOutputTokens,
    outputSchema: input.outputSchema,
    signal: input.signal,
    logLabel: input.logLabel,
    reasoningEffort: input.reasoningEffort,
    declaredToolboxIds: input.declaredToolboxIds,
    // llm-providers S1 (#1712): forward the pinned capability so the adapter can
    // fail closed at runtime (Anthropic native_mcp). Absent ⇒ existing behavior.
    capabilityRequired: input.capabilityRequired,
    ...(resolved.resolvedAttachments
      ? { resolvedAttachments: resolved.resolvedAttachments }
      : {}),
  });

  if (response.usage) {
    emitLlmUsage({
      provider: input.provider,
      model: response.model ?? input.model,
      operation: "generate",
      logLabel: input.logLabel,
      skillLabel: injectedSkillMembers(input.injectedSkills)[0]?.skillId ?? null,
      usage: response.usage,
      idempotencyKey,
      requestedProvider: input.telemetryRequestedProvider ?? null,
      effectiveProvider: input.telemetryEffectiveProvider ?? null,
    });
  }

  // Surface the rank-and-truncate decision on the response so the general-path
  // caller (llm-bridge) can return it visibly. Absent on every non-truncating
  // call (creation, ≤8, OpenAI, Gemini).
  if (skillSelection) {
    response.skillSelection = skillSelection;
  }

  // S10 efficacy loop: surface exposure + attributable invocations so the
  // bridge can record them against the run. Absent when nothing was delivered.
  if (skillExposure.length > 0) {
    response.skillExposure = skillExposure;
  }
  if (invokedSkillIds.size > 0) {
    response.invokedSkillIds = [...invokedSkillIds];
  }

  return response;
}

export async function runResolvedSkillAwareDeterministicLlmTask(
  input: ResolvedSkillAwareDeterministicLlmExecutionInput,
) {
  // Preferred-provider precedence with existing fallback behavior.
  // When preferredProvider is undefined, the existing path runs unchanged.
  // When preferredProvider is set, look up the adapter via resolveProviderAdapter
  // and throw PreferredProviderUnavailableError if not resolvable. The bridge
  // route catches that error and decides between soft fallback / 503 based on
  // whether `capabilityRequired` was set.
  if (input.preferredProvider !== undefined) {
    const adapter = await resolveProviderAdapter(input.preferredProvider);
    if (!adapter) {
      throw new PreferredProviderUnavailableError(
        input.preferredProvider,
        "adapter_not_resolvable",
      );
    }
    // Strip orchestration-only fields before forwarding to the skill-aware
    // executor. The connection for openai is recomputed from the resolved
    // adapter path (getConfiguredOpenAIConnection already ran inside
    // resolveProviderAdapter); we rely on the inner getAdapter path here.
    const { preferredProvider, preferredModel, runtime: _runtime, ...rest } = input;
    return runSkillAwareDeterministicLlmTask({
      ...rest,
      provider: preferredProvider,
      // Override model when preferredModel is set; otherwise inherit the
      // caller's model (which may itself be undefined → adapter default).
      model: preferredModel ?? input.model,
      // openai requires a connection in the existing path; resolveProviderAdapter
      // already validated the api key exists, so getAdapter() in the inner
      // function will succeed without an explicit connection (it re-resolves).
      connection: undefined,
    });
  }
  // Existing fallback behavior.
  return runSkillAwareDeterministicLlmTask({
    ...input,
    provider: input.runtime.provider,
    connection: input.runtime.provider === "openai" ? input.runtime.connection : undefined,
  });
}

// ---------------------------------------------------------------------------
// Provider-transparent orchestration API
// ---------------------------------------------------------------------------

/**
 * Provider-transparent generate.
 * When input.provider is omitted, resolves the configured default internally.
 * Emits usage events automatically.
 */
export async function generate(input: OrchestrateGenerateInput): Promise<LlmResponse> {
  return requireActorFrame("generate", input.actorContext, () =>
    orchestrateGenerateImpl(input),
  );
}

async function orchestrateGenerateImpl(input: OrchestrateGenerateInput): Promise<LlmResponse> {
  const idempotencyKey = randomUUID();
  let adapter: LlmProviderAdapter;
  if (input.provider) {
    adapter = await getAdapter(input.provider);
  } else {
    const resolved = await resolveDefaultAdapter();
    if (!resolved) throw new Error("No LLM provider configured.");
    adapter = resolved;
  }
  // Strip the resolver inputs so they never reach the adapter; the adapter only
  // consumes the resolved native parts. ALSO runtime-strip `resolvedAttachments`
  // (cast required: the public type already Omits it, but a caller could
  // smuggle one via `as any`/JS — the resolver-bypass invariant must hold at
  // runtime, not just at the type).
  const {
    provider: _provider,
    attachments: _attachments,
    attachmentResolverPorts: _ports,
    resolvedAttachments: _smuggledResolvedAttachments,
    // Execution-plane inputs are consumed by the injection layer here and MUST
    // NOT spread into the adapter call (the adapter has no such fields and the
    // opaque carrier never crosses the provider boundary).
    executionSession: _executionSession,
    executionAvailability: _executionAvailability,
    executionExecutor: _executionExecutor,
    executionEnvironment: _executionEnvironment,
    ...adapterInput
  } = input as OrchestrateGenerateInput & { resolvedAttachments?: unknown };
  // Explicit MCP injection.
  const tools = await injectMcpTools({
    provider: adapter.provider,
    tools: adapterInput.tools,
    declaredToolboxIds: adapterInput.declaredToolboxIds,
    // Agent-plane entry point (cinatra#2019 S4). OrchestrateGenerateInput is
    // deliberately NOT widened with a context field — its remaining fields
    // spread into the provider adapter call below, and a context there would
    // cross the provider boundary. The fixed agent_run surface is supplied
    // here instead.
    toolboxBuildContext: { surface: "agent_run" },
  });
  // Execution-capability injection — exactly once, independent of MCP.
  const exec = applyExecutionInjection({
    entryPoint: "generate",
    tools,
    session: input.executionSession,
    availability: input.executionAvailability,
    executor: input.executionExecutor,
    environment: input.executionEnvironment,
    streaming: false,
    requestedMaxSteps: adapterInput.maxSteps,
    outputSchema: adapterInput.outputSchema,
  });
  // Resolve attachments AFTER MCP injection, BEFORE the adapter call. No-op +
  // byte-identical when no attachments / no ports.
  const resolvedAtt = await resolveEntryAttachments({
    attachments: input.attachments,
    ports: input.attachmentResolverPorts,
    provider: adapter.provider,
    model: input.model ?? adapter.defaultModel,
    system: input.system,
  });
  const response = await adapter.generate({
    ...adapterInput,
    // Byte-identical when no cue (passthrough): keep the exact resolved system
    // (which may be undefined) rather than coercing it to "".
    system: exec.systemCue
      ? [resolvedAtt.system, exec.systemCue].filter(Boolean).join("\n\n")
      : resolvedAtt.system,
    tools: exec.tools,
    maxSteps: exec.maxSteps,
    ...(resolvedAtt.resolvedAttachments
      ? { resolvedAttachments: resolvedAtt.resolvedAttachments }
      : {}),
  });
  if (response.usage) {
    emitLlmUsage({
      provider: adapter.provider,
      model: response.model ?? input.model,
      operation: "generate",
      logLabel: input.logLabel,
      skillLabel: input.skillLabel ?? null,
      usage: response.usage,
      idempotencyKey,
    });
  }
  return response;
}

/**
 * Provider-transparent stream.
 * When input.provider is omitted, resolves the configured default internally.
 * Injects usage emission into onUsageData automatically.
 */
export async function stream(input: OrchestrateStreamInput): Promise<void> {
  return requireActorFrame("stream", input.actorContext, () =>
    orchestrateStreamImpl(input),
  );
}

async function orchestrateStreamImpl(input: OrchestrateStreamInput): Promise<void> {
  // Test-only deterministic provider for the WordPress/Drupal Playwright UATs.
  // No-op unless CINATRA_TEST_LLM_PROVIDER=scripted; fail-loud under production
  // runtime so it can never serve a real user.
  assertScriptedProviderNotProduction();
  if (isScriptedTestProviderEnabled()) {
    return runScriptedStream(input);
  }

  let adapter: LlmProviderAdapter;
  if (input.provider) {
    adapter = await getAdapter(input.provider);
  } else {
    const resolved = await resolveDefaultAdapter();
    if (!resolved) throw new Error("No LLM provider configured.");
    adapter = resolved;
  }
  // Explicit MCP injection.
  // This is the ONLY entry point that populates skipMcpInjection /
  // preserveFunctionTools (stream-only flags).
  const tools = await injectMcpTools({
    provider: adapter.provider,
    tools: input.tools,
    declaredToolboxIds: input.declaredToolboxIds,
    skipMcpInjection: input.skipMcpInjection,
    preserveFunctionTools: input.preserveFunctionTools,
    // Agent-plane entry point (cinatra#2019 S4) — OrchestrateStreamInput is
    // not widened (chat streams pass pre-assembled MCP tools and hit the
    // dedup/skip passthroughs above); the fixed surface is supplied here.
    toolboxBuildContext: { surface: "agent_run" },
  });
  // Execution-capability injection — exactly once, independent of MCP. Stream is
  // a multi-step tool loop already, so no step-budget widening (streaming:true).
  const exec = applyExecutionInjection({
    entryPoint: "stream",
    tools,
    session: input.executionSession,
    availability: input.executionAvailability,
    executor: input.executionExecutor,
    environment: input.executionEnvironment,
    streaming: true,
    requestedMaxSteps: undefined,
    outputSchema: undefined,
  });
  const emitter = createStreamUsageEmitter({
    provider: adapter.provider,
    model: input.model ?? adapter.defaultModel,
    logLabel: input.logLabel,
    skillLabel: input.skillLabel ?? null,
  });
  // Strip the resolver inputs so they never reach the adapter; ALSO
  // runtime-strip `resolvedAttachments` (the public type already Omits it, but
  // a cast could smuggle one — the resolver-bypass invariant must hold at
  // runtime). Execution-plane inputs are consumed by the injection layer above
  // and must not spread into the adapter call.
  const {
    provider: _p,
    onUsageData,
    attachments: _attachments,
    attachmentResolverPorts: _ports,
    resolvedAttachments: _smuggledResolvedAttachments,
    executionSession: _executionSession,
    executionAvailability: _executionAvailability,
    executionExecutor: _executionExecutor,
    executionEnvironment: _executionEnvironment,
    ...rest
  } = input as OrchestrateStreamInput & { resolvedAttachments?: unknown };
  // Per-message resolution. Resolve EACH user message's attachments via the
  // per-message helper, which also SANITIZES every message (drops any
  // caller-smuggled `resolvedAttachments`, keeping only role + content +
  // internally-computed resolvedAttachments) and aggregates the not-readable
  // manifest into the system prefix. Request-level input.attachments is also
  // threaded in as a synthetic "current turn" so single-turn callers (no
  // messages[] attachments) still work — folded into the last user message
  // when present.
  const fullMessages = (() => {
    const ms = (rest.messages ?? []).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
      attachments: m.attachments,
    }));
    if (input.attachments && input.attachments.length > 0) {
      for (let i = ms.length - 1; i >= 0; i--) {
        if (ms[i]?.role === "user") {
          // Last user turn: prefer its own attachments; otherwise apply
          // the request-level set (legacy single-turn callers).
          const own = ms[i].attachments;
          if (!own || own.length === 0) {
            ms[i] = { ...ms[i], attachments: input.attachments };
          }
          break;
        }
      }
    }
    return ms;
  })();
  const streamResolve = await resolveStreamMessageAttachments({
    messages: fullMessages,
    ports: input.attachmentResolverPorts,
    provider: adapter.provider,
    model: input.model ?? adapter.defaultModel,
    system: input.system,
  });
  const { messages: _smuggledMessages, ...restNoMessages } = rest as typeof rest & {
    messages?: unknown;
  };
  return adapter.stream({
    ...restNoMessages,
    // Byte-identical when no cue (passthrough): preserve the exact resolved
    // system (which may be undefined) rather than coercing it to "".
    system: exec.systemCue
      ? [streamResolve.system, exec.systemCue].filter(Boolean).join("\n\n")
      : streamResolve.system,
    messages: streamResolve.messages,
    tools: exec.tools,
    onUsageData: (usage) => {
      emitter(usage);
      onUsageData?.(usage);
    },
  });
}

/**
 * Provider-transparent file upload.
 * When input.provider is omitted, resolves the configured default internally.
 * Throws a descriptive error if the resolved provider lacks uploadFile support.
 */
export async function uploadFile(input: OrchestrateUploadFileInput): Promise<LlmFileReference> {
  let adapter: LlmProviderAdapter;
  if (input.provider) {
    adapter = await getAdapter(input.provider);
  } else {
    const resolved = await resolveDefaultAdapter();
    if (!resolved) throw new Error("No LLM provider configured.");
    adapter = resolved;
  }
  if (!adapter.uploadFile) {
    throw new Error(
      `The configured LLM provider (${adapter.provider}) does not support file uploads. ` +
      "Switch to OpenAI or Anthropic in LLM settings."
    );
  }
  const { provider: _provider, ...adapterInput } = input;
  return adapter.uploadFile(adapterInput);
}

/**
 * Provider-transparent file deletion.
 * Routes to the provider that OWNS the file reference (fileRef.provider),
 * NOT the configured default — the file was uploaded to a specific provider.
 * No-ops gracefully if the provider is unconfigured or lacks deleteFile support.
 */
export async function deleteFile(fileRef: LlmFileReference): Promise<void> {
  const adapter = await resolveProviderAdapter(fileRef.provider);
  if (!adapter?.deleteFile) return;
  await adapter.deleteFile(fileRef);
}

/**
 * Provider-transparent file-input generation.
 * When input.provider is omitted, resolves the configured default internally.
 * Emits usage events automatically when the response includes usage data.
 * Throws a descriptive error if the resolved provider lacks generateWithFileInput support.
 */
export async function generateWithFileInput(
  input: OrchestrateFileInputGenerateInput,
): Promise<LlmResponse> {
  const idempotencyKey = randomUUID();
  let adapter: LlmProviderAdapter;
  if (input.provider) {
    adapter = await getAdapter(input.provider);
  } else {
    const resolved = await resolveDefaultAdapter();
    if (!resolved) throw new Error("No LLM provider configured.");
    adapter = resolved;
  }
  if (!adapter.generateWithFileInput) {
    throw new Error(
      `The configured LLM provider (${adapter.provider}) does not support file-input generation. ` +
      "Switch to OpenAI or Anthropic in LLM settings."
    );
  }
  const { provider: _provider, ...adapterInput } = input;
  const response = await adapter.generateWithFileInput(adapterInput);
  if (response.usage) {
    emitLlmUsage({
      provider: adapter.provider,
      model: response.model ?? input.model,
      operation: "generate",
      logLabel: input.logLabel,
      skillLabel: input.skillLabel ?? null,
      usage: response.usage,
      idempotencyKey,
    });
  }
  return response;
}

// ---------------------------------------------------------------------------
// Batch API dispatch
//
// Provider-transparent wrappers around adapter.submitBatch / retrieveBatch /
// downloadBatchResults / cancelBatch. Each takes a `provider` discriminator
// (required — there is no default-provider fallback for batch since the cost
// shape is provider-specific). When the resolved adapter does not implement
// the method (anthropic/gemini stubs throw internally; future provider may
// simply omit it), we throw `BatchNotSupportedError` with the provider name.
// ---------------------------------------------------------------------------

import type {
  LlmBatchSubmitInput,
  LlmBatchSubmitResult,
  LlmBatchResult,
  LlmBatchOutputLine,
  LlmBatchStatus,
} from "./types";
import { BatchNotSupportedError } from "./errors";

export type OrchestrateSubmitBatchInput = LlmBatchSubmitInput & {
  provider: LlmProvider;
};

export type OrchestrateRetrieveBatchInput = {
  provider: LlmProvider;
  batchId: string;
};

export type OrchestrateDownloadBatchResultsInput = {
  provider: LlmProvider;
  fileId: string;
};

export type OrchestrateCancelBatchInput = {
  provider: LlmProvider;
  batchId: string;
};

export async function orchestrateSubmitBatch(
  input: OrchestrateSubmitBatchInput,
): Promise<LlmBatchSubmitResult> {
  const adapter = await getAdapter(input.provider);
  if (!adapter.submitBatch) {
    throw new BatchNotSupportedError(input.provider);
  }
  const { provider: _provider, ...adapterInput } = input;
  return adapter.submitBatch(adapterInput);
}

export async function orchestrateRetrieveBatch(
  input: OrchestrateRetrieveBatchInput,
): Promise<LlmBatchResult> {
  const adapter = await getAdapter(input.provider);
  if (!adapter.retrieveBatch) {
    throw new BatchNotSupportedError(input.provider);
  }
  return adapter.retrieveBatch(input.batchId);
}

export async function orchestrateDownloadBatchResults(
  input: OrchestrateDownloadBatchResultsInput,
): Promise<LlmBatchOutputLine[]> {
  const adapter = await getAdapter(input.provider);
  if (!adapter.downloadBatchResults) {
    throw new BatchNotSupportedError(input.provider);
  }
  return adapter.downloadBatchResults(input.fileId);
}

export async function orchestrateCancelBatch(
  input: OrchestrateCancelBatchInput,
): Promise<{ batchId: string; status: LlmBatchStatus }> {
  const adapter = await getAdapter(input.provider);
  if (!adapter.cancelBatch) {
    throw new BatchNotSupportedError(input.provider);
  }
  return adapter.cancelBatch(input.batchId);
}

export async function resolveConfiguredLlmRuntime(input?: {
  preferredProviders?: LlmProvider[];
  openaiConnection?: OpenAIConnectionConfig | null;
}): Promise<ResolvedLlmRuntime | null> {
  let providers: LlmProvider[];
  if (input?.preferredProviders) {
    // Explicit caller preference (the S6 purpose policy's `explicit-pin`) is
    // honored verbatim and is AUTHORITATIVE.
    providers = input.preferredProviders;
  } else {
    // This is the SECOND implicit-global resolver (alongside registry.ts
    // `resolveFirstAvailableAdapter`). S6 (cinatra#2093) makes BOTH derive
    // their order from the one shared helper, so the un-fencing and the exact
    // binding can never apply to one resolver and not the other:
    //
    //  - the eligible set comes from the ABI v2 `defaultCapable` flag, not a
    //    hardcoded `["openai","gemini"]` — Anthropic is un-fenced here in the
    //    same coherent change as the other three sites;
    //  - resolution binds to the STORED provider EXACTLY unless the admin has
    //    stored the explicit `"ordered"` failover policy.
    //
    // The `allowAnthropicFallback` opt-in this function used to carry is
    // RETIRED (S6 deliverable): it existed only to let a per-purpose caller
    // reach Anthropic past the global exclusion. With Anthropic
    // default-capable, an Anthropic-only install resolves Anthropic because it
    // IS the stored default — no special case, and no path by which a caller
    // silently lands on a provider the operator did not choose.
    providers = resolveImplicitGlobalProviderOrder().providers;
  }

  for (const provider of providers) {
    const adapter = await resolveProviderAdapter(provider);
    if (adapter) {
      if (provider === "openai") {
        // The openai adapter (and its `getConfiguredOpenAIConnection` resolver)
        // relocated into the openai connector (cinatra#1715). Read the openai
        // connection snapshot through the REGISTERED connector's server module —
        // the same host pattern connector-readiness / the LLM APIs page use —
        // rather than an in-tree provider import (there is none). `adapter` above
        // already confirmed the connector is registered + configured.
        const { loadConnectorModule } = await import("@/lib/connector-modules.server");
        const mod = await loadConnectorModule<{
          getConfiguredOpenAIConnection: (
            connection?: OpenAIConnectionConfig | null,
          ) => Promise<OpenAIConnectionConfig | null>;
        }>("openai-connector");
        const connection =
          (await mod?.getConfiguredOpenAIConnection(input?.openaiConnection)) ?? null;
        if (connection) {
          return { provider: "openai", connection };
        }
      } else {
        return { provider } as ResolvedLlmRuntime;
      }
    }
  }

  return null;
}
