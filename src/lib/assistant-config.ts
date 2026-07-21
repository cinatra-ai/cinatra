// The interaction axis (cinatra-ai/cinatra#1037 P1, the "packaging" half).
//
// `agent_templates.agent_kind` types a template as a conversational `assistant`
// or a bounded `executor`. This axis is ORTHOGONAL to `type`
// (leaf|proxy|orchestrator, the execution-topology axis) — it is never
// overloaded onto `type`, and there is deliberately NO "project" kind.
//
// An `assistant` row carries a typed `assistant_config` SIDECAR (persona, skill
// bundle, allowed tools/agents, model prefs); an `executor` row carries NONE. The
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

// ---------------------------------------------------------------------------
// agent_kind
// ---------------------------------------------------------------------------

export const AGENT_KINDS = ["assistant", "executor"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** The default kind for every template that does not declare one — matches the
 *  `DEFAULT 'executor'` on the column, so an un-typed legacy row is an executor agent. */
export const DEFAULT_AGENT_KIND: AgentKind = "executor";

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && (AGENT_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// assistant_config shape
// ---------------------------------------------------------------------------
//
// RELOCATED to `@cinatra-ai/sdk-extensions` (cinatra#1874, Epic #1873 W1) so the
// shared assistant-declaration parser in that package validates its projection
// against the SAME schema this module writes with — exactly ONE schema
// definition, no drift. Re-exported here so every existing `@/lib/assistant-config`
// importer keeps working unchanged.
import {
  assistantConfigSchema,
  type AssistantConfig,
} from "@cinatra-ai/sdk-extensions";

export {
  modelPrefsSchema,
  assistantMcpPolicySchema,
  DEFAULT_ASSISTANT_MCP_POLICY,
  resolveAssistantMcpPolicy,
  assistantConfigSchema,
} from "@cinatra-ai/sdk-extensions";
export type { ModelPrefs, AssistantMcpPolicy, AssistantConfig } from "@cinatra-ai/sdk-extensions";

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
   *  assistant, `null` for an executor. */
  assistantConfigColumn: string | null;
};

/**
 * Enforce the interaction-axis invariant BEFORE a write — the app-level twin of
 * the `agent_templates_agent_kind_config_check` constraint, but with a shape
 * check (which the DB CHECK cannot do) and a typed error:
 *
 *   • an `assistant` row MUST carry a valid `assistant_config`;
 *   • an `executor` row MUST NOT carry one.
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

  if (input.agentKind === "executor") {
    if (hasConfig) {
      throw new Error("agent_kind='executor' must not carry an assistant_config");
    }
    return { agentKind: "executor", assistantConfigColumn: null };
  }

  // agent_kind === "assistant"
  if (!hasConfig) {
    throw new Error("agent_kind='assistant' requires an assistant_config");
  }
  const config = parseAssistantConfig(input.assistantConfig);
  return { agentKind: "assistant", assistantConfigColumn: serializeAssistantConfig(config) };
}
