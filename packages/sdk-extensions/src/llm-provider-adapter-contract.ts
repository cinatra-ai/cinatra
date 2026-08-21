// Canonical LLM PROVIDER ADAPTER contract — the full ABI type closure a
// connector needs to implement `LlmProviderAdapter` (llm-providers S4.0 —
// cinatra#1715 PR-0, epic #1711).
//
// This file is the CANONICAL home for `LlmProviderAdapter` and EXACTLY the
// neutral request-assembly / delivery floor its interface structurally
// requires — the transitive type closure of the adapter interface and nothing
// more. It lives in `@cinatra-ai/sdk-extensions` (a TRUE LEAF: its
// only import is the type-only re-export of the S1 canonical `LlmProvider`
// vocabulary from `./llm-provider-contract`; every type here is
// provider-agnostic and pure) so an LLM connector
// extension can `import type { LlmProviderAdapter }` from the SDK alone and
// build a compliant adapter, exactly the border the epic ratifies (the runtime
// DISPATCH-ADAPTER channel; see `LlmProviderAdapterSurface` /
// `LLM_PROVIDER_ADAPTER_CAPABILITY` in `host-connector-services-contract.ts`).
//
// `packages/llm/src/types.ts` RE-EXPORTS every name below so core keeps
// compiling byte-for-byte unchanged (zero behavior change). Host-coupled and
// orchestration-layer types (ActorContext-bearing Orchestrate* inputs,
// SandboxExecutor / SandboxEnvironmentMount / SealedExecutionSessionCarrier,
// LlmAttachmentManifest, LlmConnectionConfig/Status) are NOT part of the
// adapter interface's structural requirement and deliberately STAY in
// `packages/llm` — extracting them would drag core internals into this leaf.
//
// RELOCATION-ONLY: the definitions below are moved VERBATIM from
// `packages/llm/src/types.ts`; no shape changed.
//
// The provider vocabulary `LlmProvider` is NOT redefined here: it is the
// existing S1 canonical (`./llm-provider-contract`, the drift-guarded public
// mirror of the host policy vocabulary). This module re-exports it (type-only,
// erased) so the adapter closure has exactly ONE canonical `LlmProvider`.
import type { LlmProvider } from "./llm-provider-contract";
export type { LlmProvider };

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
 * `GenerateInput.capabilityRequired` / `StreamInput.capabilityRequired`; the
 * values are identical to `LlmCapability`, so a host value is directly
 * assignable.
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
  /**
   * Catalog-resolved skill snapshot descriptors (exec-plane S2, cinatra#1707).
   * Set by the skill-delivery layer so the execution-plane injection can stage
   * these skills read-only under `/skills/<slug>` inside the sandbox when the
   * request is execution-authorized (the merged single-native-shell case).
   * File CONTENT is resolved lazily (`resolveFiles`) at stage time — never
   * inlined into the request. Absent on caller-constructed shell tools ⇒ no
   * staging (the restricted skill-read function tool still serves reads).
   */
  stagedSkills?: SandboxStagedSkill[];
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
  /**
   * Approval vocabulary (llm-providers S2, #1713 AC2):
   *   - "auto_execute"      — tool calls run without a human approval step.
   *                           An ABSENT value means exactly this (the ratified
   *                           `undefined` ⇒ `auto_execute` default).
   *   - "approval_required" — every tool call needs an approval step,
   *                           translated per the provider's declared `approval`
   *                           capability: OpenAI serializes it natively
   *                           (`require_approval: "always"`); a provider whose
   *                           declared capability is "unsupported" (Anthropic
   *                           today) REFUSES the toolbox fail-closed — approval
   *                           intent is never silently dropped.
   * Replaces the retired three-value `requireApproval` ("never" | "always" |
   * "read-only") that only OpenAI consumed and Anthropic silently ignored.
   */
  approval?: "auto_execute" | "approval_required";
  /**
   * MCP wire transport this server speaks (llm-providers S2, #1713):
   *   - "streamable-http" — the modern MCP Streamable HTTP transport.
   *   - "sse"             — the legacy HTTP+SSE transport.
   *   - "unknown"         — not classified (legacy rows / omitted).
   * Optional: an absent value is treated as `"unknown"` by the injection
   * layer, which never infers transport from `serverUrl`. The adapter-facing
   * refusal (transports a provider's declared capability does not accept) is
   * wired in the post-#1707 adapter half.
   */
  transport?: "streamable-http" | "sse" | "unknown";
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

