/**
 * Chat-side creation preflight gate tests.
 *
 * Covers:
 *  - Pin INACTIVE -> preflight bypassed entirely; existing dispatch path
 *    unchanged.
 *  - Pin ACTIVE + non-anthropic provider -> first-pass probe runs; no
 *    catalog resolution; dispatch proceeds; ONLY `queued` milestone
 *    emitted (no `syncing_skills`).
 *  - Pin ACTIVE + anthropic + preflight OK -> `queued` + `syncing_skills`
 *    emitted in that order.
 *  - Pin ACTIVE + anthropic + catalog throw -> TERMINAL failure; no
 *    `invokePrimitive("agent_run")` call.
 *  - Pin ACTIVE + preflight !ok -> TERMINAL failure.
 *  - Non-creation packageName -> preflight NEVER invoked. Existing path
 *    untouched.
 *  - Non-HumanUser actor -> milestone helper NEVER invoked; this guards
 *    recipient derivation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks. The preflight + handlers + LLM + notifications layers are all
// dynamically imported by the SUT — we stub each to assert call patterns.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  safeEmit: vi.fn(async (_args: unknown) => undefined),
  isPinActive: vi.fn(() => false),
  preflight: vi.fn(),
  resolveSkills: vi.fn(),
  invokePrimitive: vi.fn(),
}));
const safeEmitMock = mocks.safeEmit;
const isPinActiveMock = mocks.isPinActive;
const preflightMock = mocks.preflight;
const resolveSkillsMock = mocks.resolveSkills;
const invokePrimitiveMock = mocks.invokePrimitive;

vi.mock("@cinatra-ai/notifications/server", () => ({
  safeEmitAgentCreationProgress: mocks.safeEmit,
}));

vi.mock("@/lib/database", () => ({
  isAgentCreationPinActive: () => mocks.isPinActive(),
}));

vi.mock("@cinatra-ai/agents", () => ({
  preflightAgentCreation: (...args: unknown[]) => mocks.preflight(...args),
  resolveRequiredCreationSkillIds: (...args: unknown[]) =>
    mocks.resolveSkills(...args),
  createAgentBuilderPrimitiveHandlers: () => ({}),
  readPublishedAgentTemplates: vi.fn(async () => []),
}));

vi.mock("@cinatra-ai/mcp-client", () => ({
  createInProcessPrimitiveTransport: vi.fn(() => ({})),
  invokePrimitive: (...args: unknown[]) => mocks.invokePrimitive(...args),
}));

vi.mock("@cinatra-ai/llm", () => ({
  runDeterministicLlmTask: vi.fn(async () => ({ text: "{}" })),
}));

// ---------------------------------------------------------------------------
// SUT
// ---------------------------------------------------------------------------
import {
  CREATION_FLOW_PACKAGES,
  serverSideExplicitDispatch,
} from "../explicit-dispatch-server";

function makeSend(): {
  send: (event: string, data: Record<string, unknown>) => void;
  events: Array<{ event: string; data: Record<string, unknown> }>;
} {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  return {
    events,
    send: (event, data) => {
      events.push({ event, data });
    },
  };
}

function humanActor(): import("@/lib/authz/actor-context").ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "user-1",
    authSource: "ui",
    policyVersion: "test",
  };
}

function serviceActor(): import("@/lib/authz/actor-context").ActorContext {
  return {
    principalType: "ServiceAccount",
    principalId: "svc-1",
    authSource: "mcp",
    policyVersion: "test",
  };
}

beforeEach(() => {
  isPinActiveMock.mockReset();
  isPinActiveMock.mockReturnValue(false);
  preflightMock.mockReset();
  resolveSkillsMock.mockReset();
  invokePrimitiveMock.mockReset();
  safeEmitMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CREATION_FLOW_PACKAGES (creation-flow invariant)", () => {
  it("is exactly the 4-package set (no silent additions)", () => {
    expect(Array.from(CREATION_FLOW_PACKAGES).sort()).toEqual(
      [
        "@cinatra-ai/author-agent",
        "@cinatra-ai/code-reviewer-agent",
        "@cinatra-ai/planner-agent",
        "@cinatra-ai/security-reviewer-agent",
      ].sort(),
    );
  });

  it("intentionally omits lint-policy (deterministic, skill-free)", () => {
    expect(CREATION_FLOW_PACKAGES.has("@cinatra-ai/lint-policy-agent")).toBe(false);
  });
});

describe("serverSideExplicitDispatch — pin INACTIVE (default)", () => {
  it("bypasses preflight entirely for creation packages", async () => {
    isPinActiveMock.mockReturnValue(false);
    invokePrimitiveMock.mockResolvedValueOnce({ runId: "r-1", status: "queued" });
    const { send, events } = makeSend();
    const out = await serverSideExplicitDispatch({
      packageName: "@cinatra-ai/planner-agent",
      actor: humanActor(),
      send,
    });
    expect(preflightMock).not.toHaveBeenCalled();
    expect(resolveSkillsMock).not.toHaveBeenCalled();
    expect(invokePrimitiveMock).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ ok: true, runId: "r-1" });
    // queued emit fires; pin inactive => no syncing_skills.
    expect(safeEmitMock).toHaveBeenCalledTimes(1);
    expect(safeEmitMock.mock.calls[0]![0]).toMatchObject({
      milestone: "queued",
      runId: "r-1",
      packageName: "@cinatra-ai/planner-agent",
      recipient: { kind: "user", userId: "user-1" },
    });
    // No terminal failure SSE.
    const toolResult = events.find((e) => e.event === "tool_result");
    expect(toolResult?.data.result).toBe(JSON.stringify({ runId: "r-1", status: "queued" }));
  });
});

describe("serverSideExplicitDispatch — pin ACTIVE + non-Anthropic provider", () => {
  it("runs first-pass preflight ONLY, dispatches, emits queued (no syncing_skills)", async () => {
    isPinActiveMock.mockReturnValue(true);
    preflightMock.mockResolvedValueOnce({
      ok: true,
      pinActive: true,
      provider: "openai",
      model: "gpt-5",
    });
    invokePrimitiveMock.mockResolvedValueOnce({ runId: "r-2", status: "queued" });
    const { send } = makeSend();
    const out = await serverSideExplicitDispatch({
      packageName: "@cinatra-ai/author-agent",
      actor: humanActor(),
      send,
    });
    // First-pass probe with empty laneSkillSets.
    expect(preflightMock).toHaveBeenCalledTimes(1);
    expect(preflightMock.mock.calls[0]![0]).toEqual({
      requiredCatalogSkillIds: [],
      laneSkillSets: [],
    });
    // No catalog resolution.
    expect(resolveSkillsMock).not.toHaveBeenCalled();
    expect(invokePrimitiveMock).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ ok: true, runId: "r-2" });
    // ONLY queued emitted.
    const milestones = safeEmitMock.mock.calls.map(
      (c) => (c[0] as { milestone: string }).milestone,
    );
    expect(milestones).toEqual(["queued"]);
  });
});

describe("serverSideExplicitDispatch — pin ACTIVE + Anthropic provider", () => {
  it("runs two-pass preflight; emits queued + syncing_skills in order", async () => {
    isPinActiveMock.mockReturnValue(true);
    preflightMock
      .mockResolvedValueOnce({
        ok: true,
        pinActive: true,
        provider: "anthropic",
        model: "claude-opus-4-7",
      })
      .mockResolvedValueOnce({
        ok: true,
        pinActive: true,
        provider: "anthropic",
        model: "claude-opus-4-7",
      });
    resolveSkillsMock.mockResolvedValueOnce([
      { agentPackageName: "@cinatra-ai/author-agent", skillIds: ["sk-1"] },
    ]);
    invokePrimitiveMock.mockResolvedValueOnce({ runId: "r-3", status: "queued" });
    const { send } = makeSend();
    const out = await serverSideExplicitDispatch({
      packageName: "@cinatra-ai/author-agent",
      actor: humanActor(),
      send,
    });
    expect(out).toMatchObject({ ok: true, runId: "r-3" });
    expect(preflightMock).toHaveBeenCalledTimes(2);
    expect(resolveSkillsMock).toHaveBeenCalledWith(["@cinatra-ai/author-agent"]);
    const milestones = safeEmitMock.mock.calls.map(
      (c) => (c[0] as { milestone: string }).milestone,
    );
    expect(milestones).toEqual(["queued", "syncing_skills"]);
  });

  it("TERMINAL failure when first-pass preflight !ok — no agent_run call", async () => {
    isPinActiveMock.mockReturnValue(true);
    preflightMock.mockResolvedValueOnce({
      ok: false,
      pinActive: true,
      errors: [{ code: "anthropic_opt_in_off", message: "off" }],
    });
    const { send, events } = makeSend();
    const out = await serverSideExplicitDispatch({
      packageName: "@cinatra-ai/author-agent",
      actor: humanActor(),
      send,
    });
    expect(invokePrimitiveMock).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: false, terminal: true });
    expect((out as { error: string }).error).toContain("preflight_failed");
    // Terminal tool_result SSE present.
    const tr = events.find((e) => e.event === "tool_result");
    expect(tr).toBeDefined();
    expect(tr!.data.resultLabel).toMatch(/preflight_failed/);
    // No emit (preflight failed before runId existed).
    expect(safeEmitMock).not.toHaveBeenCalled();
  });

  it("TERMINAL failure when catalog resolver throws — no agent_run call", async () => {
    isPinActiveMock.mockReturnValue(true);
    preflightMock.mockResolvedValueOnce({
      ok: true,
      pinActive: true,
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    resolveSkillsMock.mockRejectedValueOnce(new Error("registry down"));
    const { send } = makeSend();
    const out = await serverSideExplicitDispatch({
      packageName: "@cinatra-ai/author-agent",
      actor: humanActor(),
      send,
    });
    expect(invokePrimitiveMock).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: false, terminal: true });
    expect((out as { error: string }).error).toContain("catalog_unavailable");
    expect(safeEmitMock).not.toHaveBeenCalled();
  });

  it("TERMINAL failure when second-pass preflight !ok — no agent_run call", async () => {
    isPinActiveMock.mockReturnValue(true);
    preflightMock
      .mockResolvedValueOnce({
        ok: true,
        pinActive: true,
        provider: "anthropic",
        model: "claude-opus-4-7",
      })
      .mockResolvedValueOnce({
        ok: false,
        pinActive: true,
        errors: [{ code: "skills_not_synced", message: "missing sk-1" }],
      });
    resolveSkillsMock.mockResolvedValueOnce([
      { agentPackageName: "@cinatra-ai/author-agent", skillIds: ["sk-1"] },
    ]);
    const { send } = makeSend();
    const out = await serverSideExplicitDispatch({
      packageName: "@cinatra-ai/author-agent",
      actor: humanActor(),
      send,
    });
    expect(invokePrimitiveMock).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: false, terminal: true });
    expect((out as { error: string }).error).toContain("skills_not_synced");
  });
});

describe("serverSideExplicitDispatch — non-creation package", () => {
  it("preflight is NEVER invoked", async () => {
    isPinActiveMock.mockReturnValue(true); // even with pin active, non-creation pkg bypasses preflight
    invokePrimitiveMock.mockResolvedValueOnce({ runId: "r-x", status: "queued" });
    const { send } = makeSend();
    const out = await serverSideExplicitDispatch({
      packageName: "@cinatra-ai/web-research-agent",
      actor: humanActor(),
      send,
    });
    expect(preflightMock).not.toHaveBeenCalled();
    expect(resolveSkillsMock).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, runId: "r-x" });
    // Non-creation packages do NOT emit creation-progress milestones.
    expect(safeEmitMock).not.toHaveBeenCalled();
  });
});

describe("serverSideExplicitDispatch — non-HumanUser actor recipient guard", () => {
  it("does NOT emit milestones for a non-HumanUser actor", async () => {
    isPinActiveMock.mockReturnValue(false);
    invokePrimitiveMock.mockResolvedValueOnce({ runId: "r-y", status: "queued" });
    const { send } = makeSend();
    const out = await serverSideExplicitDispatch({
      packageName: "@cinatra-ai/planner-agent",
      actor: serviceActor(),
      send,
    });
    expect(out).toMatchObject({ ok: true, runId: "r-y" });
    expect(safeEmitMock).not.toHaveBeenCalled();
  });
});
