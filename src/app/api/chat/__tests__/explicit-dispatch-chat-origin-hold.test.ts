/**
 * THE CONVERSATION TELLS THE TRUTH WHEN A RUN PARKS (chat-hitl S9b).
 *
 * The chat pre-router used to say "The agent is running" for every dispatch it
 * made, because every dispatch it made really did queue a run. A chat-started
 * run can now PAUSE on the run-start recommendation hold instead: the primitive
 * leaves it `pending_input`, with nothing queued behind it, waiting for a person
 * to confirm or skip the recommended skills.
 *
 * On that path the old sentence is simply false, and it is the sentence that
 * would send the reader off to wait for progress that cannot arrive until they
 * act. Two things are pinned here:
 *
 *   1. the held dispatch points AT the card in the conversation rather than
 *      describing a running agent, and the unheld dispatch is untouched;
 *   2. the frame this bridge hands the primitive carries the SERVER-STAMPED
 *      launch origin — the one carrier that makes a chat-started run
 *      human-present, and the one thing a model must never be able to write.
 *
 *   pnpm exec vitest run \
 *     src/app/api/chat/__tests__/explicit-dispatch-chat-origin-hold.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  safeEmit: vi.fn(async (_input: Record<string, unknown>): Promise<void> => undefined),
  isPinActive: vi.fn(() => false),
  invokePrimitive: vi.fn(),
}));

vi.mock("@cinatra-ai/notifications/server", () => ({
  safeEmitAgentCreationProgress: mocks.safeEmit,
}));

vi.mock("@/lib/database", () => ({
  isAgentCreationPinActive: () => mocks.isPinActive(),
}));

vi.mock("@/lib/agent-run-readiness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-run-readiness")>()),
  assertAgentRunReadyByPackage: vi.fn(async () => null),
}));

vi.mock("@cinatra-ai/agents", () => ({
  preflightAgentCreation: vi.fn(),
  resolveRequiredCreationSkillIds: vi.fn(),
  createAgentBuilderPrimitiveHandlers: () => ({}),
  readPublishedAgentTemplates: vi.fn(async () => []),
  // PACKAGE is declared a creation-flow package so the creation-progress
  // milestone branch is REACHABLE. Without that the "no milestone when held"
  // assertion below would pass for the wrong reason — the branch would simply
  // never be entered. The pin stays inactive, so the preflight short-circuits
  // and only the `queued` milestone is in play.
  getAgentCreationFlowPackages: () => new Set<string>(["@cinatra-ai/blog-draft-writer-agent"]),
}));

vi.mock("@cinatra-ai/mcp-client", () => ({
  createInProcessPrimitiveTransport: vi.fn(() => ({})),
  invokePrimitive: (...args: unknown[]) => mocks.invokePrimitive(...args),
}));

vi.mock("@cinatra-ai/llm", () => ({
  runDeterministicLlmTask: vi.fn(async () => ({ text: "{}" })),
}));

import { serverSideExplicitDispatch } from "../explicit-dispatch-server";

const PACKAGE = "@cinatra-ai/blog-draft-writer-agent";
const RUN_ID = "85bd2267-3f9a-4f0d-a1da-bb3a54f1a50d";

function makeSend(): {
  send: (event: string, data: Record<string, unknown>) => void;
  events: Array<{ event: string; data: Record<string, unknown> }>;
} {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  return { events, send: (event, data) => void events.push({ event, data }) };
}

function humanActor(): import("@/lib/authz/actor-context").ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "user-1",
    authSource: "ui",
    policyVersion: "test",
  };
}

async function dispatchWithStatus(status: string): Promise<{
  text: string;
  toolResult: Record<string, unknown>;
}> {
  mocks.invokePrimitive.mockResolvedValueOnce({ runId: RUN_ID, status });
  const { send, events } = makeSend();
  await serverSideExplicitDispatch({ packageName: PACKAGE, actor: humanActor(), send });
  const textEvent = events.find((e) => e.event === "text");
  const toolResult = events.find((e) => e.event === "tool_result");
  return {
    text: String(textEvent?.data.content ?? ""),
    toolResult: JSON.parse(String(toolResult?.data.result)) as Record<string, unknown>,
  };
}

beforeEach(() => {
  mocks.isPinActive.mockReset();
  mocks.isPinActive.mockReturnValue(false);
  mocks.invokePrimitive.mockReset();
  mocks.safeEmit.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a held dispatch does not claim the agent is running", () => {
  it("drops the running sentence and points at the card the reader must act on", async () => {
    const { text } = await dispatchWithStatus("pending_input");

    expect(text).not.toContain("The agent is running");
    expect(text).not.toContain("keep polling");
    expect(text).toMatch(/paused/i);
    // The next action is named, and it is the one the card actually offers.
    expect(text).toMatch(/confirm/i);
    expect(text).toMatch(/skip/i);
  });

  it("still carries the run id and the honest status on the wire", async () => {
    const { text, toolResult } = await dispatchWithStatus("pending_input");

    expect(toolResult).toEqual({ runId: RUN_ID, status: "pending_input" });
    // The card mounts off this tool result's run id, so the held run gets its
    // card in the conversation exactly like a queued one does.
    expect(text).toContain(RUN_ID);
  });

  it("leaves a queued dispatch's wording untouched", async () => {
    const { text } = await dispatchWithStatus("queued");

    expect(text).toContain("The agent is running");
    expect(text).not.toMatch(/paused/i);
  });
});

describe("the launch origin is stamped by this bridge, not by anyone else", () => {
  it("hands the primitive a chat launch origin on every pre-router dispatch", async () => {
    await dispatchWithStatus("queued");

    const request = mocks.invokePrimitive.mock.calls[0][1] as {
      actor: Record<string, unknown>;
      input: Record<string, unknown>;
    };
    expect(request.actor.launchOrigin).toBe("chat");
    // Presence rides the ACTOR frame. It must not appear in the primitive's
    // input, which is the half of the call a model can influence.
    expect(Object.keys(request.input).sort()).toEqual(["inputParams", "packageName"]);
    expect(JSON.stringify(request.input)).not.toContain("launchOrigin");
    expect(JSON.stringify(request.input)).not.toContain("humanPresent");
  });

  it("stamps it as a constant — the same value for a system principal", async () => {
    // The origin describes the CALL FRAME (this bridge is only reachable from
    // the chat route), not the caller's identity, so no principal shape turns
    // it off or changes it.
    mocks.invokePrimitive.mockResolvedValueOnce({ runId: RUN_ID, status: "queued" });
    const { send } = makeSend();
    await serverSideExplicitDispatch({
      packageName: PACKAGE,
      actor: {
        principalType: "ServiceAccount",
        principalId: "svc-1",
        authSource: "ui",
        policyVersion: "test",
      } as unknown as import("@/lib/authz/actor-context").ActorContext,
      send,
    });

    const request = mocks.invokePrimitive.mock.calls[0][1] as { actor: Record<string, unknown> };
    expect(request.actor.launchOrigin).toBe("chat");
  });
});

describe("a held run emits no creation-progress milestone", () => {
  it("POSITIVE CONTROL: a queued creation-flow dispatch does announce it", async () => {
    await dispatchWithStatus("queued");

    expect(mocks.safeEmit).toHaveBeenCalledTimes(1);
    expect(mocks.safeEmit.mock.calls[0]?.[0]).toMatchObject({
      runId: RUN_ID,
      milestone: "queued",
    });
  });

  it("does not announce `queued` for a run that is parked", async () => {
    // The milestone is literally "queued" and the run is not. The decision's
    // own release drives it through the canonical trigger path, which is where
    // a truthful queued milestone belongs. The control above proves this
    // branch is reachable, so the silence here is a decision and not an
    // accident of the fixture.
    await dispatchWithStatus("pending_input");

    expect(mocks.safeEmit).not.toHaveBeenCalled();
  });
});
