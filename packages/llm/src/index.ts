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

// Batch errors
export { BatchNotSupportedError } from "./errors";

// Registry — resolve adapters from connection config
export {
  resolveProviderAdapter,
  resolveFirstAvailableAdapter,
  resolveDefaultAdapter,
  resolveDefaultImageAdapter,
  hasConfiguredLlmRuntime,
  createOpenAIProviderAdapter,
  createAnthropicProviderAdapter,
  createGeminiProviderAdapter,
  resolveChatExternalMcpTools,
} from "./registry";

// Connection helpers
export { getConfiguredOpenAIConnection, type OpenAIConnectionConfig } from "./providers/openai";
// Per-model capability facts (hosted-shell support) — the single set shared by
// every shell-skill-delivery surface (chat runner gate, llm-bridge route).
export {
  OPENAI_SHELL_INCOMPATIBLE_MODEL_IDS,
  openAiModelSupportsShell,
} from "./providers/openai-model-capabilities";
export { type AnthropicConnectionConfig } from "./providers/anthropic";
export { getConfiguredGeminiConnection, DEFAULT_GEMINI_MODEL } from "./providers/gemini";

// Skill tools
export {
  createShellTool,
  createLocalSkillShellTool,
  createMcpServerTool,
  createWebSearchTool,
  buildMcpTools,
  buildSkillTools,
  resolveSkillSummaries,
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
  type SkillBundledFile,
} from "./tools/anthropic-skill-content-hash";
export {
  FetchAnthropicCustomSkillsClient,
  ANTHROPIC_SKILLS_BETAS,
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
  preflightAnthropicSkillSyncSizes,
  preflightSkillRequestSet,
  ANTHROPIC_SKILL_MAX_BYTES,
  type SyncCandidateSkill,
  type SyncRow,
  type SyncResult,
  type SyncOutcome,
  type AnthropicSkillSyncStatePort,
} from "./tools/anthropic-skill-sync-engine";
export {
  TableBackedAnthropicSkillSyncMap,
  type AnthropicSyncMapStatePort,
  type AnthropicSkillUsePermissionPort,
  type AnthropicSkillLeasePort,
} from "./tools/anthropic-skill-sync-map-table";

// Telemetry helpers.
export {
  writeAnthropicLogFile,
  writeLlmLogFile,
  ANTHROPIC_API_LOG_DIRECTORY,
  getAnthropicLoggingSettings,
  setAnthropicLoggingEnabled,
} from "./telemetry";

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
  checkPublicMcpReachability,
} from "./mcp-access";
export type {
  ChatMcpActor,
  ChatMcpActorTokenIssuer,
  AgentRunMcpActor,
  AgentRunMcpActorTokenIssuer,
  PublicMcpReachability,
} from "./mcp-access";

// Provider-neutral structured-JSON extraction (relocated from the openai
// connector — cinatra#151 Stage 2; identical signature and behavior).
export { parseStructuredJson } from "./structured-json";

// Legacy compatibility — skill artifact loader (used by campaign-email-outreach)
export { createSkillArtifactLoader, type SkillArtifactLoader, type SkillArtifact } from "./skills";

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

// ---------------------------------------------------------------------------
// Backward-compatible wrapper functions
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { LlmProvider, LlmCapabilityRequirement, LlmProviderAdapter, LlmFileReference, GenerateInput, LlmTool, LlmUsageData, LlmResponse, LlmMcpServerTool, OrchestrateGenerateInput, OrchestrateStreamInput, OrchestrateUploadFileInput, OrchestrateFileInputGenerateInput, LlmAttachmentRef } from "./types";
import type { OpenAIConnectionConfig } from "./providers/openai";
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
  resolveMcpToolsForDeclaredIds,
} from "./registry";
import { selectSkillDeliveryAdapter } from "./tools/skill-delivery";
import type { SkillSelectionMode } from "./tools/skill-delivery";
import {
  injectExecutionCapability,
  stripSandboxExecutionTools,
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
};

