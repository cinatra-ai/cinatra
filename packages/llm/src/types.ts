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

export type LlmProvider = "openai" | "anthropic" | "gemini";

/**
 * The LLM capability an agent may pin via `metadata.cinatra.llm.capabilityRequired`.
 *
 * The authoritative vocabulary + the declared capability matrix live in
 * `@cinatra-ai/agents/llm-provider-policy` (`LLM_CAPABILITIES`). This is a
 * deliberate local mirror in the orchestration package: `@cinatra-ai/agents`
 * depends on `@cinatra-ai/llm`, so the orchestration layer MUST NOT import
 * from agents (that would invert the layering / create a cycle — the same
 * reason `LlmProvider` is duplicated here). The host reads the capability from
 * the OAS block and threads it DOWN into orchestration as data on
 * `GenerateInput.capabilityRequired`; the values are identical to
 * `LlmCapability`, so a host value is directly assignable.
 *
 * Consumed today by the Anthropic adapter's native_mcp fail-closed hardening
 * (llm-providers S1, #1712): under `"native_mcp"` the adapter refuses to
 * silently degrade its native MCP path to function-tool emulation.
 */
export type LlmCapabilityRequirement = "media_input" | "function_tools" | "native_mcp";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export type LlmToolParameterSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

export type LlmFunctionTool = {
  type?: "function";
  name: string;
  description: string;
  parameters: LlmToolParameterSchema;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

export type LlmShellSkill = {
  name: string;
  description: string;
  path: string;
};

export type LlmShellTool = {
  type: "shell";
  skills: LlmShellSkill[];
  /**
   * Execute shell commands in a sandboxed environment.
   * Called by the orchestration layer when the model requests shell execution.
   */
  execute: (action: {
    commands: string[];
    timeoutMs?: number | null;
    maxOutputLength?: number | null;
  }) => Promise<Array<{
    stdout: string;
    stderr: string;
    outcome: { type: "exit"; exitCode: number } | { type: "timeout" };
  }>>;
};

export type LlmMcpServerTool = {
  type: "mcp";
  /** Human-readable label for the MCP server. */
  serverLabel: string;
  /** URL of the MCP server (e.g. "https://example.com/api/mcp"). */
  serverUrl: string;
  /** Optional HTTP headers for authentication. */
  headers?: Record<string, string>;
  /** Optional OAuth access token. */
  authorization?: string;
  /** Optional description of the server's purpose. */
  serverDescription?: string;
  /** Optional list of allowed tool names, or null to allow all. */
  allowedTools?: string[] | null;
  /** Whether tools that mutate state require approval. */
  requireApproval?: "never" | "always" | "read-only";
};

export type LlmWebSearchTool = {
  type: "web_search";
};

/**
 * A reference to one or more pre-synced Anthropic Custom Skills, delivered via
 * the Anthropic API top-level `container` param (NOT as function tools).
 *
 * This is the ONLY way a skill reaches the Anthropic provider. `skillId` +
 * `version` are the Anthropic-side identifiers produced by the sync engine
 * (`POST /v1/skills` → `skill_id` + immutable epoch version). The Anthropic
 * provider translates this into
 * `container.skills[{ type: "custom", skill_id, version }]` + stacked betas +
 * the `code_execution_20250825` tool entry. Function-tool / shell skill
 * delivery for Anthropic is a hard-forbidden standing invariant.
 */
export type LlmContainerSkillsTool = {
  type: "container_skills";
  skills: Array<{
    /** Anthropic Custom Skill id (`skill_xxx`), from the sync engine. */
    skillId: string;
    /** Immutable epoch version string, or "latest". */
    version: string;
    /** Originating catalog skill id (for diagnostics / cue text). */
    catalogSkillId?: string;
  }>;
};

/**
 * Opaque, broker-verifiable sealed carrier for an execution session
 * (`{orgId,userId,surface,runId?}`). Produced by the trusted surface-layer
 * issuer (`sealExecutionSession`), embedded in the `sandbox_execution` tool the
 * injection layer adds, and STRIPPED before any provider-adapter call — the
 * adapters (S2) translate the tool contract to a provider-native shell / named
 * function tool and never receive the carrier. Only the broker can open it.
 * A plain string alias (not a branded type) so `types.ts` takes no runtime
 * dependency on the execution-plane module.
 */
export type SealedExecutionSessionCarrier = string;

/**
 * The distinct execution-plane tool (epic #1705 / S1 #1706). Deliberately NOT
 * the skill-delivery shell (`LlmShellTool`) — it is a separate union member so
 * it (a) survives Anthropic MCP-mode tool stripping (the injectMcpTools
 * function-tool strip only removes `type:"function"`), (b) is protected from
 * MCP dedup (its `type` is not `"mcp"`), and (c) is translated per-provider by
 * a dedicated path in S2 (OpenAI native `type:"shell"` with function-tool
 * fallback; Anthropic/Gemini named function tool). In S1 the provider adapters
 * do not yet translate it (they skip unrecognized tool types), so it only ever
 * reaches an adapter behind the default-off rollout flag; the injection layer
 * strips the carrier regardless.
 */
export type LlmSandboxExecutionTool = {
  type: "sandbox_execution";
  /**
   * The stable, provider-agnostic tool name the model calls. Fixed to
   * `"sandbox_execute"` by contract — the provider translation layer (S2) keys
   * native-shell-vs-function-tool dispatch on this name.
   */
  toolName: "sandbox_execute";
  /**
   * Opaque, broker-verifiable sealed session carrier. Bound to
   * `{orgId,userId,surface,runId?}`. Stripped before provider-adapter calls.
   */
  sessionCarrier: SealedExecutionSessionCarrier;
  /** Model-facing description of the capability (schema half of the contract). */
  description: string;
};

export type LlmTool =
  | LlmFunctionTool
  | LlmShellTool
  | LlmMcpServerTool
  | LlmWebSearchTool
  | LlmContainerSkillsTool
  | LlmSandboxExecutionTool;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

// Additive attachment contract. `content` stays a plain string (NOT a
// string|parts union — that would break every text-only caller); attachments
// ride alongside as optional artifact refs.
// LlmAttachmentRef mirrors @cinatra-ai/artifacts ArtifactRef structurally so
// llm takes no new cross-package dependency.
export type LlmAttachmentRef = {
  artifactId: string;
  representationRevisionId: string;
  digest: string;
  mime: string;
  originKind:
    | "upload"
    | "email_attachment"
    | "agent_generated"
    | "external_link"
    | "live_generator";
  title?: string;
  filename?: string;
  size?: number;
};

/**
 * A resolved, ingestible attachment ready for provider-native emission. Set
 * INTERNALLY by the orchestration entry points from resolveAttachments(); the
 * adapters consume it.
 * Structural (no import cycle): ResolvedAttachmentPart is assignable here.
 */
export type AdapterAttachmentPart = {
  nativeKind: string;
  /**
   * Provider-native file identifier, emitted VERBATIM by the adapter into
   * the provider request. Per-provider semantics the resolver port MUST
   * honor:
   *  - OpenAI    → Files API `file_id`        (→ input_file.file_id)
   *  - Anthropic → Files API `file_id`        (→ document.source.file_id)
   *  - Gemini    → the file `uri`             (→ fileData.fileUri)
   *               NOT the resource `name` (`files/<id>`) — emitting the
   *               name makes Gemini silently ignore the attachment.
   */
  providerFileId: string;
  mime: string;
};

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

export type LlmMessage = {
  role: "user" | "assistant";
  content: string;
  /** Optional artifact refs attached to THIS turn. */
  attachments?: LlmAttachmentRef[];
  /**
   * INTERNAL resolved ingestible parts for THIS turn (see
   * GenerateInput.resolvedAttachments). Set by the orchestration entry points
   * per-message; stream builders prefer a user message's own
   * resolvedAttachments over the request-level
   * input.resolvedAttachments (which stays as the last-user fallback so
   * single-turn callers and text-only behavior are unchanged).
   */
  resolvedAttachments?: AdapterAttachmentPart[];
};

// ---------------------------------------------------------------------------
// Tool call / result events
// ---------------------------------------------------------------------------

export type LlmToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Set for native MCP calls — identifies the MCP server (e.g. "external-apify-connector"). */
  serverLabel?: string;
};

