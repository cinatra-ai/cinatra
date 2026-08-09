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

// ---------------------------------------------------------------------------
// Per-turn no-progress guard (cinatra#2580).
//
// It lives in THIS pure module, beside the error classifier and for the same
// reason: `ports.ts` is already in every locked route's import graph via the
// runtime, so the guard adds no route-graph pressure (the no-new-rot ratchet).
// A module of its own measured +1 module on /chat, /api/a2a, /api/llm-bridge,
// /api/mcp and /sign-in.
//
// THE COST SHAPE THIS EXISTS FOR — measured, not assumed. A chat turn is an
// agentic loop: the provider adapter re-sends the WHOLE request envelope
// (instructions + the full Cinatra MCP tool catalogue + every accumulated
// output item) on EVERY step. One live chat call measured 43,061 input tokens,
// and a single user message drove the loop to `chat-step-14` — 14 chained
// full-context calls for one question. The loop ran to that depth because the
// Cinatra MCP tools were unreachable: the model kept re-issuing the SAME call,
// got NOTHING back, and each of those rounds cost another full ~43k envelope.
// Nothing in the loop noticed it had stopped making progress.
//
// THE SIGNAL IT KEYS ON is the structurally supported one, not a heuristic. A
// hosted-MCP call that fails surfaces to the runtime as an EMPTY result: the
// adapter passes `mcp_call.output ?? ""`, so a dead tunnel produces literally
// NO CONTENT — an empty (or whitespace-only) string. That is the shape the
// measured 14-step turn had.
//
// A STEP counts toward a stop only when ALL of these hold:
//
//   1. the step produced at least one tool result, and EVERY one of them was
//      EMPTY OR WHITESPACE-ONLY — not one carried content;
//   2. all of those empty results came from ONE call identity (same MCP
//      server, same tool name, same arguments);
//   3. that identity is the same as the previous counted step's;
//   4. the step emitted no user-visible text.
//
// `repeatLimit` such steps in a row end the turn. Counting per STEP, not per
// tool result, is deliberate: a step may contain several parallel calls, and a
// step is the unit that is actually billed.
//
// WHY THIS PREDICATE AND NOT A LOOSER ONE — each alternative was tried and
// rejected because it cuts turns that would have succeeded:
//
//   · "N steps without text" — a legitimate research turn (list → get → get →
//     get → answer) emits no text for many steps.
//   · "N tool calls total" — a per-turn budget cuts a legitimate long turn.
//     That is a real behavior change this slice refuses to make.
//   · "N identical results" — a poll loop is the counter-example:
//     `agent_run_get` can legitimately return exactly `{"status":"running"}`
//     several times and flip on the next call. Any result WITH content is
//     information the model may still be acting on, so it resets the streak.
//   · "N identical error envelopes" — an `{"error": …}` payload is not
//     equivalent to no payload. It can carry usable data alongside the error
//     (`{"error":"2 records failed","items":[…]}`), and a transient error that
//     recovers on the next call is ordinary. Classifying it would stop
//     recoverable turns, so error TEXT is treated as a payload like any other.
//
// WHAT BEHAVIOR THIS DOES CHANGE — stated plainly, because "no behavior
// change" would be a lie. Exactly one class of turn ends differently: a turn
// in which one call identity has returned NOTHING on `repeatLimit` consecutive
// steps, with no text produced. Before, it ran on toward the 24-round ceiling
// and then answered from an empty hand (the model confabulates that the
// platform has no such data) or hit the 120s wall. Now it stops and NAMES the
// unresponsive tool.
//
// The residual, disclosed: nobody can prove the NEXT call would also have
// returned nothing, so a tool that was dead for four consecutive billed rounds
// and would have answered on the fifth is stopped. That is the trade this
// change makes, at a threshold chosen so the turn has already paid four full
// ~43k-token rounds to learn nothing. Every turn carrying ANY progress
// signal — text, a result with content in it, a different call — is untouched,
// which the runtime tests pin.
//
// PURE + PROVIDER-AGNOSTIC on purpose: it reads only the `{name, arguments}` /
// `{name, result}` callback shapes every shipped adapter already emits, so it
// holds for OpenAI, Anthropic and Gemini alike and is unit-testable with no
// provider, no network and no live call.
//
// FAIL OPEN, ALWAYS. Every case the guard cannot read with certainty — a
// result it cannot join to its call, an argument object it cannot serialize, a
// step mixing several call identities — resets the streak rather than counting
// it. A guard that under-fires costs money; a guard that over-fires costs the
// user their answer.
// ---------------------------------------------------------------------------

