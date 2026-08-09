import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// cinatra#2568 (epic #2564 S4) — the recommendation hold's LIVE-STATE SNAPSHOT
// and the STALE-HOLD FILTER on the AG-UI SSE route.
//
// The durable log is not the authority on whether a run is held: a run can be
// parked, decided, dispatched and parked AGAIN, so its log can carry several
// hold announcements of which at most one is live. This route therefore
//   (a) synthesizes the run's CURRENT hold from the park at stream open, and
//   (b) forwards a hold frame from the log ONLY when the park still confirms it.
//
// These tests read the actual SSE bytes the route emits, so they pin the wire
// and not an intermediate helper's return value.
// ---------------------------------------------------------------------------

const requireAuthSession = vi.fn();
const isPlatformAdmin = vi.fn();
const readAgentRunById = vi.fn();
const subscribeToAgUiEventsWithId = vi.fn();
const deriveRecommendationHoldInterrupt = vi.fn();
const readRecommendationHoldFromEvent = vi.fn();
const declaresLifecycleInteraction = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: () => requireAuthSession(),
  isPlatformAdmin: (s: unknown) => isPlatformAdmin(s),
}));
vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  deriveRecommendationHoldInterrupt: (...a: unknown[]) =>
    deriveRecommendationHoldInterrupt(...a),
  readRecommendationHoldFromEvent: (...a: unknown[]) =>
    readRecommendationHoldFromEvent(...a),
  declaresLifecycleInteraction: (...a: unknown[]) => declaresLifecycleInteraction(...a),
  recommendationHoldThreadId: (run: { id: string; templateId?: string | null }) =>
    run.templateId && run.templateId.length > 0 ? run.templateId : run.id,
}));
vi.mock("@cinatra-ai/agent-ui-protocol/server", () => ({
  subscribeToAgUiEventsWithId: (...a: unknown[]) => subscribeToAgUiEventsWithId(...a),
}));

import { GET } from "../route";

function ctx(runId: string) {
  return { params: Promise.resolve({ runId }) };
}
function streamReq(headers?: Record<string, string>): Request {
  return new Request("https://app.test/api/agents/runs/run-1/stream", { headers });
}

/** The SSE frames the route actually wrote, parsed back into events. */
async function drain(res: Response): Promise<Record<string, unknown>[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  // The route's ReadableStream closes once the (finite) subscription generator
  // is exhausted, so a plain read-to-end terminates.
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  return raw
    .split("\n\n")
    .map((chunk) => chunk.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => Boolean(l) && !l!.startsWith("data: :"))
    .map((l) => JSON.parse(l.slice("data: ".length)) as Record<string, unknown>);
}

function holdResumeFrame(holdId: string) {
  return {
    type: "RESUME",
    threadId: "tpl-1",
    runId: "run-1",
    reviewTaskId: "recommendation:run-start:run-1",
    interaction: { kind: "recommendation_hold", schemaVersion: 1, ref: `ref-${holdId}` },
  };
}

function holdFrame(holdId: string) {
  return {
    type: "INTERRUPT",
    threadId: "tpl-1",
    runId: "run-1",
    schema: {},
    xRenderer: "@cinatra-ai/lifecycle:recommendation-hold",
    values: {},
    reviewTaskId: "recommendation:run-start:run-1",
    interaction: { kind: "recommendation_hold", schemaVersion: 1, ref: `ref-${holdId}` },
  };
}

/** Stand-in presence check — the real one is a field-presence test. */
function declaresReal(event: unknown): boolean {
  const i = (event as { interaction?: unknown }).interaction;
  return typeof i === "object" && i !== null && !Array.isArray(i);
}

/** Stand-in decode: the route only needs "which hold does this frame name". */
function decodeHoldFrame(event: unknown, runId: string) {
  const ref = (event as { interaction?: { kind?: string; ref?: string } }).interaction;
  if (!ref || ref.kind !== "recommendation_hold" || typeof ref.ref !== "string") return null;
  return { runId, holdId: ref.ref.replace(/^ref-/, "") };
}

const HELD_RUN = { id: "run-1", templateId: "tpl-1", status: "pending_input" };

