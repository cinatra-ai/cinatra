// @vitest-environment jsdom
/**
 * THE MID-AWAIT THREAD SWITCH IN `editAndResend` (cinatra#2823 S9j).
 *
 * The edit flow now AWAITs its truncation-intent save before it truncates
 * anything. That is right, and it added a suspension point the code did not
 * have before. Everything after the await used to be reached
 * synchronously from the click; now the user can select another thread while
 * the POST (or its in-slot retry) is still open, and the continuation resumes
 * against WHATEVER thread is active then.
 *
 * So the arms below drive the real switch — the `cinatra:chat:select` event the
 * thread panel dispatches — while the intent save is held open BY HAND, exactly
 * as the round-5 chain arms hold a save open in `chat-persistence.test.ts`.
 * There is no sleep and no scheduling luck: the release happens where the arm
 * says it happens.
 *
 * WHAT THE GUARD PROMISES. The intent save has already landed by then, so the
 * truncation IS durably recorded and thread A comes back truncated on its next
 * load. What must not happen is the rest of the flow landing on thread B: B's
 * transcript must not be replaced by A's, no turn may be dispatched, and B's
 * own persistence must not save A's transcript under B's id. The failure branch
 * owes the same: the save-error bubble belongs to the thread the edit was made
 * in, not to whatever the user is reading now.
 *
 * `streamAgUiResponse` already guards its delayed stream updates this way
 * (`stillOnOriginThread`), so this is that discipline applied to the one other
 * place in the file that now resumes after an await.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

// --- the modules the mounted page reaches that belong to the SERVER ----------
// Replaced exactly as the other mounted-column suites in this directory replace
// them, and for the same reason: their graphs reach the server runtime, so
// without these the lazy list chunk never evaluates and nothing mounts at all.

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: null, isPending: false }) },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

// Slack-mode routing is the OTHER await this flow resumes from, so the stub is
// held open by hand exactly as the save is. It answers at once unless an arm
// parks it, which keeps every non-Slack arm free of routing timing.
type Routing = { shouldCallLlm?: boolean; externalMentions?: unknown[]; activeHandle?: string };
type RoutingGate = { resolve: (r: Routing) => void; reject: (e: unknown) => void };
const routing = {
  hold: false,
  gate: null as RoutingGate | null,
};
vi.mock("../actions", () => ({
  resolveMessageRouting: vi.fn(async () => {
    if (!routing.hold) return { shouldCallLlm: true };
    return new Promise<Routing>((resolve, reject) => {
      routing.gate = { resolve, reject };
    });
  }),
  setAssistantPauseState: vi.fn(async () => undefined),
  extractHitlGateValuesAction: vi.fn(async () => ({})),
}));

vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));

vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
  getSkillsForAgentAction: vi.fn(async () => []),
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: async () => ({ rows: [] }),
  decidePendingToolCall: async () => ({ ok: true }),
}));

vi.mock("../undo-actions", () => ({
  recentUndoableChangeSetForRunAction: async () => ({ changeSetId: null }),
}));

vi.mock("@/components/data-safety/undo-toast", () => ({
  undoDeepLink: (id: string) => `/objects?undo=${id}`,
}));

vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => (
    <div data-inline-run-card={runId} />
  ),
}));

// The AG-UI turn driver is the DISPATCH this suite has to observe — a turn that
// reaches it has been dispatched, whatever the wire then does. Everything else
// in `ag-ui-chat-client` stays REAL, the save chain above all: the ordering the
// guard sits on top of is the round-5 chain, and a stubbed chain would not have
// the suspension point this suite exists for.
const driveCalls: Array<{ threadId: string; messages: Array<{ role: string; content: string }> }> = [];
vi.mock("../ag-ui-chat-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ag-ui-chat-client")>();
  return {
    ...actual,
    ensureAssistantChatWireNegotiated: vi.fn(async () => true),
    driveAssistantChatTurn: vi.fn(async (req: { threadId: string; messages: Array<{ role: string; content: string }> }) => {
      driveCalls.push({ threadId: req.threadId, messages: req.messages });
    }),
  };
});

// Some Node builds expose a global `localStorage` that SHADOWS jsdom's and
// throws on use, which the composer's prompt field reads on mount. Repair it
// only when it is actually broken.
if (typeof window !== "undefined" && typeof window.localStorage?.getItem !== "function") {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

// ---------------------------------------------------------------------------
// The two threads, and a network whose SAVES are released by hand.
// ---------------------------------------------------------------------------

const THREAD_A = "thr-edit-origin";
const THREAD_B = "thr-elsewhere";
const THREAD_S = "thr-edit-origin-slack";

const SUMMARIES = [
  { id: THREAD_A, title: "Origin", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
  { id: THREAD_B, title: "Elsewhere", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z" },
  { id: THREAD_S, title: "Origin (Slack)", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-04T00:00:00.000Z" },
];

const BODIES: Record<string, unknown> = {
  [THREAD_A]: {
    ...SUMMARIES[0],
    messages: [
      { id: "a-u1", role: "user", content: "alpha question" },
      { id: "a-a1", role: "assistant", content: "alpha answer" },
    ],
  },
  [THREAD_B]: {
    ...SUMMARIES[1],
    messages: [
      { id: "b-u1", role: "user", content: "bravo question" },
      { id: "b-a1", role: "assistant", content: "bravo answer" },
    ],
  },
  // The same edit, in the mode whose regeneration goes through routing.
  [THREAD_S]: {
    ...SUMMARIES[2],
    slackMode: true,
    messages: [
      { id: "s-u1", role: "user", content: "alpha question" },
      { id: "s-a1", role: "assistant", content: "alpha answer" },
    ],
  },
};

type SavePost = { id: string; messages: Array<{ id: string; role: string; content: string }>; removedMessageIds?: string[] };

/**
 * The `/chat` network for a mounted page: reads answer at once, and every
 * thread SAVE is parked until the arm releases it. That is the whole point —
 * the suspension the round-5 await introduced only exists while a save is open.
 */
