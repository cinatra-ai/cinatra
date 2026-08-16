/**
 * THE HELD DISPATCH, SERVER SIDE — half (a) of the held-turn card gate.
 *
 * A chat dispatch that PARKS the run must leave the transcript able to draw the
 * card, and must not answer with prose that names another surface as the place
 * to decide. Those are two separate obligations and this suite holds both on the
 * REAL `serverSideExplicitDispatch`:
 *
 *   DURABLE. The `agent_run` tool result must carry the runId and the parked
 *   status as a persisted payload. That payload is what a reloaded transcript
 *   rebuilds the card from; without it the card can only exist for as long as
 *   the stream does.
 *
 *   NO DECISION-PATH POINTER. The deterministic dispatch text must not tell the
 *   human to go somewhere else to confirm, skip, or approve. The ban targets the
 *   decision path, never the noun: naming the run page is fine, sending the
 *   decision there is not.
 *
 * The projection built from the emitted SSE events is evaluated by the SAME
 * `evaluateHeldTurnProjection` the fixture suite and the transcript DOM test
 * use, so there is one authority for "what a held turn owes" and no second
 * opinion to drift from.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  HELD_TURN_ROW,
  evaluateHeldTurnProjection,
  findDecisionPathPointers,
  isHeldDispatch,
  type TurnProjection,
} from "@/lib/lifecycle/held-turn-card-contract";

const mocks = vi.hoisted(() => ({
  invokePrimitive: vi.fn(),
  safeEmit: vi.fn(async () => undefined),
}));

vi.mock("@cinatra-ai/notifications/server", () => ({
  safeEmitAgentCreationProgress: mocks.safeEmit,
}));

vi.mock("@/lib/database", () => ({
  isAgentCreationPinActive: () => false,
}));

// No DB in this suite: the readiness gate's own semantics are covered by
// src/lib/__tests__/agent-run-readiness.test.ts.
vi.mock("@/lib/agent-run-readiness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-run-readiness")>()),
  assertAgentRunReadyByPackage: vi.fn(async () => null),
}));

vi.mock("@cinatra-ai/agents", () => ({
  preflightAgentCreation: vi.fn(),
  resolveRequiredCreationSkillIds: vi.fn(),
  createAgentBuilderPrimitiveHandlers: () => ({}),
  readPublishedAgentTemplates: vi.fn(async () => []),
  getAgentCreationFlowPackages: () => new Set<string>(),
}));

vi.mock("@cinatra-ai/mcp-client", () => ({
  createInProcessPrimitiveTransport: vi.fn(() => ({})),
  invokePrimitive: (...args: unknown[]) => mocks.invokePrimitive(...args),
}));

vi.mock("@cinatra-ai/llm", () => ({
  runDeterministicLlmTask: vi.fn(async () => ({ text: "{}" })),
}));

import { serverSideExplicitDispatch } from "../explicit-dispatch-server";

type Emitted = { event: string; data: Record<string, unknown> };

function makeSend(): { send: (event: string, data: Record<string, unknown>) => void; events: Emitted[] } {
  const events: Emitted[] = [];
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

/**
 * The turn as the transcript will receive it: the ordered SSE parts, with the
 * durable tool-result payload preserved verbatim. `nodes` is empty — the server
 * renders nothing, so the DOM arm of the contract is vacuous here and is held by
 * the transcript test instead.
 */
function projectionFromEvents(events: Emitted[]): TurnProjection {
  const parts: Array<TurnProjection["parts"][number]> = [];
  let slot = 0;
  for (const e of events) {
    if (e.event === "tool_result") {
      parts.push({
        kind: "tool_result",
        slot: slot++,
        name: String(e.data.name ?? ""),
        result: typeof e.data.result === "string" ? e.data.result : null,
      });
    } else if (e.event === "text") {
      parts.push({ kind: "text", slot: slot++, text: String(e.data.content ?? "") });
    }
  }
  return { parts, nodes: [] };
}

const PACKAGE = "@cinatra-ai/proof-agent";