/** One immutable file of a staged skill snapshot (relative to /skills/<slug>). */
export type SandboxStagedSkillFile = {
  /** Path relative to the skill's staging root, e.g. "SKILL.md". */
  path: string;
  /** Full file content (UTF-8). */
  content: string;
  /** Lowercase hex sha256 of `content` — the staging layer re-verifies it. */
  digest: string;
};

/**
 * A catalog-resolved skill snapshot to stage as an immutable, read-only input
 * under the virtual `/skills/<slug>` path inside the sandbox (exec-plane S2,
 * cinatra#1707). Content digests, no host mounts: file content is resolved
 * lazily app-side and handed to the staging layer as data.
 */
export type SandboxStagedSkill = {
  /** Catalog skill id (attribution + exposure). */
  skillId: string;
  /** Slug — the staged directory name under /skills/. */
  slug: string;
  /** Model-facing description (rides the shell declaration / tool schema). */
  description: string;
  /** Resolve the snapshot files (content + sha256), lazily at stage time. */
  resolveFiles: () => Promise<SandboxStagedSkillFile[]>;
  /**
   * S10 efficacy loop: fired (best-effort) with the catalog skill id when a
   * sandbox command references this skill's staged path — the attributable
   * invocation signal for sandbox-side reads.
   */
  onRead?: (skillId: string) => void;
};

/** Model-requested action shape for a sandbox execution call. */
export type SandboxExecuteAction = {
  commands: string[];
  timeoutMs?: number | null;
  maxOutputLength?: number | null;
};

/** Per-command result shape (mirrors the shell-tool output contract). */
export type SandboxExecuteOutput = {
  stdout: string;
  stderr: string;
  outcome: { type: "exit"; exitCode: number } | { type: "timeout" };
  /**
   * Set by the executor when the EXECUTION PLANE refused before any command
   * ran on a sandbox — the job could not be opened, or the broker refused this
   * command (quota, liveness, egress). Refusals are returned STRUCTURED rather
   * than thrown (the model must stay usable), so without this marker a refusal
   * is indistinguishable from a real non-zero exit at every layer above the
   * executor.
   *
   * It exists for the surface provenance guard (cinatra#2175): "the executor
   * resolved" is NOT "something ran", and a turn whose only dispatch was
   * refused has no execution to back a claim of having run code. Absent means
   * the command reached a sandbox; only the executor sets it.
   */
  refusedByPlane?: true;
};
/**
 * The distinct execution-plane tool (epic #1705 / S1 #1706 / S2 #1707).
 * Deliberately NOT the skill-delivery shell (`LlmShellTool`) — it is a
 * separate union member so it (a) survives Anthropic MCP-mode tool stripping
 * (the injectMcpTools function-tool strip only removes `type:"function"`),
 * (b) is protected from MCP dedup (its `type` is not `"mcp"`), and (c) is
 * translated per-provider by a dedicated path (S2): OpenAI renders it as the
 * SINGLE native `type:"shell"` entry for shell-capable models (with skills
 * staged read-only under /skills/<slug> when present) or as a named function
 * tool for models that reject the native shell; Anthropic and Gemini render a
 * named function tool. Model calls dispatch back to `execute`, whose closure
 * holds the sealed session carrier — the carrier itself never crosses the
 * provider boundary.
 */
