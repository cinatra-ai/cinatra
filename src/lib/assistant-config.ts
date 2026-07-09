// The interaction axis (cinatra-ai/cinatra#1037 P1, the "packaging" half).
//
// `agent_templates.agent_kind` types a template as a conversational `assistant`
// or a bounded `task`. This axis is ORTHOGONAL to `type`
// (leaf|proxy|orchestrator, the execution-topology axis) — it is never
// overloaded onto `type`, and there is deliberately NO "project" kind.
//
// An `assistant` row carries a typed `assistant_config` SIDECAR (persona, skill
// bundle, allowed tools/agents, model prefs); a `task` row carries NONE. The
// authoritative write-time invariant lives in the database as the
// `agent_templates_agent_kind_config_check` CHECK constraint, so EVERY writer
// (importAgentTemplate, ensureAgentPackage, the marketplace install saga) is
// covered regardless of which code path inserts the row. This module is the
// APP-LEVEL companion: it owns the SHAPE of the sidecar (which the DB CHECK,
// being presence-only, cannot express) and the helpers writers use to validate
// and serialize a config before it reaches the store.
//
// Pure, framework-free module (no "server-only", no DB access) so it is
// importable from server code, the store layer, and unit tests alike.

import { z } from "zod";

// ---------------------------------------------------------------------------
// agent_kind
// ---------------------------------------------------------------------------

export const AGENT_KINDS = ["assistant", "task"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** The default kind for every template that does not declare one — matches the
 *  `DEFAULT 'task'` on the column, so an un-typed legacy row is a task agent. */
export const DEFAULT_AGENT_KIND: AgentKind = "task";

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && (AGENT_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// assistant_config shape
// ---------------------------------------------------------------------------

/** Model routing preferences for an assistant run. All optional — an absent
 *  field defers to the platform default resolution (provider gating,
 *  DB/Nango-sourced keys). Not a secret carrier. */
export const modelPrefsSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
});
export type ModelPrefs = z.infer<typeof modelPrefsSchema>;

/**
 * The typed assistant sidecar. Unknown keys are stripped (zod default) so the
 * shape can grow forward-compatibly. `persona` and `skillBundle` are the two
 * required load-bearing fields — an assistant is defined by its identity
 * (persona) and the skills it always loads (the Cinatra assistant references
 * the `chat-assistant-core` bundle). Allow-lists default to empty, which the
 * runtime reads as "no explicit restriction beyond platform policy".
 */
export const assistantConfigSchema = z.object({
  /** System persona / conversational identity of the assistant. */
  persona: z.string().min(1),
  /** Skill slugs the assistant always mounts (its reference skill bundle). */
  skillBundle: z.array(z.string().min(1)),
  /** Tool ids/labels this assistant may call. Empty = platform-policy only. */
  allowedTools: z.array(z.string().min(1)).default([]),
  /** Agent package names this assistant may dispatch to. Empty = policy only. */
  allowedAgents: z.array(z.string().min(1)).default([]),
  /** Model routing preferences. */
  modelPrefs: modelPrefsSchema.default({}),
});
export type AssistantConfig = z.infer<typeof assistantConfigSchema>;

// ---------------------------------------------------------------------------
// parse / serialize
// ---------------------------------------------------------------------------

export type ParseResult =
  | { ok: true; config: AssistantConfig }
  | { ok: false; error: string };

/**
 * Validate an assistant config from either a parsed object or the JSON-as-text
 * stored form. Returns a discriminated result rather than throwing so callers
 * can surface a field-level message. A non-JSON string, a non-object, or a
 * shape violation all fail.
 */
export function safeParseAssistantConfig(raw: unknown): ParseResult {
  let candidate: unknown = raw;
  if (typeof raw === "string") {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return { ok: false, error: "assistant_config is not valid JSON" };
    }
  }
  const parsed = assistantConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  }
  return { ok: true, config: parsed.data };
}

/** Throwing form of {@link safeParseAssistantConfig}. */
export function parseAssistantConfig(raw: unknown): AssistantConfig {
  const result = safeParseAssistantConfig(raw);
  if (!result.ok) throw new Error(`Invalid assistant_config — ${result.error}`);
  return result.config;
}

/** Canonical JSON-as-text form for the `assistant_config` column. */
export function serializeAssistantConfig(config: AssistantConfig): string {
  return JSON.stringify(assistantConfigSchema.parse(config));
}

// ---------------------------------------------------------------------------
// invariant (mirrors the DB CHECK for pre-write validation + typed error)
// ---------------------------------------------------------------------------

export type AgentKindConfigInput = {
  agentKind: AgentKind;
  /** Parsed object or stored JSON-as-text; `null`/`undefined` = no sidecar. */
  assistantConfig?: unknown;
};

export type NormalizedAgentKindConfig = {
  agentKind: AgentKind;
  /** The serialized `assistant_config` column value: a JSON string for an
   *  assistant, `null` for a task. */
  assistantConfigColumn: string | null;
};

/**
 * Enforce the interaction-axis invariant BEFORE a write — the app-level twin of
 * the `agent_templates_agent_kind_config_check` constraint, but with a shape
 * check (which the DB CHECK cannot do) and a typed error:
 *
 *   • an `assistant` row MUST carry a valid `assistant_config`;
 *   • a `task` row MUST NOT carry one.
 *
 * Returns the normalized column value (serialized config, or `null`) ready to
 * bind into the INSERT/UPDATE. Throws on any violation so a bad write fails at
 * the app boundary with a clear message instead of a raw constraint error.
 */
export function normalizeAgentKindConfig(input: AgentKindConfigInput): NormalizedAgentKindConfig {
  if (!isAgentKind(input.agentKind)) {
    throw new Error(`Invalid agent_kind: ${String(input.agentKind)} (expected one of ${AGENT_KINDS.join(", ")})`);
  }
  const hasConfig = input.assistantConfig !== null && input.assistantConfig !== undefined;

  if (input.agentKind === "task") {
    if (hasConfig) {
      throw new Error("agent_kind='task' must not carry an assistant_config");
    }
    return { agentKind: "task", assistantConfigColumn: null };
  }

  // agent_kind === "assistant"
  if (!hasConfig) {
    throw new Error("agent_kind='assistant' requires an assistant_config");
  }
  const config = parseAssistantConfig(input.assistantConfig);
  return { agentKind: "assistant", assistantConfigColumn: serializeAssistantConfig(config) };
}
