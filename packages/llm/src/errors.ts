/**
 * Orchestration-layer error classes.
 *
 * Error shape mirrors PrimitiveInvocationError / EmailOutreachError:
 * extends Error, attaches a domain `code` for callers, and carries
 * provider-identifying context.
 */
import type { LlmProvider } from "./types";

/**
 * Thrown by the four orchestrate-* batch dispatchers when the requested
 * provider does not support the OpenAI Batch API surface (today: anthropic
 * and gemini). Throwing — rather than returning null — is intentional: it
 * forces callers to handle the gap explicitly so a future swap to a
 * supporting provider is observable.
 */
export class BatchNotSupportedError extends Error {
  readonly code = "batch_not_supported" as const;
  readonly provider: LlmProvider;

  constructor(provider: LlmProvider) {
    super(`Batch API is not supported by provider "${provider}"`);
    this.name = "BatchNotSupportedError";
    this.provider = provider;
  }
}

// ---------------------------------------------------------------------------
// Anthropic skill-delivery errors.
//
// Standing invariant: skills reach Anthropic ONLY via `container.skills`.
// Every failure mode below is a fail-loud CONFIGURATION error — never a silent
// function-tool fallback. Callers already convert adapter throws into SSE
// `error` events / HTTP 5xx, so a deterministic message naming the offending
// skill id surfaces cleanly to operators.
// ---------------------------------------------------------------------------

export abstract class AnthropicSkillDeliveryError extends Error {
  abstract readonly code: string;
  readonly provider = "anthropic" as const;
}

/**
 * A catalog skill referenced by an Anthropic request has no pre-synced
 * Anthropic Custom Skill because the sync engine has not uploaded it, or
 * governance excludes it. Fail loud — do NOT fall back to a function tool.
 */
export class AnthropicSkillNotSyncedError extends AnthropicSkillDeliveryError {
  readonly code = "anthropic_skill_not_synced" as const;
  readonly catalogSkillIds: string[];

  constructor(catalogSkillIds: string[]) {
    super(
      `Anthropic skill delivery requires pre-synced Custom Skills, but these ` +
        `catalog skill(s) have no Anthropic sync mapping yet: ` +
        `${catalogSkillIds.join(", ")}. Enable and run the Anthropic skill ` +
        `sync before using these skills with the Anthropic provider.`,
    );
    this.name = "AnthropicSkillNotSyncedError";
    this.catalogSkillIds = catalogSkillIds;
  }
}

/**
 * More than Anthropic's hard per-request maximum of 8 Custom Skills were
 * mapped for a single request. This is a defensive fail-loud guard; general
 * rank-and-truncate selection is handled by the request construction path.
 */
export class AnthropicSkillCapError extends AnthropicSkillDeliveryError {
  readonly code = "anthropic_skill_cap_exceeded" as const;
  readonly count: number;

  constructor(count: number, catalogSkillIds: string[]) {
    super(
      `Anthropic allows at most 8 Custom Skills per request, but ${count} ` +
        `were mapped: ${catalogSkillIds.join(", ")}. Reduce the per-agent ` +
        `skill set or configure rank-and-truncate selection before using ` +
        `these skills with the Anthropic provider.`,
    );
    this.name = "AnthropicSkillCapError";
    this.count = count;
  }
}

/**
 * A function-tool / shell / read_skill skill tool reached the Anthropic
 * provider. This is structurally forbidden: the Anthropic function-tool skill
 * path is a hard standing invariant that must never be used for skill
 * delivery. Thrown at the provider boundary so EVERY caller (orchestration
 * arms, chat runner, agent-stream, llm-bridge) is covered, regardless of who
 * constructed the tool.
 */
export class AnthropicFunctionToolSkillError extends AnthropicSkillDeliveryError {
  readonly code = "anthropic_function_tool_skill_forbidden" as const;

