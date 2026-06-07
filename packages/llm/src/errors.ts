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
