/**
 * `resolveAgentCreationDispatch` + dispatch sentinels.
 *
 * Activates the agent-creation provider/model pin plumbing:
 * `isAgentCreationPinActive`, `readAgentCreationLlmProviderFromDatabase`,
 * and `readAgentCreationModelFromDatabase` in `src/lib/database.ts`.
 *
 * Standing invariants honoured:
 *   1. INACTIVE pin -> byte-for-byte openai/gpt-5 default behavior.
 *   2. ACTIVE pin -> admin-configured provider/model. Anthropic ALWAYS routes
 *      via the skill-aware path (SkillDeliveryAdapter container.skills) - never
 *      function tools. The dispatch site also refuses to fire when provider
 *      === "anthropic" AND skillIds is empty, because the Anthropic provider
 *      falls back to function-tools when `container.skills` is empty AND
 *      native MCP fails (`anthropic.ts:466`). The hard preflight is the FIRST
 *      gate; this is the belt-and-suspenders.
 *
 * IMPORTANT: this module uses a dynamic-import for `@/lib/database` to keep
 * `packages/agents` free of host-app static imports - the same pattern as
 * `loadReviewerPrompt`'s dynamic-import of `@cinatra-ai/skills`.
 */

import "server-only";

// ---------------------------------------------------------------------------
// Sentinel error classes
// ---------------------------------------------------------------------------

export type AgentCreationPinConfigErrorCode =
  | "pin_active_but_unset"      // pin active but provider OR model is null/empty
  | "invalid_provider_config";  // provider stored as a value outside {"openai","anthropic","gemini"}

export class AgentCreationPinConfigError extends Error {
  readonly code: AgentCreationPinConfigErrorCode;
  constructor(message: string, code: AgentCreationPinConfigErrorCode) {
    super(message);
    this.name = "AgentCreationPinConfigError";
    this.code = code;
  }
}

export type AgentCreationDispatchAbortCode =
  | "anthropic_empty_skill_ids"; // pin anthropic + skillIds.length === 0 reached the dispatch site

export class AgentCreationDispatchAbortError extends Error {
  readonly code: AgentCreationDispatchAbortCode;
  constructor(code: AgentCreationDispatchAbortCode, message?: string) {
    super(message ?? `Agent-creation dispatch aborted (${code})`);
    this.name = "AgentCreationDispatchAbortError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export type ResolvedAgentCreationDispatch = {
  provider: "openai" | "anthropic" | "gemini";
  model: string;
  /** True => caller routes via `runSkillAwareDeterministicLlmTask`. */
  useSkillAware: boolean;
};

const VALID_PROVIDERS: ReadonlySet<string> = new Set(["openai", "anthropic", "gemini"]);

/**
 * Resolve the agent-creation LLM dispatch parameters.
 *
 *   - When `isAgentCreationPinActive()` returns false, returns openai/gpt-5
 *     with `useSkillAware` mirroring the caller hint, preserving the default
 *     hardcoded behavior.
 *
 *   - When ACTIVE, reads `agent_creation_llm_provider` +
 *     `agent_creation_model`. Returns those values; for Anthropic,
 *     `useSkillAware` is always true so methodology arrives via the
 *     SkillDeliveryAdapter seam (container.skills, never function tools).
 *
 *   - Throws `AgentCreationPinConfigError` when the pin is active but the
 *     provider/model is unset or the stored provider isn't one of the three
 *     supported values.
 */
// Cache the dynamic-import promise once so concurrent lane dispatches share
// the same module instance instead of each paying the cold-start cost. This
// preserves the parallel reviewer-lane invariant.
let cachedDatabaseModule: Promise<typeof import("@/lib/database")> | undefined;
function getDatabaseModule(): Promise<typeof import("@/lib/database")> {
  if (!cachedDatabaseModule) {
    cachedDatabaseModule = import("@/lib/database");
  }
  return cachedDatabaseModule;
}

export async function resolveAgentCreationDispatch(input: {
  hasSkillIds: boolean;
}): Promise<ResolvedAgentCreationDispatch> {
  const {
    isAgentCreationPinActive,
    readAgentCreationLlmProviderFromDatabase,
    readAgentCreationModelFromDatabase,
  } = await getDatabaseModule();

  if (!isAgentCreationPinActive()) {
    // INACTIVE - byte-for-byte default. Matches the hardcoded
    // `provider:"openai", model:"gpt-5"` literal.
    return {
      provider: "openai",
      model: "gpt-5",
      useSkillAware: input.hasSkillIds,
    };
  }

  const providerRaw = readAgentCreationLlmProviderFromDatabase();
  const model = readAgentCreationModelFromDatabase();

  if (!providerRaw || !model) {
    throw new AgentCreationPinConfigError(
      `Agent-creation pin active but configuration is incomplete (provider=${JSON.stringify(providerRaw)}, model=${JSON.stringify(model)}). Configure agent_creation_llm_provider and agent_creation_model in the admin LLM UI.`,
      "pin_active_but_unset",
    );
  }
  if (!VALID_PROVIDERS.has(providerRaw)) {
    throw new AgentCreationPinConfigError(
      `Invalid agent_creation_llm_provider value: "${providerRaw}". Must be one of openai, anthropic, gemini.`,
      "invalid_provider_config",
    );
  }
  const provider = providerRaw as "openai" | "anthropic" | "gemini";

  // Anthropic ALWAYS uses the skill-aware path. Even when `hasSkillIds` is
  // false here, routing to skill-aware ensures the SkillDeliveryAdapter seam is
  // consulted; the preflight and dispatch-site guard
  // (`AgentCreationDispatchAbortError`) together ensure skillIds.length > 0 at
  // the adapter boundary so `container.skills` is populated and the Anthropic
  // provider's function-tool fallback at `anthropic.ts:466` is unreachable.
  const useSkillAware = provider === "anthropic" ? true : input.hasSkillIds;

  return { provider, model, useSkillAware };
}