describe("the hold's live-state snapshot on the SSE route", () => {
  beforeEach(() => {
    isPlatformAdmin.mockReturnValue(false);
    requireAuthSession.mockResolvedValue({
      user: { id: "user-1" },
      session: { activeOrganizationId: "org-1" },
    });
    readAgentRunById.mockResolvedValue({ ...HELD_RUN });
    subscribeToAgUiEventsWithId.mockImplementation(async function* () {
      /* no log events unless a test provides them */
    });
    deriveRecommendationHoldInterrupt.mockResolvedValue(null);
    readRecommendationHoldFromEvent.mockImplementation(decodeHoldFrame);
    declaresLifecycleInteraction.mockImplementation(declaresReal);
  });
  afterEach(() => vi.clearAllMocks());

  it("emits the CURRENT hold as the first frame for a late joiner", async () => {
    deriveRecommendationHoldInterrupt.mockResolvedValue(holdFrame("park-current"));

    const frames = await drain(await GET(streamReq(), ctx("run-1")));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "INTERRUPT",
      interaction: { kind: "recommendation_hold" },
    });
    // Derived from the run's CURRENT state, with the run's own thread identity.
    expect(deriveRecommendationHoldInterrupt).toHaveBeenCalledWith({
      runId: "run-1",
      threadId: "tpl-1",
    });
  });

  it("emits NO hold frame when the run is not held", async () => {
    deriveRecommendationHoldInterrupt.mockResolvedValue(null);
    const frames = await drain(await GET(streamReq(), ctx("run-1")));
    expect(frames).toHaveLength(0);
  });

  it("reconstructs the hold on a Last-Event-ID RECONNECT too", async () => {
    deriveRecommendationHoldInterrupt.mockResolvedValue(holdFrame("park-current"));
    const frames = await drain(
      await GET(streamReq({ "last-event-id": "17-0" }), ctx("run-1")),
    );
    expect(frames).toHaveLength(1);
    // The resume cursor is honoured for the LOG; the snapshot rides alongside.
    expect(subscribeToAgUiEventsWithId).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ fromId: "17-0" }),
    );
  });

  it("the synthesized frame carries NO SSE id — it must not become the cursor", async () => {
    deriveRecommendationHoldInterrupt.mockResolvedValue(holdFrame("park-current"));
    const res = await GET(streamReq(), ctx("run-1"));
    const raw = await new Response(res.body).text();
    const firstChunk = raw.split("\n\n")[0];
    expect(firstChunk.startsWith("data: ")).toBe(true);
    expect(firstChunk).not.toContain("id: ");
  });

  it("a failing snapshot degrades to no card, never to a stream error", async () => {
    deriveRecommendationHoldInterrupt.mockRejectedValue(new Error("park store down"));
    const res = await GET(streamReq(), ctx("run-1"));
    expect(res.status).toBe(200);
    expect(await drain(res)).toHaveLength(0);
  });
});

describe("the stale-hold filter over replayed history", () => {
  beforeEach(() => {
    isPlatformAdmin.mockReturnValue(false);
    requireAuthSession.mockResolvedValue({
      user: { id: "user-1" },
      session: { activeOrganizationId: "org-1" },
    });
    readAgentRunById.mockResolvedValue({ ...HELD_RUN, status: "pending_approval" });
    readRecommendationHoldFromEvent.mockImplementation(decodeHoldFrame);
    declaresLifecycleInteraction.mockImplementation(declaresReal);
  });
  afterEach(() => vi.clearAllMocks());

  it("DROPS a decided hold replayed out of the log (a re-parked run shows only its current hold)", async () => {
    // The run is parked AGAIN under park-2; the log still carries park-1's
    // announcement from the first hold.
    deriveRecommendationHoldInterrupt.mockResolvedValue(holdFrame("park-2"));
    subscribeToAgUiEventsWithId.mockImplementation(async function* () {
      yield { id: "1-0", event: holdFrame("park-1") };
      yield { id: "2-0", event: holdFrame("park-2") };
    });

    const frames = await drain(await GET(streamReq(), ctx("run-1")));

    const holdIds = frames.map(
      (f) => (f as { interaction?: { ref?: string } }).interaction?.ref,
    );
    // The snapshot, then the live park-2 frame. park-1 never reaches the client.
    expect(holdIds).toEqual(["ref-park-2", "ref-park-2"]);
  });

  it("DROPS every hold frame when the run is no longer held at all", async () => {
    deriveRecommendationHoldInterrupt.mockResolvedValue(null);
    subscribeToAgUiEventsWithId.mockImplementation(async function* () {
      yield { id: "1-0", event: holdFrame("park-1") };
    });

    expect(await drain(await GET(streamReq(), ctx("run-1")))).toHaveLength(0);
  });

  it("FORWARDS a hold minted while the stream was already open", async () => {
    // Open on an unheld run, then the park appears mid-stream: the route
    // re-reads the park and finds the new hold confirmed.
    deriveRecommendationHoldInterrupt
      .mockResolvedValueOnce(null) // at open: not held
      .mockResolvedValue(holdFrame("park-new")); // on the re-check
    subscribeToAgUiEventsWithId.mockImplementation(async function* () {
      yield { id: "1-0", event: holdFrame("park-new") };
    });

    const frames = await drain(await GET(streamReq(), ctx("run-1")));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ interaction: { ref: "ref-park-new" } });
  });

  it("leaves ORDINARY interrupts and every other event untouched", async () => {
    deriveRecommendationHoldInterrupt.mockResolvedValue(null);
    subscribeToAgUiEventsWithId.mockImplementation(async function* () {
      yield {
        id: "1-0",
        event: {
          type: "INTERRUPT",
          threadId: "tpl-1",
          runId: "run-1",
          schema: {},
          xRenderer: "@vendor/agent:confirm",
          values: {},
          reviewTaskId: "rt-1",
        },
      };
      yield { id: "2-0", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "hi" } };
      yield { id: "3-0", event: { type: "RUN_FINISHED", threadId: "tpl-1", runId: "run-1" } };
    });

    const frames = await drain(await GET(streamReq(), ctx("run-1")));
    expect(frames.map((f) => f.type)).toEqual([
      "INTERRUPT",
      "TEXT_MESSAGE_CONTENT",
      "RUN_FINISHED",
    ]);
    // The pending_approval 0-0 replay contract is unmoved.
    expect(subscribeToAgUiEventsWithId).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ fromId: "0-0" }),
    );
  });
});