/** Stable machine-readable code for a turn the guard stopped. */
export const TURN_STOPPED_NO_PROGRESS_CODE = "turn_stopped_no_progress";

/**
 * How many CONSECUTIVE all-empty provider steps off one call identity end the
 * turn.
 *
 * Four, not two: a transient tool failure the model retries can legitimately
 * come back empty twice, and occasionally a third time, before the surface
 * recovers. Four is where the turn has already paid four full-context rounds
 * for no tool content at all — the point at which continuing is a worse bet
 * for the user than stopping and naming the tool. It is a threshold, not a
 * proof: see the residual disclosed in the module header.
 */
export const DEFAULT_NO_PROGRESS_REPEAT_LIMIT = 4;

export type TurnCostGuardOptions = {
  /** Consecutive all-empty steps off one call identity. Default 4. */
  repeatLimit?: number;
};

export type TurnCostGuardVerdict = {
  /** The tool whose call returned nothing on every counted step. */
  toolName: string;
  /** How many consecutive provider steps returned nothing. */
  repeats: number;
};

/** The subset of an adapter's tool-call callback the guard reads. */
export type TurnCostGuardToolCall = {
  id?: string;
  name: string;
  arguments?: unknown;
  serverLabel?: string;
};

/** The subset of an adapter's tool-result callback the guard reads. */
export type TurnCostGuardToolResult = {
  id?: string;
  name: string;
  result: string;
  serverLabel?: string;
};

export type TurnCostGuard = {
  /** Record a tool call so its arguments can be joined to its result by id. */
  observeToolCall(call: TurnCostGuardToolCall): void;
  /** Record a tool result. Never trips the guard on its own — see observeStepEnd. */
  observeToolResult(result: TurnCostGuardToolResult): void;
  /** Record user-visible assistant text — real progress for this step. */
  observeTextDelta(delta: string): void;
  /** Close a provider step: the ONLY place the streak advances or trips. */
  observeStepEnd(): void;
  /** The verdict, or null while the turn is still making progress. */
  verdict(): TurnCostGuardVerdict | null;
  /** Completed provider steps so far — the unit of full-context cost. */
  readonly steps: number;
};

/**
 * A tool result carries no content — empty, or whitespace only. This is the
 * dead hosted-MCP signature: the adapter passes `mcp_call.output ?? ""`, so a
 * failed hosted call arrives as the empty string. Whitespace-only is folded in
 * deliberately (it is equally devoid of information), and every comment and
 * test in this module says "empty or whitespace-only" rather than "empty" so
 * the documented predicate matches the implemented one exactly.
 */
function isEmptyResult(result: string): boolean {
  return result.trim() === "";
}

/**
 * A content fingerprint: two independent 32-bit FNV-1a-style hashes plus the
 * UTF-16 code-unit length. Hashing rather than retaining, because arguments
 * can be large and the guard must not hold turn-scoped copies of them.
 *
 * The honest bound: this is not identity. Two different serialized argument
 * strings that agree on both hashes AND their length would be read as the same
 * call, which could let a streak accumulate across two distinct dead calls and
 * stop the turn one class of case earlier than intended. That case still
 * requires every counted step to have returned no content, so the outcome is
 * "stopped a turn that was already getting nothing", never "stopped a turn
 * that was getting answers".
 */