let openNetwork: { drainAll: () => Promise<void> } | null = null;

function chatNetwork() {
  const saves: SavePost[] = [];
  const release: Array<(res: Response) => void> = [];
  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u === "/api/assistants/threads" && init?.method === "POST") {
      saves.push(JSON.parse(String(init.body)) as SavePost);
      return new Promise<Response>((resolve) => release.push(resolve));
    }
    if (u === "/api/assistants/threads") return new Response(JSON.stringify(SUMMARIES));
    const byId = u.match(/^\/api\/assistants\/threads\/(.+)$/);
    if (byId) return new Response(JSON.stringify(BODIES[byId[1]] ?? null));
    if (u === "/api/assistants/list") return new Response(JSON.stringify([]));
    return new Response("{}");
  });
  vi.stubGlobal("fetch", fetchStub);
  const settled = new Set<number>();
  async function drain() {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  }
  const net = {
    saves,
    /** Settle the Nth issued save; `ok: false` makes it a server rejection. */
    settle(index: number, ok = true) {
      settled.add(index);
      release[index]?.(ok ? new Response("{}") : new Response("no", { status: 503 }));
    },
    pending: () => release.length,
    /** Let every pending microtask run, so anything unblocked is issued. */
    drain,
    /**
     * Release everything still parked. `saveChatThreadInOrder` keeps its chain
     * per thread in MODULE state, which outlives a single arm — a save left
     * hanging here would still be the head of that thread's chain in the next
     * one, and the next arm's intent save would never reach the wire.
     */
    async drainAll() {
      // Releasing a parked save lets the chain POST the one queued behind it,
      // so this repeats until nothing new is issued.
      for (let pass = 0; pass < 8; pass += 1) {
        const before = release.length;
        for (let i = 0; i < release.length; i += 1) {
          if (!settled.has(i)) net.settle(i);
        }
        await drain();
        if (release.length === before) break;
      }
    },
  };
  openNetwork = net;
  return net;
}