export type LlmToolResult = {
  id: string;
  name: string;
  result: string;
  /** Set for native MCP calls — identifies the MCP server (e.g. "external-apify-connector"). */
  serverLabel?: string;
};

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export type LlmUsageData = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

/**
 * The transport a skill's instructions reached the model through. Each mode
 * differs in whether a per-skill INVOCATION signal is observable at our
 * boundary (S10 efficacy loop, cinatra#1368):
 *
 * - `"openai_shell"`      — native `type:"shell"` tool; the model reads a named
 *   `/skills/<slug>/SKILL.md`, so a read IS an attributable invocation signal.
 * - `"gemini_inline"`     — skill body inlined into the system prompt; no
 *   per-skill signal → NON-attributable.
 * - `"anthropic_container"` — pre-synced Custom Skills applied automatically
 *   inside the code-execution container; no per-skill read at our boundary →
 *   NON-attributable.
 * - `"personal_inline"`   — a personal-delta SKILL.md injected as
 *   system-prompt content (all providers); no per-skill signal → NON-attributable.
 */
export type SkillDeliveryMode =
  | "openai_shell"
  | "gemini_inline"
  | "anthropic_container"
  | "personal_inline";

/**
 * One skill made available to the model on a single LLM call, carrying its
 * catalog skill id (INCLUDING personal deltas), the delivery mode it reached
 * the model through, and whether that mode can attribute a per-skill
 * invocation. The efficacy loop records these as exposure events; a skill that
 * is only ever exposed via NON-attributable modes can never become a
 * deprecation candidate.
 */
