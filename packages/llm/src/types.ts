/**
 * Unified LLM orchestration types.
 *
 * These types define the provider-agnostic API surface for all LLM interactions
 * in the application. Each provider adapter translates these types to its
 * SDK-native format.
 */

import type { ActorContext } from "@/lib/authz/actor-context";
// Type-only (erased; no runtime cycle) so the orchestrate-entry inputs can
// carry the app-injected resolver ports WITHOUT llm importing
// @/lib (ports come from the caller).
import type { AttachmentResolverPorts } from "./attachments/resolve-attachments";
// Type-only (erased; the runtime module ./execution-plane imports value types
// from THIS file, so a value import would cycle — a type import does not).
import type { ExecutionSession, ExecutionAvailability } from "./execution-plane";

// ---------------------------------------------------------------------------
// Provider ADAPTER contract closure — relocated to the sdk-extensions ABI
// LEAF (llm-providers S4.0, cinatra#1715 PR-0). `LlmProviderAdapter` and the
// exact neutral request-assembly / delivery floor its interface structurally
// requires now live canonically in
// `@cinatra-ai/sdk-extensions/llm-provider-adapter-contract` so an LLM
// connector extension can `import type { LlmProviderAdapter }` and build one.
// These are RE-EXPORTED here (type-only, erased) so every existing
// `packages/llm` consumer of `./types` / `@cinatra-ai/llm` keeps compiling
// byte-for-byte unchanged — zero behavior change. Host-coupled +
// orchestration-layer types (below) deliberately STAY in this module.
// ---------------------------------------------------------------------------
import type {
  LlmProvider,
  LlmCapabilityRequirement,
  LlmToolParameterSchema,
  LlmFunctionTool,
  LlmShellSkill,
  LlmShellTool,
  LlmMcpServerTool,
  LlmWebSearchTool,
  LlmContainerSkillsTool,
  SandboxStagedSkillFile,
  SandboxStagedSkill,
  SandboxExecuteAction,
  SandboxExecuteOutput,
  LlmSandboxExecutionTool,
  LlmTool,
  LlmAttachmentRef,
  AdapterAttachmentPart,
  LlmMessage,
  LlmToolCall,
  LlmToolResult,
  LlmUsageData,
  SkillDeliveryMode,
  SkillExposureEntry,
  LlmResponse,
  LlmCitation,
  LlmStreamCallbacks,
  GenerateInput,
  StreamInput,
  FileInputGenerateInput,
  LlmFileReference,
  UploadFileInput,
  LlmBatchRequest,
  LlmBatchSubmitInput,
  LlmBatchStatus,
  LlmBatchResult,
  LlmBatchSubmitResult,
  LlmBatchOutputLine,
  LlmProviderAdapter,
} from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";

export type {
  LlmProvider,
  LlmCapabilityRequirement,
  LlmToolParameterSchema,
  LlmFunctionTool,
  LlmShellSkill,
  LlmShellTool,
  LlmMcpServerTool,
  LlmWebSearchTool,
  LlmContainerSkillsTool,
  SandboxStagedSkillFile,
  SandboxStagedSkill,
  SandboxExecuteAction,
  SandboxExecuteOutput,
  LlmSandboxExecutionTool,
  LlmTool,
  LlmAttachmentRef,
  AdapterAttachmentPart,
  LlmMessage,
  LlmToolCall,
  LlmToolResult,
  LlmUsageData,
  SkillDeliveryMode,
  SkillExposureEntry,
  LlmResponse,
  LlmCitation,
  LlmStreamCallbacks,
  GenerateInput,
  StreamInput,
  FileInputGenerateInput,
  LlmFileReference,
  UploadFileInput,
  LlmBatchRequest,
  LlmBatchSubmitInput,
  LlmBatchStatus,
  LlmBatchResult,
  LlmBatchSubmitResult,
  LlmBatchOutputLine,
  LlmProviderAdapter,
};