  constructor(detail: string) {
    super(
      `Anthropic skill delivery via function tools / shell / read_skill is a ` +
        `forbidden standing invariant. Skills must reach Anthropic only via ` +
        `container.skills (LlmContainerSkillsTool). Offending tool: ${detail}.`,
    );
    this.name = "AnthropicFunctionToolSkillError";
  }
}

/**
 * llm-providers S1 (#1712) — native_mcp fail-closed hardening.
 *
 * Thrown when a request carries `capabilityRequired: "native_mcp"` and the
 * Anthropic adapter's native MCP path (`client.beta.messages.create` with
 * `mcp_servers`) fails at runtime (e.g. the account has not enabled the MCP
 * client beta). WITHOUT a native_mcp requirement the adapter silently degrades
 * to the function-tools path; WITH it, that degradation would violate the
 * declared capability contract (function-tool emulation does NOT satisfy
 * native_mcp — the MCP Injection Rule), so the request fails closed instead.
 * Callers convert adapter throws into SSE `error` events / HTTP 5xx.
 */
export class NativeMcpCapabilityRequiredError extends Error {
  readonly code = "native_mcp_capability_required" as const;
  readonly provider: LlmProvider;
  /** The underlying native-path failure, when one triggered the fail-closed. */
  readonly cause?: unknown;

  constructor(provider: LlmProvider, cause?: unknown) {
    super(
      `The request requires the "native_mcp" LLM capability, but provider ` +
        `"${provider}" could not complete its native MCP path` +
        (cause instanceof Error ? `: ${cause.message}` : "") +
        `. Falling back to function-tool emulation would not satisfy ` +
        `native_mcp (function tools are not native MCP), so the request fails ` +
        `closed. Enable the provider's native MCP support or remove the ` +
        `native_mcp capability requirement.`,
    );
    this.name = "NativeMcpCapabilityRequiredError";
    this.provider = provider;
    this.cause = cause;
  }
}

/**
 * llm-providers S2 (#1713, AC2) — an MCP server toolbox declares
 * `approval: "approval_required"`, but the target provider cannot honour an
 * approval step (its declared `approval` capability is "unsupported" —
 * Anthropic today: neither its native `mcp_servers` serialization nor its
 * function-tools emulation carries any approval knob). Silently executing an
 * approval-intending toolbox would auto-run tool calls the operator required
 * approval for, so the request fails closed BEFORE any provider/credential
 * request is issued. Callers convert adapter throws into SSE `error` events /
 * HTTP 5xx.
 */
export class McpApprovalUnsupportedError extends Error {
  readonly code = "mcp_approval_unsupported" as const;
  readonly provider: LlmProvider;
  /** The server labels that declared `approval_required`. */
  readonly serverLabels: string[];

  constructor(provider: LlmProvider, serverLabels: string[]) {
    super(
      `MCP server${serverLabels.length === 1 ? "" : "s"} ` +
        `${serverLabels.map((l) => `"${l}"`).join(", ")} require` +
        `${serverLabels.length === 1 ? "s" : ""} tool-call approval ` +
        `(approval: "approval_required"), but provider "${provider}" cannot ` +
        `honour an approval step (declared approval capability: unsupported). ` +
        `Auto-executing an approval-intending toolbox would drop the approval ` +
        `silently, so the request fails closed. Route the toolbox to a ` +
        `provider that supports approvals, or set approval to "auto_execute".`,
    );
    this.name = "McpApprovalUnsupportedError";
    this.provider = provider;
    this.serverLabels = serverLabels;
  }
}

/**
 * A catalog skill exceeds Anthropic's 30MB Custom Skills upload limit, OR a
 * single request's resolved skill set exceeds the per-request
 * `container.skills` cap of 8. Surfaced as a CONFIGURATION error by the
 * pre-enqueue preflight — never a mid-run partial failure after partial
 * writes. The message names the EXACT offending skill + its size (size case)
 * or the count + cap (per-request case).
 */