export type LlmSandboxExecutionTool = {
  type: "sandbox_execution";
  /**
   * The stable, provider-agnostic tool name the model calls. Fixed to
   * `"sandbox_execute"` by contract — the provider translation layer keys
   * native-shell-vs-function-tool dispatch on this name.
   */
  toolName: "sandbox_execute";
  /** Model-facing description of the capability (schema half of the contract). */
  description: string;
  /**
   * Staged skill snapshots bound into this execution session (the merged
   * skills+execution case). Listed on the OpenAI native shell declaration;
   * content resolved lazily by the executor at stage time.
   */
  stagedSkills?: SandboxStagedSkill[];
  /** Run the model-requested commands on the execution plane (broker-bound). */
  execute: (action: SandboxExecuteAction) => Promise<SandboxExecuteOutput[]>;
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
  /**
   * cinatra#2776: the capability the dispatching surface pins for THIS stream,
   * mirroring `GenerateInput.capabilityRequired` field-for-field so an adapter
   * reads one field on both entry points.
   *
   * The chat and widget runtimes set `"native_mcp"` whenever they hand the
   * adapter the Cinatra self-MCP toolbox: the self-MCP catalog must reach the
   * model as ONE provider-hosted MCP reference and never as inline function
   * schemas, so a connector configured for function-tools emulation must REFUSE
   * the stream (fail-closed, before any credential-bearing egress) rather than
   * flatten the catalog. Absent ⇒ no capability gate (existing behavior);
   * `"function_tools"` is the explicit opt-in a caller declares when function
   * tools are what it actually wants.
   */
  capabilityRequired?: LlmCapabilityRequirement;
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
// Batch API — v2 (provider-NEUTRAL, ADDITIVE, VERSIONED) — cinatra#2396
//
// WHY A SECOND SURFACE RATHER THAN A RESHAPE. Everything above this comment is
// SHIPPED ABI and is OpenAI-canonical by construction: `LlmBatchRequest.body`
// is a native `/v1/chat/completions` payload, `LlmBatchStatus` is OpenAI's own
// eight-value lifecycle, results are addressed by FILE id, and
// `LlmBatchOutputLine` carries a `response.body.choices` envelope. Anthropic's
// Message Batches API is structurally different in every one of those axes —
// requests are submitted INLINE (no input file), results are retrieved by BATCH
// id (no output/error file ids), the batch lifecycle is
// `in_progress|canceling|ended`, and each request carries its OWN terminal
// outcome (`succeeded|errored|canceled|expired`). Reshaping the v1 types in
// place would break the shipped OpenAI adapter's ABI, so v2 is a SEPARATE,
// OPTIONAL, EXPLICITLY VERSIONED member (`LlmProviderAdapter.batchV2`) and the
// v1 methods stay byte-for-byte as they are.
//
// SKEW, both directions, is a consequence of that placement rather than a
// runtime negotiation:
//   - NEW core / OLD connector — `adapter.batchV2` is simply absent, so core
//     falls back to the v1 path (or raises `BatchNotSupportedError`);
//   - OLD core / NEW connector — an old core never reads `batchV2`, and the
//     connector's v1 methods are untouched, so its behavior is unchanged.
// The OUTER `LLM_PROVIDER_ADAPTER_ABI_VERSION` deliberately stays at 1: this
// discriminator is NESTED inside the adapter object. Bumping the outer surface
// version would make an old host REFUSE the whole connector (fail-closed) long
// before it could ignore an unknown optional member.
//
// SANITIZATION BOUNDARY. `LlmBatchV2Request.outputSchema` reaches the adapter
// ALREADY SANITIZED for the target provider by the core→adapter seam
// (`sanitizeOutputSchemaForProvider`, cinatra#2339/#2343). The adapter owns
// native BODY CONSTRUCTION only; no sanitizer policy moves into a connector and
// nothing downstream re-sanitizes.
// ---------------------------------------------------------------------------

/**
 * The v2 batch-surface version discriminator. A host probes for the EXACT
 * value; an unrecognised version is treated as "no v2 surface" (fail-closed to
 * the v1 path), never as a newer surface it may guess at.
 *
 * A connector should write `version: 2 as const` rather than value-importing
 * this constant: under old-host/new-connector skew the host-resolved
 * `@cinatra-ai/sdk-extensions` may predate this file, and a runtime value
 * import would fail to resolve. Type-only imports stay safe (they erase).
 */
export const LLM_BATCH_V2_VERSION = 2 as const;

/**
 * A single conversational turn in a batch request.
 *
 * DELIBERATELY NARROWER than {@link LlmMessage}: no `attachments` and no
 * `resolvedAttachments`. Those carry provider-native FILE identifiers, and
 * "no file ids" is the whole point of the v2 surface — a neutral descriptor
 * must be submittable to any provider without a prior per-provider upload.
 * Attachment-bearing batch requests are out of scope for v2 and must go through
 * the synchronous path.
 */
export type LlmBatchV2Message = {
  role: "user" | "assistant";
  content: string;
};

/**
 * Provider-NEUTRAL per-request descriptor. Carries intent, never a native body:
 * the adapter constructs its own provider-native request from these fields.
 */
export type LlmBatchV2Request = {
  /**
   * Stable per-request identifier, unique within the batch. Both providers cap
   * it at 64 characters and both return results UNORDERED, so this is the only
   * legitimate way to correlate an outcome back to its request.
   */
  customId: string;
  /** Absent ⇒ the adapter's own `defaultModel`. */
  model?: string;
  /** System instructions for this request. */
  system?: string;
  /** The conversation. MUST contain at least one message. */
  messages: LlmBatchV2Message[];
  /** Output-token ceiling. Adapters supply a provider-appropriate default. */
  maxTokens?: number;
  /** Sampling temperature, when the caller wants to pin it. */
  temperature?: number;
  /**
   * JSON Schema for structured output — ALREADY SANITIZED for the target
   * provider by the core seam. The adapter emits it VERBATIM into its native
   * structured-output slot and MUST NOT re-sanitize (see the boundary note
   * above).
   */
  outputSchema?: Record<string, unknown>;
};

export type LlmBatchV2SubmitInput = {
  requests: LlmBatchV2Request[];
  /**
   * BEST-EFFORT tags. OpenAI has a native `batch.metadata` slot; Anthropic's
   * Message Batches API has none and the adapter drops them. Callers must not
   * depend on metadata surviving the round trip — persist anything you need to
   * read back on your own side, keyed by `batchId`.
   */
  metadata?: Record<string, string>;
};

/**
 * NEUTRAL batch lifecycle — four values, not OpenAI's eight.
 *
 *  - `"in_progress"` — accepted and processing (OpenAI `validating`,
 *    `in_progress`, `finalizing`; Anthropic `in_progress`).
 *  - `"canceling"`   — cancellation initiated, processing not yet ended
 *    (OpenAI `cancelling`; Anthropic `canceling`).
 *  - `"ended"`       — processing ended and per-request outcomes ARE
 *    retrievable (OpenAI `completed` / `expired` / `cancelled`; Anthropic
 *    `ended`). Per-request expiry/cancellation surfaces on the OUTCOME, not
 *    here — a batch can end with a mix of all four outcome kinds.
 *  - `"failed"`      — the BATCH itself failed before per-request outcomes
 *    existed (OpenAI `failed`). Anthropic never emits it. Kept distinct from
 *    `"ended"` precisely so a consumer never has to read `errorMessage` to
 *    discover whether `download()` is meaningful.
 */
export type LlmBatchV2Status = "in_progress" | "canceling" | "ended" | "failed";

/** Per-outcome tallies. The five buckets always sum to `total`. */
export type LlmBatchV2Counts = {
  total: number;
  processing: number;
  succeeded: number;
  errored: number;
  canceled: number;
  expired: number;
};

export type LlmBatchV2State = {
  batchId: string;
  status: LlmBatchV2Status;
  /**
   * `null` when the underlying surface does not report counts at all — today
   * only the LEGACY v1 bridge, whose `LlmBatchResult` carries none. Never
   * synthesized as zeros: a batch always has at least one request, so
   * `total: 0` would be a factual lie about a live batch.
   */
  counts: LlmBatchV2Counts | null;
  /** ISO 8601; `null` until processing ends. */
  endedAt: string | null;
  /** ISO 8601 processing-expiry deadline when the provider states one. */
  expiresAt: string | null;
  /** Batch-level failure detail. `null` unless something failed at batch level. */
  errorMessage: string | null;
};

export type LlmBatchV2SubmitResult = {
  batchId: string;
  status: LlmBatchV2Status;
};

/**
 * STABLE normalized per-request error vocabulary. Provider-specific detail is
 * carried SEPARATELY on {@link LlmBatchV2Error} so a consumer can branch on a
 * code that never changes shape while still logging the vendor's own words.
 * `"unknown"` is the honest catch-all — a code is never guessed.
 */
export type LlmBatchV2ErrorCode =
  | "invalid_request"
  | "authentication"
  | "permission"
  | "not_found"
  | "rate_limit"
  | "request_too_large"
  | "overloaded"
  | "timeout"
  | "billing"
  | "provider_error"
  | "unknown";

export type LlmBatchV2Error = {
  code: LlmBatchV2ErrorCode;
  message: string;
  /** The provider's OWN error identifier, verbatim ("invalid_request_error", …). */
  providerCode: string | null;
  /** HTTP status when the provider reported one; `null` otherwise. */
  providerStatus: number | null;
};

/**
 * One request's terminal outcome. A FLAT discriminated union on `status` so a
 * consumer narrows directly and `customId` is reachable on every branch.
 *
 * `download()` returns BOTH streams: an adapter whose provider splits success
 * and failure across separate transports (OpenAI's output file + error file) is
 * responsible for merging them here.
 */
export type LlmBatchV2Outcome =
  | {
      customId: string;
      status: "succeeded";
      /** Concatenated assistant text, or `null` when the model emitted none. */
      text: string | null;
      /** The model that actually answered, when the provider reports it. */
      model: string | null;
      usage?: LlmUsageData;
      /** Provider stop/finish reason, verbatim; `null` when unreported. */
      stopReason: string | null;
      /** Provider-native per-request payload, JSON-stringified (parity with `LlmResponse.rawBody`). */
      rawBody: string;
    }
  | {
      customId: string;
      status: "errored";
      error: LlmBatchV2Error;
      /** Native error payload, JSON-stringified; `null` when the provider sent none. */
      rawBody: string | null;
    }
  | { customId: string; status: "canceled" }
  | { customId: string; status: "expired" };

/**
 * The additive, versioned batch surface. Present ⇒ core prefers it over every
 * v1 method; absent ⇒ core falls back to the v1 path.
 */
export type LlmBatchV2Surface = {
  /** EXACT discriminator. Anything else is treated as "no v2 surface". */
  readonly version: typeof LLM_BATCH_V2_VERSION;
  /** Submit neutral descriptors. Adapters own native body construction. */
  submit(input: LlmBatchV2SubmitInput): Promise<LlmBatchV2SubmitResult>;
  /** Neutral lifecycle state + counts. */
  retrieve(batchId: string): Promise<LlmBatchV2State>;
  /**
   * Normalized per-request outcomes, addressed by BATCH id — never a file id.
   * Implementations MUST raise a recognisable "results not ready" error rather
   * than returning `[]` while the batch is still `in_progress` / `canceling`;
   * an empty array is otherwise indistinguishable from "every row is gone".
   */
  download(batchId: string): Promise<LlmBatchV2Outcome[]>;
  /** OPTIONAL — a provider without native cancellation simply omits it. */
  cancel?(batchId: string): Promise<LlmBatchV2State>;
};

// ---------------------------------------------------------------------------
// Image generation (cinatra#2641)
// ---------------------------------------------------------------------------

/**
 * What an image invocation CONSUMED, in the unit an image provider bills in.
 *
 * A PER-IMAGE unit, deliberately, not a per-token one. Every image provider the
 * ABI has met states a price per produced image — Google publishes the token
 * arithmetic for `gemini-2.5-flash-image` and then states the answer as
 * "$0.039 per image" — so an image count is the number both the provider and an
 * operator recognise, and it survives a provider that never mentions tokens at
 * all. Reusing {@link LlmUsageData} would have forced every image adapter to
 * translate its bill into tokens, which is a conversion the ABI cannot check.
 *
 * OPTIONAL AND ADDITIVE. An adapter that omits it behaves exactly as before:
 * the metering seam books the call as COUNTED and UNPRICED (`cost_usd` NULL,
 * the dashboard's own unknown-cost surface). Reporting it is what lets the
 * subscriber price the row from a per-image rate card. Nothing breaks when it
 * is absent, and no adapter has to change to keep working.
 */
export type LlmImageUsage = {
  /**
   * How many images this invocation produced and was billed for. A positive
   * integer. It is NOT always 1: a provider asked for several candidates bills
   * for each one, and reporting only the image that was RETURNED would
   * under-price that call.
   *
   * The seam validates it (a positive safe integer) and ignores anything else,
   * so a malformed report costs the ledger its price, never a wrong price.
   */
  images: number;
  /**
   * Prompt tokens this invocation was billed for, when the provider charges the
   * REQUEST as well as the images.
   *
   * An image bill is not always only images. Google charges Gemini 2.5 Flash
   * Image both per produced image AND per million input tokens, so a price
   * built from the image count alone is a PARTIAL total — the exact shape that
   * renders like a complete one and understates real spend. An adapter whose
   * provider bills the prompt reports it here; one whose provider does not
   * simply omits it.
   *
   * The rate card decides whether it is REQUIRED: an entry that declares an
   * input rate cannot be priced without this number, and the row stays unpriced
   * rather than being priced short.
   */
  inputTokens?: number;
};

/**
 * What `generateImage` answers with.
 *
 * `imageData` + `mimeType` are the shipped shape and are unchanged. `model` and
 * `usage` are OPTIONAL ADDITIONS (cinatra#2641): before them the answer carried
 * no way to say WHICH model produced the image or WHAT it cost, so the metering
 * seam could only count the call.
 */
export type LlmImageResponse = {
  /** Base64 image payload. */
  imageData: string;
  /** MIME type of {@link imageData}. */
  mimeType: string;
  /**
   * The model the adapter ADDRESSED for this image — which is not necessarily
   * the one the caller named, because an image adapter routinely substitutes an
   * image model of its own when the caller names none.
   *
   * REQUIRED FOR PRICING, and the reason it is a separate field rather than an
   * inference: the ledger looks a rate up by model, and the caller's requested
   * name is not evidence of which model was addressed. The seam therefore prices
   * what the ADAPTER attested here; a `usage` reported without a `model` leaves
   * the row counted and unpriced.
   */
  model?: string;
  /** Per-image usage. Absent ⇒ the row is counted and left unpriced. */
  usage?: LlmImageUsage;
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
   *
   * The answer MAY carry `model` + `usage` (cinatra#2641) so the call can be
   * priced per image; an adapter that returns only `{ imageData, mimeType }`
   * keeps working and its rows stay counted-but-unpriced. `null` means no image
   * came back — it is still a resolved invocation and the seam still counts it.
   */
  generateImage?(input: {
    model?: string;
    prompt: string;
    logLabel?: string;
  }): Promise<LlmImageResponse | null>;

  /** Submit a batch of requests for asynchronous processing. */
  submitBatch?(input: LlmBatchSubmitInput): Promise<LlmBatchSubmitResult>;

  /** Retrieve current status of a submitted batch. */
  retrieveBatch?(batchId: string): Promise<LlmBatchResult>;

  /** Download parsed JSONL results for a completed batch. */
  downloadBatchResults?(fileId: string): Promise<LlmBatchOutputLine[]>;

  /** Cancel an in-progress batch. */
  cancelBatch?(batchId: string): Promise<{ batchId: string; status: LlmBatchStatus }>;

  /**
   * The ADDITIVE provider-neutral batch surface (cinatra#2396). Absent ⇒ core
   * uses the v1 methods above. Never a replacement for them: the two coexist
   * on a migrated adapter so the shipped v1 ABI keeps working untouched.
   */
  readonly batchV2?: LlmBatchV2Surface;
}

// ---------------------------------------------------------------------------
// SKILL-DELIVERY adapter closure (llm-providers S4.x — cinatra#1964).
//
// A DISTINCT core-orchestration seam from the request-translation
// `LlmProviderAdapter` above: `selectSkillDeliveryAdapter(provider)` builds the
// provider's `skillTools` + system-prompt fragment BEFORE `adapter.generate` is
// called (the orchestration layer merges them into the request). The two never
// share a method — the request-translation adapter only translates the shell
// tools this seam already produced.
//
// These interface types are relocated VERBATIM from
// `packages/llm/src/tools/skill-delivery.ts` (no shape change) so a connector
// can `import type { SkillDeliveryAdapter, SkillDeliveryFloor }` from the SDK
// leaf and implement a compliant adapter — exactly as `LlmProviderAdapter`
// above was relocated for the request-translation channel (S4.0). Core
// re-exports them from `tools/skill-delivery.ts` so it keeps compiling
// byte-for-byte (zero behavior change). Their transitive closure
// (`LlmTool` / `SkillExposureEntry`) already lives in this leaf.
//
// The registration SURFACE (`LlmSkillDeliveryAdapterSurface` +
// `LLM_SKILL_DELIVERY_ADAPTER_CAPABILITY`) lives in
// `host-connector-services-contract.ts`, the same channel class as
// `LlmProviderAdapterSurface`.

/**
 * Skill-selection policy mode.
 *
 * - `"creation"` (and the **default when unset**): the pinned agent-creation
 *   path. A fixed, pre-synced per-agent allowlist (2-3 skills). Over Anthropic's
 *   hard 8-skill/request cap is a HARD fail — a fixed allowlist must NEVER be
 *   silently truncated. Absence selects this mode.
 * - `"general"`: the broad selectable Anthropic path (any non-creation agent
 *   whose admin selected Anthropic; the recommendation agent may dynamically
 *   resolve MORE than 8). Over-cap ⇒ DETERMINISTIC rank-and-truncate-to-8 with
 *   visible (non-silent) `droppedSkillIds` reporting.
 */
export type SkillSelectionMode = "general" | "creation";

/**
 * What a provider's skill delivery contributes to an LLM call: extra tools to
 * merge into the request, plus an optional system-prompt fragment.
 */
export type SkillDeliveryResult = {
  /** Tools to merge into the request (shell for OpenAI, container_skills for Anthropic, none for Gemini). */
  tools: LlmTool[];
  /** System-prompt fragment (inline skill content for Gemini, an availability cue for Anthropic, "" for OpenAI). */
  systemContext: string;
  /**
   * Set ONLY when the general selectable Anthropic path
   * deterministically truncated an over-cap (>8) resolved skill set. Lists the
   * catalog skill ids that were dropped (deterministic, stable order) plus a
   * human-readable reason. Absent on every non-truncating call (creation path,
   * ≤8, OpenAI, Gemini) — surfaces the drop so it is never silent.
   */
  droppedSkillIds?: string[];
  /** Human + machine readable explanation of the truncation. */
  selectionReason?: string;
  /**
   * Every skill this adapter actually delivered to the model, with its mode +
   * invocation-attributability (S10 efficacy loop, cinatra#1368). Excludes
   * skills the adapter dropped (unmountable for OpenAI, empty-body for Gemini,
   * over-cap truncated for the general Anthropic path) — a dropped skill was
   * never exposed. Never includes the personal delta (injected separately by
   * the orchestration layer, which owns that skill's identity).
   */
  exposure: SkillExposureEntry[];
};

export interface SkillDeliveryAdapter {
  readonly provider: LlmProvider;
  deliver(input: {
    skillIds: string[];
    /** Absent ⇒ `"creation"` (hard cap). */
    selectionMode?: SkillSelectionMode;
    /**
     * Invoked once per attributable per-skill invocation observed DURING the
     * subsequent LLM call (OpenAI shell reads of a named `/skills/<slug>`
     * file). Non-attributable adapters (Gemini, Anthropic) never call it.
     */
    onSkillRead?: (skillId: string) => void;
  }): Promise<SkillDeliveryResult>;
}

/**
 * The provider-NEUTRAL skill-delivery floor, supplied by CORE to a connector's
 * skill-delivery adapter through the registration surface's factory (the
 * core-owned dependency-injection seam — llm-providers S4.x AC2). These three
 * primitives (+ `@cinatra-ai/skills`) STAY in core as the generic delivery
 * floor #1715 AC2 keeps; a relocated connector adapter consumes them through
 * this seam instead of importing core (which would invert the extension
 * border). ZERO `@cinatra-ai/skills` relocation.
 *
 * The signatures mirror the core exports byte-for-byte:
 *  - `buildSkillTools`      (OpenAI shell delivery),
 *  - `readSkillContent`     (Gemini inline delivery),
 *  - `resolveSkillSummaries`(Anthropic availability cue).
 */
export type SkillDeliveryFloor = {
  buildSkillTools(input: {
    skillIds?: string[];
    onMounted?: (mountedSkillIds: string[]) => void;
    onSkillRead?: (skillId: string) => void;
  }): Promise<LlmTool[]>;
  readSkillContent(skillId: string): Promise<string | null>;
  resolveSkillSummaries(
    skillIds: string[],
  ): Promise<Array<{ id: string; name: string; description: string }>>;
};
