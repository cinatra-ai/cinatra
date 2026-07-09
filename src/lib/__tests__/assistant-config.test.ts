// Unit tests for the interaction-axis packaging (cinatra-ai/cinatra#1037 P1):
// the assistant_config shape validator and the agent_kind ↔ config invariant.
// Pure (no DB) — this pins the app-level twin of the DB
// `agent_templates_agent_kind_config_check` constraint plus the config SHAPE
// (which the presence-only DB CHECK cannot express).

import { describe, expect, it } from "vitest";

import {
  AGENT_KINDS,
  DEFAULT_AGENT_KIND,
  isAgentKind,
  assistantConfigSchema,
  safeParseAssistantConfig,
  parseAssistantConfig,
  serializeAssistantConfig,
  normalizeAgentKindConfig,
  type AssistantConfig,
} from "../assistant-config";

const validConfig: AssistantConfig = {
  persona: "You are Cinatra, the platform assistant.",
  skillBundle: ["chat-assistant-core"],
  allowedTools: [],
  allowedAgents: [],
  modelPrefs: {},
};

describe("agent_kind", () => {
  it("enumerates exactly assistant + task", () => {
    expect([...AGENT_KINDS]).toEqual(["assistant", "task"]);
  });

  it("defaults to task (matches the column DEFAULT)", () => {
    expect(DEFAULT_AGENT_KIND).toBe("task");
  });

  it("isAgentKind accepts only the two kinds", () => {
    expect(isAgentKind("assistant")).toBe(true);
    expect(isAgentKind("task")).toBe(true);
    expect(isAgentKind("project")).toBe(false);
    expect(isAgentKind("leaf")).toBe(false);
    expect(isAgentKind(undefined)).toBe(false);
    expect(isAgentKind(null)).toBe(false);
  });
});

describe("assistant_config shape", () => {
  it("accepts a minimal valid config and applies allow-list defaults", () => {
    const parsed = assistantConfigSchema.parse({
      persona: "p",
      skillBundle: ["chat-assistant-core"],
    });
    expect(parsed.allowedTools).toEqual([]);
    expect(parsed.allowedAgents).toEqual([]);
    expect(parsed.modelPrefs).toEqual({});
  });

  it("rejects an empty persona", () => {
    const r = safeParseAssistantConfig({ persona: "", skillBundle: [] });
    expect(r.ok).toBe(false);
  });

  it("rejects a non-object / non-array field", () => {
    expect(safeParseAssistantConfig({ persona: "p", skillBundle: "not-array" }).ok).toBe(false);
    expect(safeParseAssistantConfig(42).ok).toBe(false);
    expect(safeParseAssistantConfig(null).ok).toBe(false);
  });

  it("rejects a temperature outside [0,2]", () => {
    expect(
      safeParseAssistantConfig({ persona: "p", skillBundle: [], modelPrefs: { temperature: 3 } }).ok,
    ).toBe(false);
    expect(
      safeParseAssistantConfig({ persona: "p", skillBundle: [], modelPrefs: { temperature: 0.7 } }).ok,
    ).toBe(true);
  });

  it("strips unknown keys (forward-compatible)", () => {
    const parsed = assistantConfigSchema.parse({
      persona: "p",
      skillBundle: [],
      somethingNew: "ignored",
    } as unknown);
    expect((parsed as Record<string, unknown>).somethingNew).toBeUndefined();
  });

  it("parses the JSON-as-text stored form", () => {
    const stored = serializeAssistantConfig(validConfig);
    expect(typeof stored).toBe("string");
    const round = parseAssistantConfig(stored);
    expect(round.persona).toBe(validConfig.persona);
    expect(round.skillBundle).toEqual(["chat-assistant-core"]);
  });

  it("fails a non-JSON string", () => {
    const r = safeParseAssistantConfig("{not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not valid JSON");
  });

  it("parseAssistantConfig throws on an invalid config", () => {
    expect(() => parseAssistantConfig({ skillBundle: [] })).toThrow(/Invalid assistant_config/);
  });
});

describe("normalizeAgentKindConfig — the write-time invariant", () => {
  it("assistant + valid config → serialized column value", () => {
    const out = normalizeAgentKindConfig({ agentKind: "assistant", assistantConfig: validConfig });
    expect(out.agentKind).toBe("assistant");
    expect(out.assistantConfigColumn).not.toBeNull();
    expect(parseAssistantConfig(out.assistantConfigColumn!)).toMatchObject({ persona: validConfig.persona });
  });

  it("assistant + JSON-string config is accepted", () => {
    const out = normalizeAgentKindConfig({
      agentKind: "assistant",
      assistantConfig: JSON.stringify(validConfig),
    });
    expect(out.assistantConfigColumn).not.toBeNull();
  });

  it("assistant WITHOUT a config → throws (I: assistant rows require a config)", () => {
    expect(() => normalizeAgentKindConfig({ agentKind: "assistant" })).toThrow(/requires an assistant_config/);
    expect(() => normalizeAgentKindConfig({ agentKind: "assistant", assistantConfig: null })).toThrow(
      /requires an assistant_config/,
    );
  });

  it("assistant + INVALID config → throws", () => {
    expect(() =>
      normalizeAgentKindConfig({ agentKind: "assistant", assistantConfig: { persona: "" } }),
    ).toThrow(/Invalid assistant_config/);
  });

  it("task WITHOUT a config → null column", () => {
    const out = normalizeAgentKindConfig({ agentKind: "task" });
    expect(out).toEqual({ agentKind: "task", assistantConfigColumn: null });
  });

  it("task WITH a config → throws (I: task rows carry none)", () => {
    expect(() =>
      normalizeAgentKindConfig({ agentKind: "task", assistantConfig: validConfig }),
    ).toThrow(/must not carry an assistant_config/);
  });

  it("an unknown kind → throws", () => {
    expect(() =>
      normalizeAgentKindConfig({ agentKind: "project" as unknown as "task" }),
    ).toThrow(/Invalid agent_kind/);
  });
});