/**
 * Opaque, broker-verifiable sealed carrier for an execution session
 * (`{orgId,userId,surface,runId?}`). Produced by the trusted surface-layer
 * issuer (`sealExecutionSession`). Since S2 (#1707) it is captured in the
 * `sandbox_execution` tool's `execute` CLOSURE at build time — it is not a
 * field on the tool, so it cannot cross the provider boundary by construction.
 * Only the broker can open it. A plain string alias (not a branded type) so
 * `types.ts` takes no runtime dependency on the execution-plane module.
 */
export type SealedExecutionSessionCarrier = string;

/**
 * The resolved L1 declared-environment layer an execution session mounts for
 * every command on its job (exec-plane S3, cinatra#1708; epic #1705). Produced
 * by the app-layer service that resolves a run's DECLARED environment (packaged
 * agent manifest / project-agent config) into a verified, content-addressed
 * layer, then threaded through the injection contract into the broker — which
 * re-verifies the signed provenance fail-closed BEFORE every mount and runs the
 * sandbox over the SIGNED digest.
 *
 * OPAQUE to packages/llm: llm neither reads nor validates it (the broker/worker
 * own verification), so it is threaded through untouched and `provenance` is
 * `unknown` here — llm takes NO dependency on the execution-plane module,
 * exactly as `SealedExecutionSessionCarrier` is a plain string alias. The
 * broker-backed executor binding re-narrows it to the execution-plane
 * `ResolvedEnvironmentMount` at the package seam. Absent ⇒ commands run over
 * the L0 base (byte-identical S1/S2 dispatch).
 */
export type SandboxEnvironmentMount = {
  /** Content-addressed display / registry-pull alias (never the run target). */
  imageRef: string;
  /** Signed per-layer provenance — opaque here; re-verified worker-side. */
  provenance: unknown;
};

/**
 * The executor binding the app wiring supplies to the injection layer
 * (exec-plane S2, cinatra#1707): everything between a model tool call and the
 * broker. It receives the sealed carrier (from the tool's closure — the only
 * place it still exists), the commands, and the staged skill snapshots, and
 * returns per-command outputs. `@cinatra-ai/execution-plane` provides the
 * broker-backed implementation; tests bind fakes. packages/llm deliberately
 * has NO import of the broker (layering: execution-plane depends on llm).
 */
export type SandboxExecutor = (input: {
  sessionCarrier: SealedExecutionSessionCarrier;
  commands: string[];
  timeoutMs?: number | null;
  maxOutputLength?: number | null;
  stagedSkills?: SandboxStagedSkill[];
  /**
   * The run's resolved L1 declared environment (exec-plane S3, cinatra#1708).
   * Threaded through to `broker.openJob({ environment })` so the job mounts the
   * declared layer; the broker re-verifies its signed provenance before every
   * mount. Absent ⇒ the L0 base (byte-identical S1/S2 dispatch).
   */
  environment?: SandboxEnvironmentMount;
}) => Promise<SandboxExecuteOutput[]>;

/**
 * Structured "attached, but not directly readable" manifest. Non-ingestible
 * attachments are NOT silently dropped — the orchestration layer hands the
 * model this structured block so it knows a file exists and why it cannot read
 * it (anti-hallucination). NOT UI copy.
 */
export type LlmAttachmentManifest = {
  attachedButNotReadable: Array<{
    ref: LlmAttachmentRef;
    title?: string;
    size?: number;
    reason: string;
  }>;
};

// ---------------------------------------------------------------------------
// Connection config
// ---------------------------------------------------------------------------

export type LlmConnectionConfig = {
  provider: LlmProvider;
  apiKey: string;
  defaultModel?: string;
  /** Provider-specific administration (e.g. organizationId, projectId for OpenAI). */
  providerConfig?: Record<string, unknown>;
};

export type LlmConnectionStatus = {
  provider: LlmProvider;
  connected: boolean;
  defaultModel: string | null;
  availableModels: string[];
};