export type SkillAwareDeterministicLlmExecutionInput = DeterministicLlmExecutionInput & {
  skillIds?: string[];
  /**
   * Skill-selection policy mode for the Anthropic container-skills delivery.
   * Absent ⇒ `"creation"` semantics (over-8 is a HARD
   * `AnthropicSkillCapError` — a fixed pre-synced allowlist is never silently
   * truncated). The general selectable path (llm-bridge) passes `"general"` to
   * engage deterministic rank-and-truncate-to-8 with visible `droppedSkillIds`
   * reporting. Ignored by OpenAI/Gemini delivery (no cap).
   */
  skillSelectionMode?: SkillSelectionMode;
  customSkillContent?: string;
  /**
   * Catalog id of the personal-delta skill whose body is `customSkillContent`
   * (S10 efficacy loop, cinatra#1368). When both are set, the delta is recorded
   * as a `"personal_inline"` exposure (NON-attributable — injected system-prompt
   * content has no per-skill invocation signal), giving the personal delta a
   * skill identity in the exposure telemetry it previously lacked. Content
   * without an id still delivers; it just cannot be attributed.
   */
  customSkillId?: string;
  skillLoader?: { load(input: { skillIds?: string[]; customSkillContent?: string }): Promise<unknown[]> };
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
 * S1 SCOPE — NOTHING from the plane reaches a provider. There is NO
 * per-provider translation yet (that is S2): an injected `sandbox_execution`
 * tool cannot be delivered to any provider — the OpenAI adapter would coerce an
 * unknown tool type into a malformed function tool, and the opaque session
 * carrier must never cross the provider boundary. To honor the design's "tool
 * and cue cannot diverge" invariant we withhold the cue and step-budget change
 * too: in S1 injection is VALIDATED (session minted + sealed, fail-closed /
 * unavailable paths exercised, structured warnings logged) but nothing reaches
 * the model. S2 replaces this function's body with real per-provider
 * translation and, at that point, delivers tool + cue + budget together — the
 * injection PRIMITIVE (`injectExecutionCapability`) already composes them as one
 * inseparable unit (unit-tested), so S2 cannot make them diverge.
 *
 * SECURITY — the returned `tools` are stripped of EVERY `sandbox_execution`
 * member UNCONDITIONALLY, on every status (injected, passthrough incl. the
 * flag-off default, and unavailable). This is the provider-boundary guarantee:
 * an opaque carrier — even one a caller (or a prompt-injected upstream) smuggled
 * into `input.tools` — can never reach a provider adapter. For every existing
 * caller (none construct a `sandbox_execution` tool) the strip is a structural
 * no-op, so the provider payload is unchanged.
 *
 * `unavailable` (`no_session` / `capability_unavailable`) is logged as a
 * structured, non-fatal warning — the model stays usable.
 */
function applyExecutionInjection(params: {
  entryPoint: string;
  tools: LlmTool[] | undefined;
  session: ExecutionSession | undefined;
  availability: ExecutionAvailability | undefined;
  streaming: boolean;
  requestedMaxSteps: number | undefined;
  outputSchema: unknown;
}): {
  tools: LlmTool[] | undefined;
  systemCue: string;
  maxSteps: number | undefined;
} {
  // Run injection for its VALIDATION + side effects (session mint/seal, the
  // fail-closed / unavailable classification). In S1 the result is not
  // delivered to the provider; only the warning below is observable.
  const result = injectExecutionCapability({
    tools: params.tools,
    session: params.session,
    availability: params.availability,
    task: {
      outputSchema: params.outputSchema,
      maxSteps: params.requestedMaxSteps,
    },
  });
  if (result.status === "unavailable") {
    // Structured, non-fatal: distinguishable kind (`no_session` vs
    // `capability_unavailable`) preserved in the log for operability. The model
    // keeps its (stripped) tools and runs without the sandbox capability.
    console.warn(
      `[execution-plane] ${params.entryPoint}: capability ${result.error.kind} — ` +
        "model continues without sandbox_execute",
    );
  }
  // UNCONDITIONAL provider-boundary strip (see the SECURITY note above): no
  // sandbox_execution tool or carrier ever crosses to a provider in S1,
  // regardless of the rollout flag or injection status.
  return {
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
  });
  // Execution-capability injection — exactly once, alongside (independent of)
  // MCP injection. Passthrough + byte-identical while the rollout flag is off.
  const exec = applyExecutionInjection({
    entryPoint: "runDeterministicLlmTask",
    tools,
    session: input.executionSession,
    availability: input.executionAvailability,
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

  if (input.skillIds && input.skillIds.length > 0) {
    // Provider-specific skill delivery is centralized in the
    // `SkillDeliveryAdapter` seam. OpenAI (native shell, no system cue) and
    // Gemini (inline into system prompt) behavior is byte-for-byte preserved
    // by `OpenAiShellSkillDelivery` / `GeminiInlineSkillDelivery`. Anthropic
    // is routed through `AnthropicContainerSkillDelivery` (container.skills,
    // never function tools).
    const delivery = selectSkillDeliveryAdapter(input.provider);
    const result = await delivery.deliver({
      skillIds: input.skillIds,
      // Absent ⇒ "creation" (hard cap). The general selectable path
      // (llm-bridge) passes "general" to engage deterministic
      // rank-and-truncate-to-8 with visible droppedSkillIds reporting.
      selectionMode: input.skillSelectionMode,
      // Attributable per-skill invocations (OpenAI shell reads) accrue here.
      onSkillRead: (id) => invokedSkillIds.add(id),
    });
    skillTools = result.tools;
    skillContext = result.systemContext;
    skillExposure.push(...result.exposure);
    // Set ONLY when the general path actually truncated.
    if (result.droppedSkillIds && result.selectionReason) {
      skillSelection = {
        droppedSkillIds: result.droppedSkillIds,
        selectionReason: result.selectionReason,
      };
    }
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
  })) ?? baseTools;

  // If personal skill content is provided, include it in context
  const personalContext = input.customSkillContent
    ? `\n\nCustom skill instructions:\n${input.customSkillContent}`
    : "";

  // Record the personal delta as a NON-attributable `personal_inline` exposure
  // when its identity is known (S10 efficacy loop). The delta is injected as
  // system-prompt content on every provider, so it has no per-skill invocation
  // signal — but it now carries a skill id in the exposure telemetry it
  // previously lacked. Content without an id still delivers, just unattributed.
  if (input.customSkillContent && input.customSkillId) {
    skillExposure.push({
      skillId: input.customSkillId,
      deliveryMode: "personal_inline",
      invocationAttributable: false,
    });
  }

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
    maxSteps: input.maxSteps ?? (allTools.length > 0 ? 6 : 1),
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
      skillLabel: input.skillIds?.length ? input.skillIds[0] : null,
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
    ...adapterInput
  } = input as OrchestrateGenerateInput & { resolvedAttachments?: unknown };
  // Explicit MCP injection.
  const tools = await injectMcpTools({
    provider: adapter.provider,
    tools: adapterInput.tools,
    declaredToolboxIds: adapterInput.declaredToolboxIds,
  });
  // Execution-capability injection — exactly once, independent of MCP.
  const exec = applyExecutionInjection({
    entryPoint: "generate",
    tools,
    session: input.executionSession,
    availability: input.executionAvailability,
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
  });
  // Execution-capability injection — exactly once, independent of MCP. Stream is
  // a multi-step tool loop already, so no step-budget widening (streaming:true).
  const exec = applyExecutionInjection({
    entryPoint: "stream",
    tools,
    session: input.executionSession,
    availability: input.executionAvailability,
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
    // Explicit caller preference (incl. a per-purpose Anthropic selection) is
    // honored verbatim — Anthropic IS a valid explicit per-purpose target.
    providers = input.preferredProviders;
  } else {
    // This is the SECOND implicit-global resolver (alongside registry.ts
    // `resolveFirstAvailableAdapter`). The IMPLICIT global default must never
    // resolve Anthropic. `readDefaultLlmProviderFromDatabase()` is already
    // sanitized to openai/gemini at the read path; the fallthrough list must
    // ALSO exclude Anthropic so an unavailable OpenAI cannot silently promote a
    // connected Anthropic to the resolved global runtime.
    const { readDefaultLlmProviderFromDatabase } = await import("@/lib/database");
    const dbDefault = readDefaultLlmProviderFromDatabase() as LlmProvider;
    const globalEligible: LlmProvider[] = ["openai", "gemini"];
    providers = [dbDefault, ...globalEligible.filter((p) => p !== dbDefault)];
  }

  for (const provider of providers) {
    const adapter = await resolveProviderAdapter(provider);
    if (adapter) {
      if (provider === "openai") {
        const { getConfiguredOpenAIConnection } = await import("./providers/openai");
        const connection = await getConfiguredOpenAIConnection(input?.openaiConnection);
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
