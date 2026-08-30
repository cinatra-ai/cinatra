// @vitest-environment jsdom
/**
 * THE PAGE THAT WAS ALREADY OPEN (cinatra#3051).
 *
 * A person opens a widget panel on a third-party page, asks for something, and
 * a run is released a few minutes later. Until this leg, that run reached
 * nowhere: the column's transcript was read ONCE, before the run existed, and
 * nothing after the mount could ever add to it. The reader sat looking at a
 * conversation the server had already moved on from, and only a reload — which
 * on a widget also costs the whole sign-in — would show it.
 *
 * So this is the acceptance, driven through the shipped path: the same
 * `fetchThreadMessages` the restore uses, the same bounded cadence the lifecycle
 * cards use, and the column's own real adoption rule. What is doubled is the
 * PRESENTATION (a list of message ids) and the things that would need a browser
 * to be real (the bridge, the sign-in popup, the negotiation) — never the seam
 * under test.
 *
 * The measurement is a COUNT OF READS, not a wall-clock wait: what has to be
 * true is that the column keeps asking and stops at the belt, and counting the
 * asks says that exactly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { BOUNDED_LOOK_LIMIT, boundedLookDelay } from "@cinatra-ai/agents/lifecycle-card-runtime";

const THREAD_ID = "thread-3051";

/** What the server answers on each look, oldest reading first; the last one
 *  repeats once the script runs out. */
let readings: Array<Array<{ id: string; role: "user" | "assistant"; content: string }> | null> = [];
let reads = 0;

const fetchThreadMessages = vi.fn(async () => {
  const answer = readings[Math.min(reads, readings.length - 1)] ?? null;
  reads += 1;
  return answer;
});

vi.mock("@cinatra-ai/chat/conversation-services", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@cinatra-ai/chat/conversation-services")
  >();
  return {
    ...actual,
    fetchThreadMessages: (...a: unknown[]) => fetchThreadMessages(...(a as [])),
    saveThreadTranscript: async () => true,
  };
});

// The PRESENTATION is doubled — a list of the ids the column holds — because
// what this proves is which messages reach the mounted column, not how a bubble
// is drawn. The TURN ENGINE is the real one: its adoption rule is the seam
// under test and must not be stood in for.
vi.mock("@cinatra-ai/chat/conversation-column", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@cinatra-ai/chat/conversation-column")
  >();
  return {
    ...actual,
    ConversationColumn: ({ messages }: { messages: Array<{ id: string }> }) => (
      <ul data-testid="column">
        {messages.map((m) => (
          <li key={m.id} data-message-id={m.id} />
        ))}
      </ul>
    ),
  };
});

vi.mock("@cinatra-ai/chat/brokered-composer-inputs", () => ({
  useBrokeredComposerInputs: () => ({
    mentionables: [],
    onAttachmentsSelected: () => {},
    composerNotice: null,
    takePendingAttachments: () => undefined,
    autosave: undefined,
  }),
}));

// The bridge is a real browser transport; the only thing this test needs from
// it is the ONE context message, so the double hands it straight over.
let deliverContext: ((context: unknown) => void) | null = null;
vi.mock("@/lib/embed/embed-bridge.client", () => ({
  installEmbedBridge: ({ onContext }: { onContext: (c: unknown) => void }) => {
    deliverContext = onContext;
    return { postReady: () => {}, dispose: () => {}, sendResize: () => {}, sendApplyIntent: () => {} };
  },
}));

vi.mock("./../embed-chat-negotiate", () => ({
  negotiateEmbedChatContract: async () => ({ ok: true }),
}));

vi.mock("@/lib/embed/frame-widget-session.client", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/embed/frame-widget-session.client")
  >();
  return {
    ...actual,
    runFrameSignIn: async () => ({
      ok: true,
      credential: { userToken: "cwu_x", transportToken: "cit_x", expiresIn: 900 },
    }),
    // The renewal has its own suite; here it must simply not fire, so nothing
    // this test measures is a renewal's read.
    frameCredentialRenewDelayMs: () => null,
  };
});