async function mountOnOriginThread(threadId: string = THREAD_A) {
  const { ChatPage } = await import("../chat-page");
  const view = render(<ChatPage initialThreadId={threadId} userId="u-1" />);
  await waitFor(() =>
    expect(view.container.querySelector("[data-conversation-list]")).not.toBeNull(),
  );
  await waitFor(() => expect(view.getByText("alpha question")).toBeTruthy());
  return view;
}

/**
 * Edit the origin thread's user turn through the REAL affordance: pencil →
 * draft field → Send. Slack mode routes the pencil through a state request the
 * bubble answers on its next render, so the field is waited for rather than
 * read straight back.
 */
async function editFirstUserTurn(view: ReturnType<typeof render>, text: string) {
  const pencil = view.container.querySelectorAll('[title="Edit message"]')[0];
  expect(pencil, "the edit affordance is not on the mounted turn").toBeTruthy();
  fireEvent.click(pencil);
  await waitFor(() =>
    expect(view.container.querySelector("textarea"), "the edit draft field did not open").not.toBeNull(),
  );
  const textarea = view.container.querySelector("textarea");
  fireEvent.change(textarea as HTMLTextAreaElement, { target: { value: text } });
  fireEvent.click(view.getByText("Send"));
}

/** The thread panel's own switch event — the real path a sidebar click takes. */
function selectThread(threadId: string) {
  window.dispatchEvent(
    new CustomEvent("cinatra:chat:select", { detail: { threadId } }),
  );
}

beforeEach(() => {
  driveCalls.length = 0;
  routing.hold = false;
  routing.gate = null;
});

afterEach(async () => {
  await openNetwork?.drainAll();
  openNetwork = null;
  cleanup();
  vi.unstubAllGlobals();
});