describe("a lifecycle RESUME retires exactly the hold it names", () => {
  beforeEach(() => {
    isPlatformAdmin.mockReturnValue(false);
    requireAuthSession.mockResolvedValue({
      user: { id: "user-1" },
      session: { activeOrganizationId: "org-1" },
    });
    readAgentRunById.mockResolvedValue({ ...HELD_RUN });
    readRecommendationHoldFromEvent.mockImplementation(decodeHoldFrame);
    declaresLifecycleInteraction.mockImplementation(declaresReal);
  });
  afterEach(() => vi.clearAllMocks());

  it("FORWARDS the resume of a hold the park agrees is over", async () => {
    deriveRecommendationHoldInterrupt.mockResolvedValue(null); // not held now
    subscribeToAgUiEventsWithId.mockImplementation(async function* () {
      yield { id: "1-0", event: holdResumeFrame("park-1") };
    });

    const frames = await drain(await GET(streamReq(), ctx("run-1")));
    expect(frames.map((f) => f.type)).toEqual(["RESUME"]);
  });

  it("DROPS a stale resume while the run is waiting on a DIFFERENT hold", async () => {
    // park-2 is live; park-1's resume is history. Forwarding it would clear the
    // card of a hold the run is still waiting on.
    deriveRecommendationHoldInterrupt.mockResolvedValue(holdFrame("park-2"));
    subscribeToAgUiEventsWithId.mockImplementation(async function* () {
      yield { id: "1-0", event: holdResumeFrame("park-1") };
    });

    const frames = await drain(await GET(streamReq(), ctx("run-1")));
    expect(frames.map((f) => f.type)).toEqual(["INTERRUPT"]); // the snapshot only
  });

  it("DROPS the resume of the hold that is still live (a duplicate/early frame)", async () => {
    deriveRecommendationHoldInterrupt.mockResolvedValue(holdFrame("park-1"));
    subscribeToAgUiEventsWithId.mockImplementation(async function* () {
      yield { id: "1-0", event: holdResumeFrame("park-1") };
    });

    const frames = await drain(await GET(streamReq(), ctx("run-1")));
    expect(frames.map((f) => f.type)).toEqual(["INTERRUPT"]);
  });

  it("leaves an ORDINARY resume alone", async () => {
    deriveRecommendationHoldInterrupt.mockResolvedValue(null);
    subscribeToAgUiEventsWithId.mockImplementation(async function* () {
      yield { id: "1-0", event: { type: "RESUME", threadId: "tpl-1", runId: "run-1" } };
    });
    const frames = await drain(await GET(streamReq(), ctx("run-1")));
    expect(frames.map((f) => f.type)).toEqual(["RESUME"]);
  });
});

describe("presence gates, validity permits", () => {
  beforeEach(() => {
    isPlatformAdmin.mockReturnValue(false);
    requireAuthSession.mockResolvedValue({
      user: { id: "user-1" },
      session: { activeOrganizationId: "org-1" },
    });
    readAgentRunById.mockResolvedValue({ ...HELD_RUN, status: "pending_approval" });
    declaresLifecycleInteraction.mockImplementation(declaresReal);
    deriveRecommendationHoldInterrupt.mockResolvedValue(null);
  });
  afterEach(() => vi.clearAllMocks());

  it("DROPS a declared lifecycle frame whose ref does not decode (rotated secret / forgery)", async () => {
    // The frame says "lifecycle interaction" but nothing can be made of it.
    // Forwarding it would deliver it to clients as an ordinary review gate.
    readRecommendationHoldFromEvent.mockReturnValue(null);
    subscribeToAgUiEventsWithId.mockImplementation(async function* () {
      yield { id: "1-0", event: holdFrame("park-1") };
      yield { id: "2-0", event: holdResumeFrame("park-1") };
    });

    expect(await drain(await GET(streamReq(), ctx("run-1")))).toHaveLength(0);
  });
});
