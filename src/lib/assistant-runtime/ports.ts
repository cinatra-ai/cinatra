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


// ---------------------------------------------------------------------------
// STRUCTURED ASSISTANT-RUNTIME ERROR CLASSIFICATION (cinatra#2390, epic #2385
// S5 — "classified runtime recovery").
//
// THE PROBLEM. Assistant-stream failures forwarded RAW error messages, and
// skill delivery can throw BEFORE the stream handler even runs — so a
// misconfigured first turn (skills not yet synced after setup's Continue, a
// `function-tools` MCP-mode remnant) had no classified, actionable surface.
//
// THE SHAPE. One pure classifier maps any thrown value to a STABLE CODE plus
// sanitized, actionable copy with an Administration pointer. Every terminal
// error path in the assistant runtime/stream (the pre-stream catch in
// `streamAgUiChatTurn`, the runtime's outer catch, the adapter `onError`
// callback) routes through it, so the AG-UI `RUN_ERROR` frame carries
// `{message, code}` instead of raw text.
//
// CROSS-REALM BY `code`, NEVER `instanceof`: the throwing classes live in
// `@cinatra-ai/llm` AND in connector-realm copies, which carry the same
// `.code` across module realms (the established recognition pattern).
//
// It lives in THIS pure module — already in every locked route's graph via the
// runtime — rather than in a module of its own, so the stream paths that call
// it add no route-graph pressure (the ratchet).
// ---------------------------------------------------------------------------

/** The classified shape a terminal stream error carries. */
export type AssistantRuntimeErrorClassification = {
  /** Stable machine-readable code (a known domain code, or the fallback
   *  `assistant_run_failed`). */
  code: string;
  /** Sanitized, operator-actionable copy — never raw provider text with
   *  credentials, never unbounded. */
  message: string;
};

/** The fallback code for an unrecognized failure. */
export const ASSISTANT_RUN_FAILED_CODE = "assistant_run_failed";

const ADMIN_LLM_POINTER = "Administration → LLM (/configuration/llm)";

/**
 * Redact anything key-shaped, collapse whitespace, bound the length. Mirrors
 * the setup sanitizer's rule set; kept local so this module stays free of the
 * setup graph (see the module header).
 */
export function sanitizeAssistantErrorText(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-[redacted]")
    .replace(/\b(?:AIza|ya29\.)[A-Za-z0-9_.-]+/g, "[redacted-key]")
    .replace(/(authorization|x-api-key|api[_-]?key|bearer)\s*[:=]\s*\S+/gi, "$1: [redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function codeOf(err: unknown): string | null {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function nameOf(err: unknown): string | null {
  if (err && typeof err === "object" && "name" in err) {
    const name = (err as { name?: unknown }).name;
    return typeof name === "string" ? name : null;
  }
  return null;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(err);
}

/**
 * Classify a thrown value from the assistant runtime / stream path into a
 * stable code + sanitized actionable copy.
 *
 * The two failure classes S5 names explicitly:
 *  - NOT-YET-SYNCED SKILLS (`anthropic_skill_not_synced`) — the first
 *    assistant turn immediately after setup's Continue, before the reconcile
 *    worker caught up. The copy says it is usually transient and points at
 *    Administration for the sync state.
 *  - MCP-MODE REJECTION (`anthropic_function_tool_skill_forbidden` /
 *    `native_mcp_capability_required`) — a `function-tools` remnant on the
 *    connector. The copy names the setting and where to fix it.
 */
export function classifyAssistantRuntimeError(
  err: unknown,
): AssistantRuntimeErrorClassification {
  const code = codeOf(err);

  switch (code) {
    case "anthropic_skill_not_synced":
      return {
        code,
        message:
          "The assistant's skills have not finished uploading to Anthropic yet — " +
          "this can happen on the first turn right after setup while the skill sync " +
          "catches up. Wait a moment and try again; if it persists, check the " +
          `Anthropic skill sync in ${ADMIN_LLM_POINTER}.`,
      };
    case "anthropic_function_tool_skill_forbidden":
    case "native_mcp_capability_required":
      return {
        code,
        message:
          "Anthropic rejected the request because the connector is not delivering " +
          "skills over native MCP (a 'function-tools' mode remnant). Re-run AI setup — " +
          "committing Anthropic migrates the mode to native — or switch the Anthropic " +
          `connector's MCP mode to native in ${ADMIN_LLM_POINTER}, then try again.`,
      };
    case "anthropic_skill_cap_exceeded":
      return {
        code,
        message:
          "More skills were mapped to this request than Anthropic's per-request " +
          "maximum of 8. Reduce the agent's skill set in " +
          `${ADMIN_LLM_POINTER} or the agent's configuration, then try again.`,
      };
    case "mcp_approval_unsupported":
      return {
        code,
        message:
          "A connected MCP server requires tool-call approval, which this provider " +
          "cannot honour. Remove the approval requirement or use a provider that " +
          `supports it — see ${ADMIN_LLM_POINTER}.`,
      };
    default:
      break;
  }

  // The bound-default resolver's provider-naming error (a class, not a coded
  // error): keep its already-actionable message, sanitized, under a stable code.
  if (nameOf(err) === "BoundDefaultProviderUnavailableError") {
    return {
      code: "default_provider_unavailable",
      message:
        sanitizeAssistantErrorText(messageOf(err)) +
        ` Check the provider connection in ${ADMIN_LLM_POINTER}.`,
    };
  }

  return {
    code: ASSISTANT_RUN_FAILED_CODE,
    message: sanitizeAssistantErrorText(messageOf(err)) || "Chat request failed.",
  };
}
