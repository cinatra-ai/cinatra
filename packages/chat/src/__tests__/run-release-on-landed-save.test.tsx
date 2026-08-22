// @vitest-environment jsdom
/**
 * THE LEDGER'S RUN HALF IS RELEASED BY A SAVE THAT LANDED — NOT BY A RENDER
 * (cinatra#2823 S9j, round 4 finding 1).
 *
 * The page used to release a ledger entry — the bubble id AND the run — on every
 * React commit of `messages`. "The transcript names it" is a true statement
 * about the BUBBLE ID: the edit reads its removed set out of that same snapshot,
 * so once the turn is in it the ledger has nothing to add. It is NOT a statement
 * about the RUN. A run id exists so an edit can name a turn the server has no
 * MIRROR ROW for, and the row is written by a SAVE — a separate, fallible,
 * skippable event.
 *
 * Two ordinary situations put a turn on screen with no row:
 *
 *   · SLACK, THE CONCURRENT MODE. Turn A reveals while sibling B still streams,
 *     and the page skips its ordinary save for as long as anything is in flight.
 *   · ANY MODE. The ordinary save is best-effort and silent, so a rejected one
 *     leaves the transcript on screen and nothing on the server.
 *
 * In both, the old rule had already dropped A's run. An edit that removes A's
 * prompt then names A's bubble id — which reaches no row — and asserts no run —
 * the only key that would have reached one. A's run-bound row stays
 * `superseded_at IS NULL` and folds back in above the edited prompt on the next
 * reload, made permanent by the next whole-transcript save.
 *
 * These arms drive the REAL page: the real registry, the real effects, the real
 * save chain, and the real `editAndResend`. The network is held by hand, so
 * "the save failed" and "the save landed" are events the arm causes rather than
 * races. What the server then does with an asserted run is driven on a real
 * database in `durable-lifecycle-reload-contract.integration.test.ts`.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

// --- the modules the mounted page reaches that belong to the SERVER ----------
// Replaced exactly as the other mounted-page suites in this directory replace
// them: their graphs reach the server runtime, so without these the lazy list
// chunk never evaluates and nothing mounts at all.

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: null, isPending: false }) },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../actions", () => ({
  resolveMessageRouting: vi.fn(async () => ({ shouldCallLlm: true })),
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

/**
 * THE TURN DRIVE, HELD OPEN. Every dispatch parks here with the `ui` callbacks
 * the page handed it, so an arm decides when a turn names its run, when it
 * reveals, and when it ends. Everything else in `ag-ui-chat-client` stays REAL —
 * the save chain above all, because the release under test is keyed on that
 * chain's outcome.
 */
type DriveUi = {
  updateMessages: (updater: (prev: Array<{ id: string; role: string; content: string }>) => Array<{ id: string; role: string; content: string }>) => void;
  noteRunId: (runId: string) => void;
};
type ParkedDrive = { assistantId: string; ui: DriveUi; finish: () => void };
const drives: ParkedDrive[] = [];

vi.mock("../ag-ui-chat-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ag-ui-chat-client")>();
  return {
    ...actual,
    ensureAssistantChatWireNegotiated: vi.fn(async () => true),
    driveAssistantChatTurn: vi.fn(
      (req: { assistantId: string; ui: DriveUi }) =>
        new Promise<void>((resolve) => {
          drives.push({ assistantId: req.assistantId, ui: req.ui, finish: resolve });
        }),
    ),
  };
});

// Some Node builds expose a global `localStorage` that SHADOWS jsdom's and
// throws on use, which the composer's prompt field reads on mount.
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
// One thread per mode, and a network whose SAVES are released by hand.
// ---------------------------------------------------------------------------

const THREAD_ONE = "thr-run-release";
const THREAD_SLACK = "thr-run-release-slack";