// ---------------------------------------------------------------------------
// Orchestration-level inputs (include provider selection)
// ---------------------------------------------------------------------------

// `resolvedAttachments` is INTERNAL — set by the entry point from
// resolveAttachments(), NEVER by a caller. Omit it from the public orchestrate
// inputs so it can't be smuggled into the adapter past the resolver (bypassing
// stale-cache self-heal + provider validation).
export type OrchestrateGenerateInput = Omit<GenerateInput, "resolvedAttachments"> & {
  provider?: LlmProvider;
  /**
   * When provided AND no outer ALS frame is active, generate wraps
   * its body in withActorContext so downstream MCP / BullMQ / A2A consumers
   * can read the originating actor.
   */
  actorContext?: ActorContext;
  /**
   * App-injected resolver ports (cache + provider upload). Supplied by the
   * bridge/chat caller so the orchestration layer never imports @/lib. Omitted
   * ⇒ attachments (if any) are NOT resolved and the request stays
   * byte-identical to text-only behavior.
   */
  attachmentResolverPorts?: AttachmentResolverPorts;
  /**
   * Execution plane (exec-plane S1, cinatra#1706). A pre-minted execution
   * session bound to `{orgId,userId,surface,runId?}`, supplied by the assistant
   * runtime (chat surface). Omitted ⇒ no attributable caller ⇒ the capability
   * is withheld (fail-closed). Only consulted when the rollout flag is on.
   */
  executionSession?: ExecutionSession;
  /** Execution plane: D4 per-org/per-agent availability posture (default `"enabled"`). */
  executionAvailability?: ExecutionAvailability;
  /**
   * Execution plane (exec-plane S2, cinatra#1707): the broker-backed executor
   * binding. Supplied by the app wiring layer; absent ⇒ the plane cannot run
   * commands, so the capability is withheld (`capability_unavailable`,
   * fail-closed) even when the rollout flag is on.
   */
  executionExecutor?: SandboxExecutor;
  /**
   * Execution plane (exec-plane S3, cinatra#1708): the run's resolved L1
   * declared-environment mount, supplied by the app wiring layer after it
   * resolves the run's declared environment into a verified layer. Absent ⇒
   * commands run over the L0 base (byte-identical S1/S2 dispatch).
   */
  executionEnvironment?: SandboxEnvironmentMount;
};

// Same INTERNAL invariant as OrchestrateGenerateInput, AND also Omit
// `resolvedAttachments` at the per-message level: a caller cannot put
// `resolvedAttachments` on messages[i] to bypass per-message resolution +
// cache revalidation.
export type OrchestrateStreamInput = Omit<
  StreamInput,
  "resolvedAttachments" | "messages"
> & {
  messages: Omit<LlmMessage, "resolvedAttachments">[];
  provider?: LlmProvider;
  /**
   * See OrchestrateGenerateInput.actorContext.
   */
  actorContext?: ActorContext;
  /** See OrchestrateGenerateInput.attachmentResolverPorts. */
  attachmentResolverPorts?: AttachmentResolverPorts;
  /** Execution plane (exec-plane S1): see OrchestrateGenerateInput.executionSession. */
  executionSession?: ExecutionSession;
  /** Execution plane: D4 per-org/per-agent availability posture (default `"enabled"`). */
  executionAvailability?: ExecutionAvailability;
  /** Execution plane (S2): see OrchestrateGenerateInput.executionExecutor. */
  executionExecutor?: SandboxExecutor;
  /** Execution plane (S3): see OrchestrateGenerateInput.executionEnvironment. */
  executionEnvironment?: SandboxEnvironmentMount;
};

export type OrchestrateFileInputGenerateInput = FileInputGenerateInput & {
  provider?: LlmProvider;
};

export type OrchestrateUploadFileInput = UploadFileInput & {
  provider?: LlmProvider;
};

export type OrchestrateDeleteFileInput = {
  fileRef: LlmFileReference;
  provider?: LlmProvider;
};