export type SkillExposureEntry = {
  skillId: string;
  deliveryMode: SkillDeliveryMode;
  invocationAttributable: boolean;
};

export type LlmResponse = {
  text: string | null;
  status: string | null;
  incompleteReason: string | null;
  rawBody: string;
  usage?: LlmUsageData;
  model?: string; // Actual model name returned by the provider API
  /**
   * Set ONLY when the general selectable Anthropic path deterministically
   * rank-and-truncated an over-cap (>8) resolved skill set. Surfaces the
   * dropped catalog skill ids + reason so the truncation is visible (the
   * llm-bridge route returns it in its JSON response). Absent on every
   * non-truncating call (creation path, ≤8 skills, OpenAI, Gemini).
   */
  skillSelection?: {
    droppedSkillIds: string[];
    selectionReason: string;
  };
  /**
   * Every skill actually delivered to the model on this call, with its
   * delivery mode + invocation-attributability (S10 efficacy loop). Includes
   * the personal delta when one was injected. The llm-bridge records these as
   * exposure events keyed on the run. Absent when no skills were delivered.
   */
  skillExposure?: SkillExposureEntry[];
  /**
   * Catalog skill ids the model INVOKED on this call via an attributable mode
   * (today: OpenAI shell reads of a named `/skills/<slug>` file). Deduped,
   * stable order of first read. Empty/absent when nothing attributable was
   * invoked (or the only delivery modes were non-attributable). The bridge
   * increments the per-run invocation ledger for each id.
   */
  invokedSkillIds?: string[];
};

// ---------------------------------------------------------------------------
// Stream callbacks
// ---------------------------------------------------------------------------

export type LlmCitation = {
  /** Sequential 1-based index within the current assistant turn. */
  index: number;
  title: string;
  url: string;
};

export type LlmStreamCallbacks = {
  onTextDelta: (delta: string) => void;
  onToolCall: (call: LlmToolCall) => void;
  onToolResult: (result: LlmToolResult) => void;
  onStepStart: (step: number) => void;
  onStepEnd: (step: number) => void;
  onError: (error: Error) => void;
  /** Called once per step when the response contains URL citations (e.g. from web_search). */
  onCitations?: (citations: LlmCitation[]) => void;
};

// ---------------------------------------------------------------------------
// Generation inputs
// ---------------------------------------------------------------------------