function fingerprint(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}.${text.length}`;
}

/**
 * Order-stable fingerprint of a tool-argument value, or `null` when the value
 * cannot be serialized at all (a cycle, a BigInt). `null` is the fail-open
 * signal: the caller resets the streak rather than guessing that two
 * unserializable argument objects were equal.
 *
 * The replacer sorts object keys at every depth (including objects nested in
 * arrays) so the same call emitted with a different key order fingerprints the
 * same; array ORDER is left intact, because a reordered array is a different
 * call.
 */
function fingerprintArgs(args: unknown): string | null {
  if (args === undefined) return fingerprint("");
  try {
    const json = JSON.stringify(args, (_key, value) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        return Object.keys(record)
          .sort()
          .reduce<Record<string, unknown>>((acc, key) => {
            acc[key] = record[key];
            return acc;
          }, {});
      }
      return value;
    });
    // `JSON.stringify` returns undefined for a bare undefined/function value.
    return typeof json === "string" ? fingerprint(json) : null;
  } catch {
    return null;
  }
}

export function createTurnCostGuard(
  options: TurnCostGuardOptions = {},
): TurnCostGuard {
  const repeatLimit = Math.max(2, options.repeatLimit ?? DEFAULT_NO_PROGRESS_REPEAT_LIMIT);

  // Arguments arrive on `onToolCall`, results on `onToolResult`, and the call
  // id is the ONLY unambiguous join between them. Every shipped adapter echoes
  // the id it announced (`tc.callId` for function tools, `mc.id` for native
  // MCP calls). A result whose id is missing or unknown fails open rather than
  // being guessed at by tool name, which would conflate concurrent same-name
  // calls carrying different arguments.
  const argsByCallId = new Map<string, string | null>();

  // Per-step accumulators, reset at every `observeStepEnd`.
  let stepEmptyKeys = new Set<string>();
  let stepEmptyToolName = "";
  let stepSawPayload = false;
  let stepSawText = false;
  let stepUnjoinable = false;

  let streakKey: string | null = null;
  let streakToolName = "";
  let streakCount = 0;
  let tripped: TurnCostGuardVerdict | null = null;
  let steps = 0;

  function resetStep() {
    stepEmptyKeys = new Set<string>();
    stepEmptyToolName = "";
    stepSawPayload = false;
    stepSawText = false;
    stepUnjoinable = false;
    // Every shipped adapter executes a step's tool calls inside that step, so
    // a call still open at the boundary never gets a result. Dropping them
    // here keeps the map bounded by ONE step's fan-out and keeps a stale
    // identity from ever being joined to a later step's result.
    argsByCallId.clear();
  }

  function breakStreak() {
    streakKey = null;
    streakToolName = "";
    streakCount = 0;
  }

  return {
    observeToolCall(call) {
      // No id ⇒ no join ⇒ the result fails open; nothing to record.
      if (!call.id) return;
      argsByCallId.set(call.id, fingerprintArgs(call.arguments));
    },

    observeToolResult(result) {
      if (tripped) return;

      // Retire the call's entry on EVERY result, payload or not — the map must
      // never outlive the round-trip it was opened for.
      const argsFingerprint = result.id ? argsByCallId.get(result.id) : undefined;
      if (result.id) argsByCallId.delete(result.id);

      // Any content at all is information the model may be acting on.
      if (!isEmptyResult(result.result)) {
        stepSawPayload = true;
        return;
      }

      if (argsFingerprint === undefined || argsFingerprint === null) {
        // Cannot prove which call this empty result belongs to.
        stepUnjoinable = true;
        return;
      }

      // `serverLabel` is part of the identity: two MCP servers may both expose
      // a `search` tool, and one being dead says nothing about the other.
      stepEmptyKeys.add(`${result.serverLabel ?? ""}|${result.name}|${argsFingerprint}`);
      stepEmptyToolName = result.name;
    },

    observeTextDelta(delta) {
      // A user-visible token is something the model could only say after
      // reading the tool output.
      if (delta.length > 0) stepSawText = true;
    },

    observeStepEnd() {
      steps += 1;
      if (tripped) {
        resetStep();
        return;
      }

      // A step counts toward a stop only if it was ENTIRELY empty, joinable,
      // silent, and attributable to exactly one call identity. Anything else
      // is progress or uncertainty — both break the streak.
      const countable =
        !stepSawText &&
        !stepSawPayload &&
        !stepUnjoinable &&
        stepEmptyKeys.size === 1;

      if (!countable) {
        breakStreak();
        resetStep();
        return;
      }

      const key = [...stepEmptyKeys][0];
      if (key === streakKey) {
        streakCount += 1;
      } else {
        streakKey = key;
        streakToolName = stepEmptyToolName;
        streakCount = 1;
      }
      if (streakCount >= repeatLimit) {
        tripped = { toolName: streakToolName, repeats: streakCount };
      }
      resetStep();
    },

    verdict() {
      return tripped;
    },

    get steps() {
      return steps;
    },
  };
}

/**
 * User-facing copy for a stopped turn. Names the repeating tool (already
 * rendered in the chat's tool-call chips, so not new exposure) and points at
 * the cause this predicate actually indicates: a tool surface that is not
 * answering.
 */
export function noProgressMessage(verdict: TurnCostGuardVerdict): string {
  return (
    `The assistant stopped this turn: the "${verdict.toolName}" tool returned nothing ` +
    `${verdict.repeats} times in a row, so the turn was making no progress. That usually ` +
    "means the tool is unavailable — check the connection for that tool and try again."
  );
}