describe("editAndResend resumes on the thread it started on, or not at all", () => {
  it("mid-await switch, SUCCESS path: B keeps its own transcript, and nothing is dispatched on it", async () => {
    const net = chatNetwork();
    const view = await mountOnOriginThread();

    await editFirstUserTurn(view, "alpha question, rephrased");
    // The intent save is on the wire and HELD. Nothing has been truncated yet:
    // that is round 5's promise, and it is what makes the switch reachable.
    await waitFor(() => expect(net.saves.length).toBeGreaterThan(0));
    const intent = net.saves[0];
    expect(intent.id).toBe(THREAD_A);
    expect(intent.removedMessageIds).toEqual(["a-u1", "a-a1"]);

    // The user navigates away while the save is still open.
    selectThread(THREAD_B);
    await waitFor(() => expect(view.getByText("bravo question")).toBeTruthy());

    // ...and only now does the intent land.
    net.settle(0);
    await net.drain();
    await waitFor(() => expect(view.getByText("bravo answer")).toBeTruthy());

    // B still reads as B. The edited prompt never reached its view.
    expect(view.queryByText("alpha question, rephrased")).toBeNull();
    expect(view.queryByText("alpha answer")).toBeNull();
    expect(view.getByText("bravo question")).toBeTruthy();

    // No turn was dispatched — not on B, not on anything.
    expect(driveCalls, "a turn was dispatched after the user left the edited thread").toEqual([]);

    // ...and no save wrote A's transcript under B's id.
    const bSaves = net.saves.filter((s) => s.id === THREAD_B);
    for (const save of bSaves) {
      expect(
        save.messages.map((m) => m.content),
        "a save carried the edited thread's transcript into the thread the user switched to",
      ).not.toContain("alpha question, rephrased");
    }
  });

  it("mid-await switch, FAILURE path: the save-error bubble does not land on B", async () => {
    const net = chatNetwork();
    const view = await mountOnOriginThread();

    await editFirstUserTurn(view, "alpha question, rephrased");
    await waitFor(() => expect(net.saves.length).toBeGreaterThan(0));

    selectThread(THREAD_B);
    await waitFor(() => expect(view.getByText("bravo question")).toBeTruthy());

    // Both attempts fail (the intent save retries once INSIDE its chain slot).
    net.settle(0, false);
    await net.drain();
    await waitFor(() => expect(net.pending()).toBeGreaterThan(1));
    net.settle(1, false);
    await net.drain();

    await waitFor(() => expect(view.getByText("bravo answer")).toBeTruthy());
    expect(
      view.queryByText(/Your edit could not be saved/),
      "the edited thread's save-error bubble was appended to the thread the user switched to",
    ).toBeNull();
    expect(driveCalls).toEqual([]);
  });

  it("NO switch: the edit still truncates and still regenerates, exactly as round 5 left it", async () => {
    const net = chatNetwork();
    const view = await mountOnOriginThread();

    await editFirstUserTurn(view, "alpha question, rephrased");
    await waitFor(() => expect(net.saves.length).toBeGreaterThan(0));
    // Round 5's ordering, unchanged: nothing on the screen until the intent lands.
    expect(view.queryByText("alpha question, rephrased")).toBeNull();

    net.settle(0);
    await net.drain();

    await waitFor(() => expect(view.getByText("alpha question, rephrased")).toBeTruthy());
    expect(view.queryByText("alpha answer")).toBeNull();

    await waitFor(() => expect(driveCalls.length).toBe(1));
    expect(driveCalls[0].threadId).toBe(THREAD_A);
    expect(driveCalls[0].messages.map((m) => m.content)).toEqual([
      "alpha question, rephrased",
    ]);
  });

  // -------------------------------------------------------------------------
  // Slack mode resumes TWICE: once from the intent save, then again from the
  // routing call its regeneration is routed through (codex round 1, finding 1).
  // The second one is the same hole — everything after it is the EDIT's: the
  // assistant handle routing resolved, the push mentions it owes the connector
  // poll, and the turn it dispatches through the LIVE thread ref.
  // -------------------------------------------------------------------------

  it("mid-ROUTING switch: nothing routing resolved lands on the thread the user moved to", async () => {
    const net = chatNetwork();
    routing.hold = true;
    const view = await mountOnOriginThread(THREAD_S);

    await editFirstUserTurn(view, "alpha question, rephrased");
    await waitFor(() => expect(net.saves.length).toBeGreaterThan(0));
    expect(net.saves[0].id).toBe(THREAD_S);

    // The intent lands while the user is still here, so the edit proceeds —
    // and parks on the routing call.
    net.settle(0);
    await net.drain();
    await waitFor(() => expect(routing.gate).not.toBeNull());

    // NOW the user leaves, with routing still open.
    selectThread(THREAD_B);
    await waitFor(() => expect(view.getByText("bravo question")).toBeTruthy());

    routing.gate?.resolve({ shouldCallLlm: true, activeHandle: "@someone-else" });
    await net.drain();
    await waitFor(() => expect(view.getByText("bravo answer")).toBeTruthy());

    expect(
      driveCalls,
      "the edited thread's regeneration was dispatched on the thread the user switched to",
    ).toEqual([]);
    expect(view.queryByText("alpha question, rephrased")).toBeNull();
    for (const save of net.saves.filter((s) => s.id === THREAD_B)) {
      expect(save.messages.map((m) => m.content)).not.toContain("alpha question, rephrased");
    }
  });

  it("mid-ROUTING switch, routing REJECTS: the legacy stream does not land on B either", async () => {
    // A routing failure is swallowed on purpose — the flow falls through to the
    // legacy always-stream with the current assistant context. That fall-through
    // is still the edit's turn, so the switch has to stop it just the same.
    const net = chatNetwork();
    routing.hold = true;
    const view = await mountOnOriginThread(THREAD_S);

    await editFirstUserTurn(view, "alpha question, rephrased");
    await waitFor(() => expect(net.saves.length).toBeGreaterThan(0));
    net.settle(0);
    await net.drain();
    await waitFor(() => expect(routing.gate).not.toBeNull());

    selectThread(THREAD_B);
    await waitFor(() => expect(view.getByText("bravo question")).toBeTruthy());

    routing.gate?.reject(new Error("routing is down"));
    await net.drain();
    await waitFor(() => expect(view.getByText("bravo answer")).toBeTruthy());

    expect(
      driveCalls,
      "the legacy fall-through dispatched the edit on the thread the user switched to",
    ).toEqual([]);
  });

  it("Slack mode, NO switch: routing still decides the regeneration, on the origin thread", async () => {
    const net = chatNetwork();
    routing.hold = true;
    const view = await mountOnOriginThread(THREAD_S);

    await editFirstUserTurn(view, "alpha question, rephrased");
    await waitFor(() => expect(net.saves.length).toBeGreaterThan(0));
    net.settle(0);
    await net.drain();
    await waitFor(() => expect(routing.gate).not.toBeNull());

    routing.gate?.resolve({ shouldCallLlm: true });
    await net.drain();

    await waitFor(() => expect(driveCalls.length).toBe(1));
    expect(driveCalls[0].threadId).toBe(THREAD_S);
    expect(driveCalls[0].messages.map((m) => m.content)).toEqual([
      "alpha question, rephrased",
    ]);
  });
});

