// The assistant runtime config/ports module (cinatra-ai/cinatra#1037 P2a).
//
// P1 landed the PACKAGING half of the interaction axis: `agent_kind`
// (`assistant|executor`) + the typed `assistant_config` SIDECAR shape
// (`src/lib/assistant-config.ts`: persona, skillBundle, allowedTools,
// allowedAgents, modelPrefs). This module is the RUNTIME half's contract: it
// turns a persisted `AssistantConfig` into the concrete `AssistantRuntimeConfig`
// the extracted conversational runtime (`./runtime.ts`) consumes in place of the
// former hardcoded `CHAT_*` module constants in `src/app/api/chat/runner.ts`.
//
// It NEVER redefines the sidecar shape — it CONSUMES `AssistantConfig` from
// `src/lib/assistant-config.ts` (the single source of truth). It only derives
// runtime-shaped fields the sidecar deliberately does not carry (the skill-id
// namespace, the fully-qualified skill ids, the tool-round ceiling) and passes
// the sidecar's own fields (allow-lists, model prefs, persona) straight through.
//
// Pure, framework-free (no "server-only", no DB, no LLM import) so it is
// importable from the runtime, the store layer, and unit tests alike — exactly
// like the `assistant-config.ts` companion it builds on.

import type { AssistantConfig, ModelPrefs } from "@/lib/assistant-config";

// ---------------------------------------------------------------------------
// Runtime defaults (were module constants in the pre-extraction runner)
// ---------------------------------------------------------------------------

/**
 * The tool-round ceiling for a single conversational turn. Was `MAX_TOOL_ROUNDS`
 * in the runner (raised 16 → 24 for the three-tier discovery + OAS authoring
 * pipeline). It is a RUNTIME concern, not a per-assistant sidecar field, so it
 * defaults here and is overridable per runtime-config build.
 */
export const DEFAULT_MAX_TOOL_ROUNDS = 24;

/**
 * The skill-id namespace that qualifies a sidecar `skillBundle` slug into the
 * auth-policy-boundary skill id the skills layer + `buildSkillTools` key on.
 * The Cinatra assistant's chat sub-skills live under `@cinatra-ai/chat:` — was
 * the literal prefix in the runner's `CHAT_SKILL_IDS` / `CHAT_SYSTEM_SKILL_ID`.
 * Kept a runtime-build parameter (not a sidecar field) so a different assistant
 * package can carry its own namespace without touching the persisted config.
 */
export const DEFAULT_SKILL_ID_NAMESPACE = "@cinatra-ai/chat";

// ---------------------------------------------------------------------------
// AssistantRuntimeConfig — the runtime's consumed shape
// ---------------------------------------------------------------------------

/**
 * The fully-resolved input the conversational runtime (`runAssistantTurn`)
 * reads instead of the former hardcoded runner constants. Every field maps 1:1
 * to a former constant or to an `AssistantConfig` field:
 *
 *   skillIds        ← `skillBundle` mapped through `skillIdNamespace`   (was CHAT_SKILL_IDS)
 *   systemSkillId   ← skillIds[0] (the always-loaded system skill)      (was CHAT_SYSTEM_SKILL_ID)
 *   fallbackPersona ← `persona` (identity used only when the system      (was the inline 3-line
 *                     skill body is unresolvable from catalog + disk)     fallback array)
 *   allowedTools    ← `allowedTools` (empty = platform-policy only)
 *   allowedAgents   ← `allowedAgents` (empty = platform-policy only)
 *   modelPrefs      ← `modelPrefs`  (empty = platform default resolution)
 *   maxToolRounds   ← DEFAULT_MAX_TOOL_ROUNDS                            (was MAX_TOOL_ROUNDS)
 */
export type AssistantRuntimeConfig = {
  /** The namespace prefix used to qualify each `skillBundle` slug. */
  skillIdNamespace: string;
  /** Fully-qualified skill ids (`<namespace>:<slug>`) mounted every turn. */
  skillIds: string[];
  /** The always-loaded system skill id (skillIds[0]); its SKILL.md body is the
   *  live system prompt. */
  systemSkillId: string;
  /** Identity text used ONLY when the system skill body is unresolvable from
   *  both the catalog and disk (replaces the runner's inline fallback). */
  fallbackPersona: string;
  /** Tool ids this assistant may call. Empty = no restriction beyond platform
   *  policy (the runtime applies NO filter — byte-parity with the legacy chat). */
  allowedTools: string[];
  /** Agent package names this assistant may dispatch to. Empty = policy only. */
  allowedAgents: string[];
  /** Model routing preferences. Empty = platform default adapter resolution. */
  modelPrefs: ModelPrefs;
  /** Per-turn tool-round ceiling (maxSteps). */
  maxToolRounds: number;
};

export type BuildRuntimeConfigOptions = {
  /** Override the skill-id namespace (defaults to `@cinatra-ai/chat`). */
  skillIdNamespace?: string;
  /** Override the tool-round ceiling (defaults to DEFAULT_MAX_TOOL_ROUNDS). */
  maxToolRounds?: number;
};

/**
 * Build the runtime config from a persisted (already validated) assistant
 * sidecar. `skillBundle[0]` is by contract the system skill — the assistant is
 * defined by the identity in `persona` and the skills it always mounts, the
 * first of which supplies the live system prompt. An empty `skillBundle` is a
 * misconfiguration (the sidecar schema requires the field but permits an empty
 * array), so we fail loud rather than emit a runtime with no system skill.
 */
export function buildAssistantRuntimeConfig(
  config: AssistantConfig,
  opts: BuildRuntimeConfigOptions = {},
): AssistantRuntimeConfig {
  const skillIdNamespace = opts.skillIdNamespace ?? DEFAULT_SKILL_ID_NAMESPACE;
  if (config.skillBundle.length === 0) {
    throw new Error(
      "assistant runtime requires a non-empty skillBundle (skillBundle[0] is the always-loaded system skill)",
    );
  }
  const skillIds = config.skillBundle.map((slug) => `${skillIdNamespace}:${slug}`);
  return {
    skillIdNamespace,
    skillIds,
    systemSkillId: skillIds[0],
    fallbackPersona: config.persona,
    allowedTools: config.allowedTools,
    allowedAgents: config.allowedAgents,
    modelPrefs: config.modelPrefs,
    maxToolRounds: opts.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS,
  };
}

/**
 * Whether a tool name is permitted by an allow-list. An EMPTY allow-list means
 * "no explicit restriction beyond platform policy" (the sidecar contract), so
 * every tool is allowed — this is what keeps the Cinatra reference assistant
 * (empty allow-lists) byte-identical to the pre-extraction chat. A non-empty
 * list restricts to its members. Exposed as a pure predicate so the runtime and
 * its parity tests share one definition.
 */
export function isAllowedByList(name: string, allowList: string[]): boolean {
  return allowList.length === 0 || allowList.includes(name);
}