export type GenerateInput = {
  model?: string;
  system: string;
  prompt: string;
  messages?: LlmMessage[]; // Prior conversation to prepend before `prompt` (resume support)
  tools?: LlmTool[];
  maxSteps?: number;
  maxTokens?: number;
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  logLabel?: string;
  skillLabel?: string | null;
  reasoningEffort?: "low" | "medium" | "high";
  /**
   * Optional list of toolbox ids the calling agent declared (from compiled
   * CompiledAgentOas.toolboxes). When undefined, MCP injection follows the
   * always-inject behavior (main chat). When defined, the registry filters MCP
   * tool injection to only the declared ids — "cinatra-mcp" maps to the Cinatra
   * self-MCP; any other id is looked up in external_mcp_servers.
   */
  declaredToolboxIds?: string[];
  /**
   * llm-providers S1 (#1712): the capability the dispatching agent pinned via
   * `metadata.cinatra.llm.capabilityRequired`, threaded down by the host so an
   * adapter can honour it at runtime. Absent ⇒ no capability gate (existing
   * behavior). Today only `"native_mcp"` is adapter-consumed — it disables the
   * Anthropic adapter's silent function-tool fallback when its native MCP path
   * fails (fail-closed; function-tool emulation is not native MCP).
   */
  capabilityRequired?: LlmCapabilityRequirement;
  /**
   * Optional artifact attachments for THIS generation. The orchestration layer
   * resolves each ref: ingestible → provider-native file part; non-ingestible
   * → appended to the structured not-readable manifest. Omitted ⇒
   * byte-for-byte text-only behavior.
   */
  attachments?: LlmAttachmentRef[];
  /**
   * INTERNAL: resolved ingestible parts the entry points set from
   * resolveAttachments(). Adapters emit these as native file parts. Absent ⇒
   * request body byte-identical to text-only behavior.
   */
  resolvedAttachments?: AdapterAttachmentPart[];
};

export type StreamInput = {
  model?: string;
  system: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  maxSteps?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  logLabel?: string;
  skillLabel?: string | null;
  reasoningEffort?: "low" | "medium" | "high";
  onUsageData?: (usage: LlmUsageData) => void;
  /**
   * Retained for callers that still pass it but defaults to the always-strip
   * behavior. Supports keeping client-side action tools alive alongside
   * MCP-injected tools.
   */
  preserveFunctionTools?: boolean;
  /**
   * Retained for callers that still pass it; defaults to the always-inject
   * behavior. Supports opting the LLM out of MCP tool injection so it can
   * dispatch through registered client-side actions.
   */
  skipMcpInjection?: boolean;
  /**
   * Optional list of toolbox ids the calling agent declared (from compiled
   * CompiledAgentOas.toolboxes). When undefined, MCP injection follows the
   * always-inject behavior (main chat). When defined, the registry filters MCP
   * tool injection to only the declared ids — "cinatra-mcp" maps to the Cinatra
   * self-MCP; any other id is looked up in external_mcp_servers.
   */
  declaredToolboxIds?: string[];
  /** Optional artifact attachments (see GenerateInput.attachments). Resolved
   *  by the orchestration layer. */
  attachments?: LlmAttachmentRef[];
  /** INTERNAL resolved ingestible parts (see GenerateInput.resolvedAttachments). */
  resolvedAttachments?: AdapterAttachmentPart[];
} & LlmStreamCallbacks;

export type FileInputGenerateInput = {
  model?: string;
  system: string;
  prompt: string;
  fileId: string;
  maxTokens?: number;
  outputSchema?: Record<string, unknown>;
  logLabel?: string;
  skillLabel?: string | null;
  reasoningEffort?: "low" | "medium" | "high";
};

// ---------------------------------------------------------------------------
// File handling
// ---------------------------------------------------------------------------

export type LlmFileReference = {
  /** Provider-specific file identifier (e.g. OpenAI file_id, Anthropic file_id). */
  id: string;
  /** Which provider owns this file reference. */
  provider: LlmProvider;
};