beforeEach(() => {
  mocks.invokePrimitive.mockReset();
  mocks.safeEmit.mockReset();
});

describe("a HELD chat dispatch (pending_input)", () => {
  it("emits the durable agent_run tool result carrying the runId and the parked status", async () => {
    mocks.invokePrimitive.mockResolvedValueOnce({ runId: "run-held-1", status: "pending_input" });
    const { send, events } = makeSend();

    const out = await serverSideExplicitDispatch({ packageName: PACKAGE, actor: humanActor(), send });

    expect(out).toMatchObject({ ok: true, runId: "run-held-1", status: "pending_input" });
    expect(isHeldDispatch({ status: out.ok ? out.status : undefined })).toBe(true);

    const toolResult = events.find((e) => e.event === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult!.data.name).toBe("agent_run");
    // DURABLE: a persisted payload the transcript can rebuild the card from
    // after a reload, not a label a reader has to parse back out of prose.
    const payload = JSON.parse(String(toolResult!.data.result)) as Record<string, unknown>;
    expect(payload).toMatchObject({ runId: "run-held-1", status: "pending_input" });
  });

  it("answers with NO decision-path pointer in the deterministic dispatch text", async () => {
    mocks.invokePrimitive.mockResolvedValueOnce({ runId: "run-held-2", status: "pending_input" });
    const { send, events } = makeSend();

    await serverSideExplicitDispatch({ packageName: PACKAGE, actor: humanActor(), send });

    const texts = events.filter((e) => e.event === "text").map((e) => String(e.data.content ?? ""));
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      const hits = findDecisionPathPointers(text);
      expect(
        hits,
        `the held dispatch text presents another surface as the decision path: ${JSON.stringify(text)}`,
      ).toEqual([]);
    }
  });

  it("satisfies the held-turn contract's server-side arm as a whole", async () => {
    mocks.invokePrimitive.mockResolvedValueOnce({ runId: "run-held-3", status: "pending_input" });
    const { send, events } = makeSend();

    await serverSideExplicitDispatch({ packageName: PACKAGE, actor: humanActor(), send });

    const violations = evaluateHeldTurnProjection(projectionFromEvents(events), HELD_TURN_ROW);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});

describe("a NON-held chat dispatch (queued) — the same two obligations, as regression", () => {
  it("keeps the durable result and the pointer-free text", async () => {
    mocks.invokePrimitive.mockResolvedValueOnce({ runId: "run-q-1", status: "queued" });
    const { send, events } = makeSend();

    await serverSideExplicitDispatch({ packageName: PACKAGE, actor: humanActor(), send });

    const toolResult = events.find((e) => e.event === "tool_result");
    expect(JSON.parse(String(toolResult!.data.result))).toMatchObject({
      runId: "run-q-1",
      status: "queued",
    });
    for (const e of events.filter((x) => x.event === "text")) {
      expect(findDecisionPathPointers(String(e.data.content ?? ""))).toEqual([]);
    }
  });
});

describe("the failure paths still answer without a decision-path pointer", () => {
  it("keeps the no-runId failure text free of pointers", async () => {
    mocks.invokePrimitive.mockResolvedValueOnce({ error: "no capacity" });
    const { send, events } = makeSend();

    await serverSideExplicitDispatch({ packageName: PACKAGE, actor: humanActor(), send });

    for (const e of events.filter((x) => x.event === "text")) {
      expect(findDecisionPathPointers(String(e.data.content ?? ""))).toEqual([]);
    }
  });

  it("keeps the throw path's failure text free of pointers", async () => {
    mocks.invokePrimitive.mockRejectedValueOnce(new Error("transport down"));
    const { send, events } = makeSend();

    await serverSideExplicitDispatch({ packageName: PACKAGE, actor: humanActor(), send });

    for (const e of events.filter((x) => x.event === "text")) {
      expect(findDecisionPathPointers(String(e.data.content ?? ""))).toEqual([]);
    }
  });
});