export class AnthropicSkillPreflightError extends AnthropicSkillDeliveryError {
  readonly code = "anthropic_skill_preflight_failed" as const;
  readonly kind: "size" | "request_cap";
  /** The offending catalog skill id (size case) or the over-cap set (request_cap case). */
  readonly offendingSkillIds: string[];
  /** Byte size of the offending skill (size case only). */
  readonly byteSize?: number;

  constructor(input: {
    kind: "size" | "request_cap";
    offendingSkillIds: string[];
    byteSize?: number;
    message: string;
  }) {
    super(input.message);
    this.name = "AnthropicSkillPreflightError";
    this.kind = input.kind;
    this.offendingSkillIds = input.offendingSkillIds;
    this.byteSize = input.byteSize;
  }
}

// ---------------------------------------------------------------------------
// Cross-realm STRUCTURAL discriminators (llm-providers #1715 — D1).
//
// Once the host resolves a CONNECTOR-registered provider adapter (epic #1711),
// the adapter that throws these sentinels is a SEPARATE module realm. A
// connector-inlined copy of these error classes therefore has a DIFFERENT
// constructor identity, so `err instanceof <CoreClass>` silently returns false
// and a fail-LOUD configuration sentinel is swallowed to a warning (e.g. the
// `dispatchLlmReviewer` rethrow in agent-creation-review.ts).
//
// The fix: discriminate STRUCTURALLY on the stable `code` (+ `provider`) fields
// that EVERY faithful copy of these classes carries — never on constructor
// identity. Both the in-core class and a faithful connector-side copy satisfy
// these predicates; an unrelated error does not. The core classes above keep
// carrying these exact `code`/`provider` values (that is the contract these
// predicates read), and any faithful connector-side copy MUST preserve them
// verbatim (see the #1715 stage-2 handback).
// ---------------------------------------------------------------------------

/**
 * The `code` value of every concrete `AnthropicSkillDeliveryError` subclass.
 * The abstract base carries no single code (its `code` is abstract), so the
 * skill-delivery family is recognized by membership in this set. Adding a new
 * subclass REQUIRES adding its code here (guarded by the discriminator contract
 * test) so the structural check stays exhaustive across realms.
 */
export const ANTHROPIC_SKILL_DELIVERY_ERROR_CODES = [
  "anthropic_skill_not_synced",
  "anthropic_skill_cap_exceeded",
  "anthropic_function_tool_skill_forbidden",
  "anthropic_skill_preflight_failed",
] as const;

function readStringField(err: unknown, field: "code" | "provider"): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const value = (err as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * Structural recognizer for the Anthropic skill-delivery sentinel family
 * (NotSynced / Cap / FunctionTool / Preflight) that survives a module-realm
 * boundary. Matches any object carrying a known skill-delivery `code` and
 * `provider === "anthropic"` — the exact shape the core classes above expose
 * and a faithful connector copy preserves. Replaces the realm-fragile
 * `err instanceof AnthropicSkillDeliveryError`.
 */
export function isAnthropicSkillDeliveryError(err: unknown): err is AnthropicSkillDeliveryError {
  const code = readStringField(err, "code");
  return (
    code !== undefined &&
    (ANTHROPIC_SKILL_DELIVERY_ERROR_CODES as readonly string[]).includes(code) &&
    readStringField(err, "provider") === "anthropic"
  );
}

/** Cross-realm recognizer for `BatchNotSupportedError` (unique stable `code`). */
export function isBatchNotSupportedError(err: unknown): err is BatchNotSupportedError {
  return readStringField(err, "code") === "batch_not_supported";
}

/** Cross-realm recognizer for `NativeMcpCapabilityRequiredError`. */
export function isNativeMcpCapabilityRequiredError(err: unknown): err is NativeMcpCapabilityRequiredError {
  return readStringField(err, "code") === "native_mcp_capability_required";
}

/** Cross-realm recognizer for `McpApprovalUnsupportedError`. */
export function isMcpApprovalUnsupportedError(err: unknown): err is McpApprovalUnsupportedError {
  return readStringField(err, "code") === "mcp_approval_unsupported";
}