export type UploadFileInput = {
  /** Raw file content as a Buffer or Uint8Array. */
  content: Buffer | Uint8Array;
  /** Original filename (e.g. "transcript.txt"). */
  filename: string;
  /** MIME type (e.g. "text/plain", "application/pdf"). */
  mimeType: string;
  /** Purpose hint for the provider (e.g. "assistants", "user_data"). */
  purpose?: string;
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
// Batch API
// ---------------------------------------------------------------------------

/**
 * Single batch item.
 *
 * Mirrors a row of OpenAI's `/v1/chat/completions` batch input JSONL:
 * the orchestration layer assembles the `{ custom_id, method, url, body }`
 * envelope around `body` at submit time. The `body` field is the
 * provider-native chat-completion request payload (model, messages,
 * response_format, max_tokens, etc.).
 */
export type LlmBatchRequest = {
  /** Stable per-request identifier; max 64 chars; matches OpenAI custom_id. */
  customId: string;
  /** Provider-native request body (model, messages, response_format, max_tokens, etc.). */
  body: Record<string, unknown>;
};

export type LlmBatchSubmitInput = {
  requests: LlmBatchRequest[];
  /** Optional metadata tags (passed through to OpenAI batch.metadata). */
  metadata?: Record<string, string>;
};

/** OpenAI-canonical batch lifecycle states. Other providers normalize to these. */
export type LlmBatchStatus =
  | "validating"
  | "in_progress"
  | "finalizing"
  | "completed"
  | "failed"
  | "expired"
  | "cancelling"
  | "cancelled";

export type LlmBatchResult = {
  batchId: string;
  status: LlmBatchStatus;
  inputFileId: string;
  outputFileId: string | null;
  errorFileId: string | null;
  /** ISO timestamp; null until the batch reaches a terminal state. */
  completedAt: string | null;
  errorMessage: string | null;
};

export type LlmBatchSubmitResult = {
  batchId: string;
  inputFileId: string;
  status: LlmBatchStatus;
};

/** Single parsed line from a batch output file (JSONL). */
export type LlmBatchOutputLine = {
  customId: string;
  response: { status_code: number; body: Record<string, unknown> } | null;
  error: { code: string; message: string } | null;
};

// ---------------------------------------------------------------------------
// Provider adapter interface
// ---------------------------------------------------------------------------

export interface LlmProviderAdapter {
  readonly provider: LlmProvider;
  readonly defaultModel: string;

  generate(input: GenerateInput): Promise<LlmResponse>;

  stream(input: StreamInput): Promise<void>;

  generateWithFileInput?(input: FileInputGenerateInput): Promise<LlmResponse>;

  /** Upload a file to the provider. Returns a reference usable with generateWithFileInput(). */
  uploadFile?(input: UploadFileInput): Promise<LlmFileReference>;

  /** Delete an uploaded file from the provider. */
  deleteFile?(fileRef: LlmFileReference): Promise<void>;

  /** List available models from the provider. */
  listModels?(): Promise<string[]>;

  /**
   * Generate content from an audio/video file (e.g. transcription).
   * Provider-specific: currently only Gemini supports this natively.
   */
  generateFromMediaFile?(input: {
    model?: string;
    system: string;
    mediaFileUri: string;
    mimeType: string;
    logLabel?: string;
  }): Promise<LlmResponse>;

  /**
   * Generate an image from a text prompt.
   * Provider-specific: currently only Gemini supports this natively.
   */
  generateImage?(input: {
    model?: string;
    prompt: string;
    logLabel?: string;
  }): Promise<{ imageData: string; mimeType: string } | null>;

  /** Submit a batch of requests for asynchronous processing. */
  submitBatch?(input: LlmBatchSubmitInput): Promise<LlmBatchSubmitResult>;

  /** Retrieve current status of a submitted batch. */
  retrieveBatch?(batchId: string): Promise<LlmBatchResult>;

  /** Download parsed JSONL results for a completed batch. */
  downloadBatchResults?(fileId: string): Promise<LlmBatchOutputLine[]>;

  /** Cancel an in-progress batch. */
  cancelBatch?(batchId: string): Promise<{ batchId: string; status: LlmBatchStatus }>;
}

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