const SUMMARIES = [
  { id: THREAD_ONE, title: "One", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
  { id: THREAD_SLACK, title: "Slack", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z" },
];

const BODIES: Record<string, unknown> = {
  [THREAD_ONE]: {
    ...SUMMARIES[0],
    messages: [
      { id: "o-u1", role: "user", content: "alpha question" },
      { id: "o-a1", role: "assistant", content: "alpha answer" },
    ],
  },
  [THREAD_SLACK]: {
    ...SUMMARIES[1],
    slackMode: true,
    messages: [
      { id: "s-u1", role: "user", content: "alpha question" },
      { id: "s-a1", role: "assistant", content: "alpha answer" },
    ],
  },
};

type SavePost = {
  id: string;
  messages: Array<{ id: string; role: string; content: string }>;
  removedMessageIds?: string[];
  removedRunIds?: string[];
};

let openNetwork: { drainAll: () => Promise<void> } | null = null;

function chatNetwork() {
  const saves: SavePost[] = [];
  const release: Array<(res: Response) => void> = [];
  const settled = new Set<number>();
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
  async function drain() {
    await act(async () => {
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });
  }
  const net = {
    saves,
    /** Settle the Nth issued save; `ok: false` is the silent best-effort failure. */
    settle(index: number, ok = true) {
      settled.add(index);
      release[index]?.(ok ? new Response("{}") : new Response("no", { status: 503 }));
    },
    /**
     * Settle every save issued so far, and everything the chain then releases
     * behind them, until nothing new reaches the wire. Anything less leaves the
     * chain's HEAD unsettled, which wedges every save after it — the very defect
     * finding 3 is about, arriving as a test artefact.
     */
    async settleAll() {
      for (let pass = 0; pass < 8; pass += 1) {
        const before = release.length;
        for (let i = 0; i < release.length; i += 1) if (!settled.has(i)) net.settle(i);
        await drain();
        if (release.length === before) break;
      }
    },
    drain,
    /**
     * `saveChatThreadInOrder` keeps its chain per thread in MODULE state, which
     * outlives one arm — a save left hanging here would still head that thread's
     * chain in the next arm, and nothing would ever reach the wire again.
     */
    async drainAll() {
      await net.settleAll();
    },
  };
  openNetwork = net;
  return net;
}

async function mountOn(threadId: string) {
  const { ChatPage } = await import("../chat-page");
  const view = render(<ChatPage initialThreadId={threadId} userId="u-1" />);
  await waitFor(() =>
    expect(view.container.querySelector("[data-conversation-list]")).not.toBeNull(),
  );
  await waitFor(() => expect(view.getByText("alpha question")).toBeTruthy());
  return view;
}

/** Edit the Nth user turn through the REAL affordance: pencil → draft → Send. */
async function editUserTurn(view: ReturnType<typeof render>, index: number, text: string) {
  const pencil = view.container.querySelectorAll('[title="Edit message"]')[index];
  expect(pencil, "the edit affordance is not on the mounted turn").toBeTruthy();
  fireEvent.click(pencil);
  await waitFor(() =>
    expect(view.container.querySelector("textarea"), "the edit draft field did not open").not.toBeNull(),
  );
  fireEvent.change(view.container.querySelector("textarea") as HTMLTextAreaElement, {
    target: { value: text },
  });
  fireEvent.click(view.getByText("Send"));
}

/** The thread panel's own switch event — the real path a sidebar click takes. */
function selectThread(threadId: string) {
  window.dispatchEvent(new CustomEvent("cinatra:chat:select", { detail: { threadId } }));
}

/** Send through the REAL composer — the only way to get two concurrent turns. */
function sendComposerMessage(view: ReturnType<typeof render>, text: string) {
  const editors = view.container.querySelectorAll('[data-testid="chat-prompt-input"]');
  const editor = editors[editors.length - 1] as HTMLElement;
  expect(editor, "the composer is not mounted").toBeTruthy();
  editor.textContent = text;
  fireEvent.input(editor);
  fireEvent.keyDown(editor, { key: "Enter" });
}

/** The whole-turn ATOMIC REVEAL: name the run, append the bubble, unwind. */
async function revealAndEnd(drive: ParkedDrive, runId: string, content: string) {
  await act(async () => {
    drive.ui.noteRunId(runId);
    drive.ui.updateMessages((prev) => [
      ...prev,
      { id: drive.assistantId, role: "assistant", content },
    ]);
    drive.finish();
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  drives.length = 0;
});

afterEach(async () => {
  await openNetwork?.drainAll();
  openNetwork = null;
  cleanup();
  vi.unstubAllGlobals();
});

describe("the page releases a turn's RUN only on a save that landed", () => {
  it("SLACK: a turn that reveals beside a streaming sibling gets no save, and keeps its run until one lands", async () => {
    // The reviewer's scenario, driven end to end. Two turns are dispatched
    // concurrently — which only the composer can do, because an edit truncates
    // whatever it dispatches under. A reveals while B still streams, and the
    // page skips its ordinary save for as long as anything is in flight, so A
    // is on screen with no mirror row anywhere.
    const net = chatNetwork();
    const view = await mountOn(THREAD_SLACK);

    sendComposerMessage(view, "first prompt");
    await waitFor(() => expect(drives.length).toBe(1));
    sendComposerMessage(view, "second prompt");
    await waitFor(() => expect(drives.length).toBe(2));
    // The user-message saves land; neither carries an assistant turn.
    await net.settleAll();
    const savesBeforeReveal = net.saves.length;

    await revealAndEnd(drives[0], "run-A", "A's answer");
    await waitFor(() => expect(view.getByText("A's answer")).toBeTruthy());
    expect(
      net.saves.length,
      "the page saved while a sibling was still streaming, so this is no longer the skipped-save shape",
    ).toBe(savesBeforeReveal);

    // B's stream is cut without revealing anything (a stop press, a dropped
    // connection). Only now does the page issue the ordinary save that would
    // give A its mirror row — and the edit affordance comes back with it.
    await act(async () => {
      drives[1].finish();
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });
    await waitFor(() => expect(net.saves.length).toBe(savesBeforeReveal + 1));
    expect(net.saves[savesBeforeReveal].messages.map((m) => m.content)).toContain("A's answer");

    // THE EDIT LANDS IN THAT WINDOW: the save is on the wire and has NOT
    // returned, so A still has no row. Its BUBBLE id comes from the snapshot —
    // which reaches nothing the server knows — and its RUN has to come from the
    // ledger, which the old rule emptied back at the reveal.
    await editUserTurn(view, 1, "first prompt, rephrased");
    net.settle(savesBeforeReveal); // the ordinary save finally returns
    await waitFor(() => expect(net.saves.length).toBe(savesBeforeReveal + 2));

    const intent = net.saves[savesBeforeReveal + 1];
    expect(intent.removedMessageIds, "the edit did not name the revealed turn").toContain(
      drives[0].assistantId,
    );
    expect(
      intent.removedRunIds ?? [],
      "the revealed turn's run was released before any save landed, so the edit could not assert it",
    ).toContain("run-A");
  });

  it("a turn whose best-effort save FAILED keeps its run", async () => {
    // The same shape reaching a lone turn. The ordinary save is fire-and-forget
    // and silent, so a rejected one leaves the turn on screen with no row.
    const net = chatNetwork();
    const view = await mountOn(THREAD_ONE);

    await editUserTurn(view, 0, "alpha question, rephrased");
    await waitFor(() => expect(net.saves.length).toBe(1));
    net.settle(0); // the intent lands, and the regeneration is dispatched
    await net.drain();
    await waitFor(() => expect(drives.length).toBe(1));

    await revealAndEnd(drives[0], "run-lonely", "regenerated answer");
    // The ordinary save for the revealed transcript is issued — and REJECTED.
    await waitFor(() => expect(net.saves.length).toBe(2));
    expect(net.saves[1].messages.map((m) => m.content)).toContain("regenerated answer");
    net.settle(1, false);
    await net.drain();

    await editUserTurn(view, 0, "alpha question, rephrased twice");
    await waitFor(() => expect(net.saves.length).toBe(3));
    expect(
      net.saves[2].removedRunIds ?? [],
      "the run was released by a save that never landed",
    ).toContain("run-lonely");
  });

  it("a turn whose save LANDED releases its run — the ledger does not leak", async () => {
    // The other direction, and the one that keeps the rule honest: once the
    // mirror row exists the ordinary key takes over, so the registry must stop
    // offering the run rather than hold it for the life of the page.
    const net = chatNetwork();
    const view = await mountOn(THREAD_ONE);

    await editUserTurn(view, 0, "alpha question, rephrased");
    await waitFor(() => expect(net.saves.length).toBe(1));
    net.settle(0);
    await net.drain();
    await waitFor(() => expect(drives.length).toBe(1));

    await revealAndEnd(drives[0], "run-landed", "regenerated answer");
    await waitFor(() => expect(net.saves.length).toBe(2));
    net.settle(1); // this time it lands
    await net.drain();

    await editUserTurn(view, 0, "alpha question, rephrased twice");
    await waitFor(() => expect(net.saves.length).toBe(3));
    expect(
      net.saves[2].removedRunIds,
      "the run was still asserted although the turn has a mirror row of its own",
    ).toBeUndefined();
  });

  it("a save that lands AFTER a thread switch is inert — it drives the left thread's state, or nothing", async () => {
    // CODEX, ROUND 4, ON THIS CHANGE. Waiting for the save added a suspension the
    // synchronous version did not have, and the registry and the fingerprint
    // baseline are ONE object each, shared by every thread the page shows. So the
    // continuation is fenced on the thread it was issued for, exactly like the
    // edit flow's own resumed awaits.
    //
    // WHAT THIS ARM CLAIMS, AND WHAT IT DOES NOT. It drives the sequence and
    // pins that nothing is written for the arrived thread. It is NOT a red-green
    // regression arm for the fence: with the fence removed this still passes,
    // because the corrupted baseline is only read on the NEXT run of the
    // persistence effect, and every reachable trigger for that run is a genuine
    // messages change — which owes a save either way. The fence is therefore
    // defence in depth against the cross-thread write, not the repair of an
    // observable defect, and this arm says so rather than claiming otherwise.
    const net = chatNetwork();
    const view = await mountOn(THREAD_ONE);

    await editUserTurn(view, 0, "alpha question, rephrased");
    await waitFor(() => expect(net.saves.length).toBe(1));
    net.settle(0);
    await net.drain();
    await waitFor(() => expect(drives.length).toBe(1));
    await revealAndEnd(drives[0], "run-left-behind", "regenerated answer");
    // The ordinary save for the revealed transcript is on the wire and HELD.
    await waitFor(() => expect(net.saves.length).toBe(2));

    // The user moves to another thread while it is still open.
    selectThread(THREAD_SLACK);
    await waitFor(() => expect(view.getByText("alpha answer")).toBeTruthy());
    const savesAtSwitch = net.saves.length;

    // ...and only now does the left thread's save land.
    net.settle(1);
    await net.drain();
    await net.drain();

    for (const save of net.saves.slice(savesAtSwitch)) {
      expect(
        save.id,
        "a save was issued for the arrived thread by a continuation belonging to the thread that was left",
      ).not.toBe(THREAD_SLACK);
    }
  });
});