// ---------------------------------------------------------------------------
// THE LEDGER'S THREAD BOUNDARY (codex round 2, finding 2).
//
// A turn that ENDED is still nameable until a committed transcript carries it,
// so the ended-uncommitted ledger OUTLIVES the last stream. The page dropped it
// only when a stream happened to be in flight at the moment of the switch —
// `streams.size()` counts in-flight turns and nothing else — so an ordinary
// switch, made after the last turn ended, carried the whole ledger into the
// next thread. Its ids belong to the thread that was left and nothing over here
// would ever release them, and the next edit ASSERTS them: on an id collision
// the server tombstones a turn of this thread that nobody removed, and without
// one they are stale in every payload for the rest of the session.
//
// The arm drives it through the real surfaces — a turn that ends without
// revealing, the thread panel's own switch event, and the intent an edit posts.
// ---------------------------------------------------------------------------

describe("the ended-uncommitted ledger does not cross a thread switch", () => {
  it("an edit on the new thread asserts ITS turns only, with no stream in flight", async () => {
    const net = chatNetwork();
    const view = await mountOnOriginThread();

    // A turn ENDS on A without ever revealing: the drive stub takes the dispatch
    // and returns, so nothing appends the assistant message and no committed
    // transcript ever carries it. That is the aborted-turn shape — the id enters
    // the ledger and NOTHING releases it.
    await editFirstUserTurn(view, "alpha question, rephrased");
    await waitFor(() => expect(net.saves.length).toBeGreaterThan(0));
    net.settle(0);
    await net.drain();
    await waitFor(() => expect(driveCalls.length).toBe(1));
    await waitFor(() => expect(view.getByText("alpha question, rephrased")).toBeTruthy());

    // The user switches AFTER that turn ended, so nothing is in flight.
    selectThread(THREAD_B);
    await waitFor(() => expect(view.getByText("bravo question")).toBeTruthy());

    // An edit over here may assert B's own truncated slice and NOTHING else.
    await editFirstUserTurn(view, "bravo question, rephrased");
    await waitFor(() =>
      expect(net.saves.some((s) => s.id === THREAD_B && s.removedMessageIds)).toBe(true),
    );
    const intentB = net.saves.find((s) => s.id === THREAD_B && s.removedMessageIds);
    expect(
      intentB?.removedMessageIds,
      "the edit on the switched-to thread asserted a turn that streamed in the thread the user left",
    ).toEqual(["b-u1", "b-a1"]);
  });
});