vi.mock("@/components/ui/button", () => ({
  Button: (props: Record<string, unknown>) => <button {...props} />,
}));

import { EmbedAssistantClient, planNextLook } from "../embed-assistant-client";

/** The resting pace, restated here ONLY as the test's own reading of it. */
const RESTING_LOOK_DELAY_MS = 60_000;

const PARENT_ORIGIN = "https://blog.example.test";

const CONTEXT = {
  session: { threadId: THREAD_ID, assistant: "wordpress" },
  site: { siteId: "site-1" },
};

/** What the thread held when the panel opened: the person's question, and no
 *  run at all. */
const BEFORE_THE_RUN = [{ id: "u1", role: "user" as const, content: "please run it" }];
/** What the server holds once the run has been released. */
const AFTER_THE_RUN = [
  ...BEFORE_THE_RUN,
  { id: "a-run-1", role: "assistant" as const, content: "the run's turn" },
];

/** Mount, hand the frame its context, and take it through the sign-in the way a
 *  person does — one gesture — so the column mounts on the restored transcript. */
async function openThePanel() {
  render(
    <EmbedAssistantClient
      expectedParentOrigin={PARENT_ORIGIN}
      assistant="wordpress"
      instanceId="inst-1"
    />,
  );
  await act(async () => {
    deliverContext?.(CONTEXT);
  });
  await act(async () => {
    screen.getByText("Sign in").click();
    await Promise.resolve();
  });
  // The restore's own round trip settles here, so the column is mounted and
  // seeded before anything below counts a look. Flushed rather than waited for:
  // this suite drives the cadence on fake timers, and a real-timer `waitFor`
  // would never come back.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Let the chain take exactly `n` further looks. */
async function takeLooks(n: number) {
  for (let i = 0; i < n; i += 1) {
    const before = reads;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(boundedLookDelay(before) + 1);
    });
  }
}

