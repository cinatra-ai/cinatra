/**
 * THE NAMED START, SERVER SIDE — half (a) of the held-turn card gate, retargeted
 * (cinatra#2935, lifecycle-b W5d).
 *
 * WHAT THIS REPLACES, AND WHY IT MOVED. Half (a) used to drive
 * `serverSideExplicitDispatch` — the deterministic pre-router that started an
 * agent before the model read the message. That module is gone with the
 * sentence-matcher it served, so the obligations it carried move to the surface
 * that replaced it: the one narrow start the assistant calls. The contract
 * module itself (`held-turn-card-contract.ts`) is untouched, and it is still the
 * ONE authority for "what a held turn owes" — the fixture suite and the
 * transcript DOM test evaluate the same projection against the same row.
 *
 * The two obligations are unchanged:
 *
 *   DURABLE. A start that PARKS the run must carry the runId and the parked
 *   status as a persisted payload. That payload is what a reloaded transcript
 *   rebuilds the card from; without it the card can only exist for as long as
 *   the stream does.
 *
 *   NO DECISION-PATH POINTER. Nothing the start says may tell the person to go
 *   somewhere else to confirm, skip or approve. The ban targets the decision
 *   path, never the noun: naming the run page is fine, sending the decision
 *   there is not.
 *
 * WHAT THIS SUITE DOES NOT PROVE, said plainly. It does not park a real run.
 * `agent_run` is substituted to answer `pending_input`, so what is proven here
 * is the START BOUNDARY's contract over a parked answer. A real park needs a
 * live Postgres and a queue, which this tier has neither of; the run reaching
 * `pending_input` for real is owned by the recommendation-hold integration suite
 * and by the stream route's own hold suite. The seam between them is closed by
 * the PASSTHROUGH cases below: the boundary is proven to COPY the primitive's
 * status rather than derive one, so a real hold produces exactly the shape
 * asserted here.
 */
import { describe, expect, it, vi } from "vitest";

const frame: { store: Record<string, unknown> | undefined } = { store: undefined };
vi.mock("@cinatra-ai/mcp-server", () => ({
  mcpRequestContextStorage: { getStore: () => frame.store },
}));
vi.mock("@cinatra-ai/mcp-client", () => ({
  createInProcessPrimitiveTransport: vi.fn(),
  invokePrimitive: vi.fn(),
}));

import {
  HELD_TURN_ROW,
  evaluateHeldTurnProjection,
  findDecisionPathPointers,
  isHeldDispatch,
  type TurnProjection,
} from "@/lib/lifecycle/held-turn-card-contract";
import { handleNamedAgentStart } from "../named-agent-start-mcp";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

const PERSON = { userId: "usr_1", orgId: "org_1" };
const PACKAGE = "@cinatra-ai/proof-agent";

const OWN_CREDENTIAL = {
  actor: { actorType: "human", source: "agent", userId: PERSON.userId, orgId: PERSON.orgId },
  orgId: PERSON.orgId,
  roleHints: { actorOrganizationId: PERSON.orgId, orgRole: "member", platformRole: "member", teamIds: [], projectGrants: [] },
} as unknown as ReviewActorContext;

function deps(answer: Record<string, unknown>) {
  return {
    readFrame: () => ({ ...PERSON, humanPresent: true as const }),
    resolveActor: vi.fn(async () => OWN_CREDENTIAL),
    invoke: vi.fn(async () => answer),
  };
}

async function start(answer: Record<string, unknown>) {
  return handleNamedAgentStart({ packageName: PACKAGE }, deps(answer) as never);
}

/**
 * The turn as the transcript will receive it. The primitive's own answer IS the
 * durable tool result — one part, preserved verbatim. `nodes` is empty: the
 * server renders nothing, so the DOM arm of the contract is vacuous here and is
 * held by the transcript test instead.
 */
function projectionFromResult(res: { content: { text: string }[] }): TurnProjection {
  return {
    parts: [
      {
        kind: "tool_result",
        slot: 0,
        name: "agent_named_start",
        result: res.content[0]?.text ?? null,
      },
    ],
    nodes: [],
  };
}

describe("a HELD start (pending_input)", () => {
  it("carries the runId and the parked status as a durable payload", async () => {
    const res = await start({ runId: "run-held-1", status: "pending_input" });
    const payload = res.structuredContent as { runId?: string; status?: string };
    expect(payload).toMatchObject({ runId: "run-held-1", status: "pending_input" });
    expect(isHeldDispatch(payload)).toBe(true);
    // DURABLE: the same payload is in the tool result's TEXT, which is what a
    // reloaded transcript rebuilds the card from — not a label a reader has to
    // parse back out of prose.
    expect(JSON.parse(res.content[0].text)).toMatchObject({
      runId: "run-held-1",
      status: "pending_input",
    });
  });

  it("says nothing that presents another surface as the decision path", async () => {
    const res = await start({ runId: "run-held-2", status: "pending_input" });
    const hits = findDecisionPathPointers(res.content[0].text);
    expect(
      hits,
      `the start's answer presents another surface as the decision path: ${JSON.stringify(res.content[0].text)}`,
    ).toEqual([]);
  });

  it("satisfies the held-turn contract's server-side arm as a whole", async () => {
    const res = await start({ runId: "run-held-3", status: "pending_input" });
    // THE SERVER-SIDE ARM, and only that arm. This projection has no DOM by
    // construction, so the mount obligation is named off here rather than
    // asserted against a caller that structurally cannot satisfy it. The mount
    // is proven where the DOM is, by the chat package's transcript suite.
    const violations = evaluateHeldTurnProjection(
      projectionFromResult(res),
      HELD_TURN_ROW,
      { requireMount: false },
    );
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});

describe("the status is the PRIMITIVE's, with exactly one named default", () => {
  // This is what makes the substituted answer above stand for a real one: a
  // status the primitive reports reaches the transcript unchanged. THE ONE
  // EXCEPTION, pinned rather than glossed: an ABSENT status becomes `queued`.
  it.each(["pending_input", "queued", "running", "some_future_status"])(
    "passes %s straight through to the durable payload",
    async (status) => {
      const res = await start({ runId: "run-pt", status });
      expect(JSON.parse(res.content[0].text)).toEqual({ ok: true, runId: "run-pt", status });
    },
  );

  it("defaults an ABSENT status to queued, and never to a held one", async () => {
    const res = await start({ runId: "run-nostatus" });
    const payload = res.structuredContent as { status?: string };
    expect(payload.status).toBe("queued");
    // The default can never invent a hold: a card mounted off a manufactured
    // `pending_input` would be a screen with no run behind it.
    expect(isHeldDispatch(payload)).toBe(false);
  });
});

describe("a NON-held start (queued) — the same two obligations, as regression", () => {
  it("keeps the durable result and the pointer-free answer", async () => {
    const res = await start({ runId: "run-q-1", status: "queued" });
    expect(res.structuredContent).toMatchObject({ runId: "run-q-1", status: "queued" });
    expect(findDecisionPathPointers(res.content[0].text)).toEqual([]);
  });
});

describe("the failure paths answer without a decision-path pointer", () => {
  it("the platform's own refusal is relayed and carries no pointer", async () => {
    const res = await start({ error: "Template not found: @cinatra-ai/proof-agent" });
    expect(res.structuredContent).toMatchObject({ ok: false });
    expect(findDecisionPathPointers(res.content[0].text)).toEqual([]);
  });
});