/** jsdom has no ResizeObserver, and the frame's resize uplink installs one at
 *  mount. It reports a height to the host and plays no part in anything below. */
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = NoopResizeObserver;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  reads = 0;
  readings = [];
  deliverContext = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a column mounted BEFORE the run exists", () => {
  it("takes the run's turn into the SAME open column, with no reload and no remount", async () => {
    // The restore reads the thread as it was: one question, no run.
    readings = [BEFORE_THE_RUN, AFTER_THE_RUN];
    await openThePanel();

    const column = screen.getByTestId("column");
    expect(column.querySelectorAll("[data-message-id]")).toHaveLength(1);

    // The run is released now — after the column was already on screen.
    await takeLooks(1);

    // THE SAME DOM NODE. Not a new column, not a remounted one: the identical
    // element, one message longer. A remount here would have thrown away
    // whatever the reader had done in the meantime.
    expect(screen.getByTestId("column")).toBe(column);
    expect([...column.querySelectorAll("[data-message-id]")].map((n) =>
      n.getAttribute("data-message-id"),
    )).toEqual(["u1", "a-run-1"]);
  });

  it("keeps looking after looks that answered NOTHING", async () => {
    // Three refused/failed reads — a 401, an outage, a body that did not parse
    // all arrive here as `null` — and then the run.
    readings = [BEFORE_THE_RUN, null, null, null, AFTER_THE_RUN];
    await openThePanel();
    const column = screen.getByTestId("column");

    await takeLooks(4);

    // A completed look re-arms the next one whatever it answered; only the belt
    // ends the chain. That is exactly the state a further look exists to climb
    // out of.
    expect(column.querySelectorAll("[data-message-id]")).toHaveLength(2);
  });

  it("SLOWS TO THE RESTING PACE past the shared belt — it does not stop asking", async () => {
    // The convergence round's first finding: the belt is sixty looks in about
    // eight and a half minutes, and the defect this leg exists for is a review
    // released twenty minutes after the column opened. A belt that ENDED the
    // looking would have left that case exactly as broken as it was.
    readings = [BEFORE_THE_RUN, null];
    await openThePanel();
    const afterRestore = reads;

    await takeLooks(BOUNDED_LOOK_LIMIT);
    expect(reads - afterRestore).toBe(BOUNDED_LOOK_LIMIT);

    // Past the belt the fast cadence is spent, so nothing is asked at its pace.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(boundedLookDelay(BOUNDED_LOOK_LIMIT) + 1);
    });
    expect(reads - afterRestore).toBe(BOUNDED_LOOK_LIMIT);

    // A minute later the column asks again — and goes on asking, for as long as
    // the panel is open.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESTING_LOOK_DELAY_MS);
    });
    expect(reads - afterRestore).toBe(BOUNDED_LOOK_LIMIT + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESTING_LOOK_DELAY_MS);
    });
    expect(reads - afterRestore).toBe(BOUNDED_LOOK_LIMIT + 2);
  });

  it("takes a run released long after the belt was spent", async () => {
    // The reported case, end to end and in the same open column: the panel is
    // opened, nothing happens for the whole fast cadence and a while after it,
    // and THEN the run is released.
    readings = [BEFORE_THE_RUN, null];
    await openThePanel();
    const column = screen.getByTestId("column");
    await takeLooks(BOUNDED_LOOK_LIMIT);
    expect(column.querySelectorAll("[data-message-id]")).toHaveLength(1);

    // Twenty minutes of an untouched page, and the run arrives in the middle of
    // them.
    readings = [AFTER_THE_RUN];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESTING_LOOK_DELAY_MS + 1);
    });

    expect(screen.getByTestId("column")).toBe(column);
    expect([...column.querySelectorAll("[data-message-id]")].map((n) =>
      n.getAttribute("data-message-id"),
    )).toEqual(["u1", "a-run-1"]);
  });

  it("arms the FAST cadence again when the person comes back to the page", async () => {
    readings = [BEFORE_THE_RUN, null];
    await openThePanel();
    const afterRestore = reads;
    await takeLooks(BOUNDED_LOOK_LIMIT);

    // Returning focus is the moment a reader is most likely to be waiting on
    // something. It used to need a reload — which on a widget costs the whole
    // sign-in.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(boundedLookDelay(0) + 1);
    });
    expect(reads - afterRestore).toBe(BOUNDED_LOOK_LIMIT + 1);
  });
});

// ---------------------------------------------------------------------------
// THE LOOK POLICY ITSELF (the convergence round's findings 1 and 5).
//
// The chain above spends this function; asserting it directly is what makes the
// two rules that are invisible from the outside checkable — a look is never
// spent while a turn owns the list, and the belt slows the looking rather than
// ending it.
// ---------------------------------------------------------------------------
describe("planNextLook", () => {
  it("spends the shared cadence inside the belt", () => {
    expect(planNextLook(0, false)).toEqual({ read: true, delay: boundedLookDelay(0) });
    expect(planNextLook(20, false)).toEqual({ read: true, delay: boundedLookDelay(20) });
  });

  it("COSTS NO LOOK while a turn is streaming into the list", () => {
    // The column's adoption rule refuses every reading while a turn is live, so
    // a look taken then is thrown away — and spent off a bounded belt.
    expect(planNextLook(3, true).read).toBe(false);
    expect(planNextLook(BOUNDED_LOOK_LIMIT - 1, true).read).toBe(false);
  });

  it("keeps asking at the RESTING pace once the belt is spent", () => {
    expect(planNextLook(BOUNDED_LOOK_LIMIT, false)).toEqual({
      read: true,
      delay: RESTING_LOOK_DELAY_MS,
    });
    expect(planNextLook(BOUNDED_LOOK_LIMIT + 40, false).read).toBe(true);
  });
});
