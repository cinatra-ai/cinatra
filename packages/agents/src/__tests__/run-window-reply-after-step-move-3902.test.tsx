// @vitest-environment jsdom
// A REPLY STORED AFTER THE PAGE MOVED TO THE NEXT STEP IS DRAWN THERE (cinatra#3902).
//
// A person asks the window of one step to fill the idea and submit it. The
// submit moves the run to its next step while the turn is still out, so the
// window that sent the turn unmounts and the next step's window mounts and reads
// the stored exchange ONCE, before the reply is stored. The reply is stored a
// moment later, and no window drew it until a reload.
//
// What is pinned here: when a turn of a run ends, every other mounted window of
// that same run reads the stored exchange again; the newest read wins; a window
// of another run and the window that sent the turn are not read again.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const loadRunWindowConversation = vi.fn();
const sendRunWindowTurn = vi.fn();

vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: (...a: unknown[]) => loadRunWindowConversation(...a),
  sendRunWindowTurn: (...a: unknown[]) => sendRunWindowTurn(...a),
}));

import { useRunWindowConversation } from "../use-run-window-conversation";

type Entry = { id: number; role: "user" | "assistant"; content: string };

const ASK = "Fill the idea with a short line and submit it.";
const IDEA: Entry = { id: 1, role: "assistant", content: "What is the idea?" };
const REPLY: Entry = { id: 4, role: "assistant", content: "Submitted." };
const TWO: Entry[] = [
  IDEA,
  { id: 2, role: "user", content: "A short line." },
];
const THREE: Entry[] = [...TWO, { id: 3, role: "user", content: ASK }];
const FOUR: Entry[] = [...THREE, REPLY];

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// The replaced load answers one queued answer per call, in call order.
let loadAnswers: Array<Entry[] | Promise<Entry[]>> = [];

function mountWindow(runId: string, surface: "run-page" | "schedule") {
  return renderHook(() => useRunWindowConversation({ runId, surface }));
}

function answered(entries: Entry[]) {
  return { ok: true, entries, fills: [], acted: false };
}

beforeEach(() => {
  loadAnswers = [];
  loadRunWindowConversation.mockReset();
  sendRunWindowTurn.mockReset();
  loadRunWindowConversation.mockImplementation(() =>
    Promise.resolve(loadAnswers.shift() ?? []),
  );
});

afterEach(() => {
  cleanup();
  vi.resetModules();
});

describe("a window re-reads the stored exchange when a turn of its run ends", () => {
  it("a reply stored after the page moved to the next step is drawn in that step's window without a reload", async () => {
    loadAnswers.push(TWO);
    const a = mountWindow("run_1", "run-page");
    await waitFor(() => expect(a.result.current.entries).toHaveLength(2));

    const turn = deferred<ReturnType<typeof answered>>();
    sendRunWindowTurn.mockReturnValue(turn.promise);
    let sent: Promise<unknown> = Promise.resolve();
    await act(async () => {
      sent = a.result.current.send(ASK);
    });
    // The page moved: the sending window is gone, the next step's window reads
    // the exchange before the reply is stored.
    a.unmount();
    loadAnswers.push(THREE);
    const b = mountWindow("run_1", "schedule");
    await waitFor(() => expect(b.result.current.entries).toHaveLength(3));

    // The reply is stored; the held turn ends.
    loadAnswers.push(FOUR);
    await act(async () => {
      turn.resolve(answered(FOUR));
      await sent;
    });

    await waitFor(() => expect(b.result.current.entries).toHaveLength(4));
    expect(b.result.current.entries[3]?.content).toBe("Submitted.");
  });

  it("two windows of the same run mounted at once: a turn that ends in one is drawn in the other", async () => {
    loadAnswers.push(TWO);
    const a = mountWindow("run_1", "run-page");
    await waitFor(() => expect(a.result.current.loaded).toBe(true));
    loadAnswers.push(THREE);
    const b = mountWindow("run_1", "schedule");
    await waitFor(() => expect(b.result.current.entries).toHaveLength(3));

    sendRunWindowTurn.mockResolvedValue(answered(FOUR));
    loadAnswers.push(FOUR);
    await act(async () => {
      await a.result.current.send(ASK);
    });

    await waitFor(() => expect(b.result.current.entries).toEqual(FOUR));
    expect(loadRunWindowConversation).toHaveBeenCalledTimes(3);
    expect(loadRunWindowConversation).toHaveBeenLastCalledWith("run_1");
  });

  it("a read that answers late never overwrites a newer one", async () => {
    loadAnswers.push(TWO);
    const a = mountWindow("run_1", "run-page");
    await waitFor(() => expect(a.result.current.loaded).toBe(true));

    const slowMountRead = deferred<Entry[]>();
    loadAnswers.push(slowMountRead.promise);
    const b = mountWindow("run_1", "schedule");

    sendRunWindowTurn.mockResolvedValue(answered(FOUR));
    loadAnswers.push(FOUR);
    await act(async () => {
      await a.result.current.send(ASK);
    });
    await waitFor(() => expect(b.result.current.entries).toHaveLength(4));

    await act(async () => {
      slowMountRead.resolve(THREE);
      await Promise.resolve();
    });
    expect(b.result.current.entries).toEqual(FOUR);
  });

  it("a window of another run is not re-read", async () => {
    loadAnswers.push(TWO);
    const a = mountWindow("run_1", "run-page");
    await waitFor(() => expect(a.result.current.loaded).toBe(true));
    loadAnswers.push(TWO);
    const other = mountWindow("run_2", "schedule");
    await waitFor(() => expect(other.result.current.loaded).toBe(true));

    sendRunWindowTurn.mockResolvedValue(answered(FOUR));
    await act(async () => {
      await a.result.current.send(ASK);
    });

    const otherReads = loadRunWindowConversation.mock.calls.filter(
      (call) => call[0] === "run_2",
    );
    expect(otherReads).toHaveLength(1);
  });

  it("the sending window keeps its turn's own exchange and is not re-read", async () => {
    loadAnswers.push(TWO);
    const a = mountWindow("run_1", "run-page");
    await waitFor(() => expect(a.result.current.loaded).toBe(true));

    sendRunWindowTurn.mockResolvedValue(answered(FOUR));
    await act(async () => {
      await a.result.current.send(ASK);
    });

    expect(loadRunWindowConversation).toHaveBeenCalledTimes(1);
    expect(a.result.current.entries).toEqual(FOUR);
  });

  it("a refresh still out when the window's own turn answers never overwrites that turn's exchange", async () => {
    loadAnswers.push(TWO);
    const a = mountWindow("run_1", "run-page");
    await waitFor(() => expect(a.result.current.loaded).toBe(true));
    loadAnswers.push(TWO);
    const b = mountWindow("run_1", "schedule");
    await waitFor(() => expect(b.result.current.loaded).toBe(true));

    // A's turn ends; B's refresh is held open.
    const slowRefresh = deferred<Entry[]>();
    sendRunWindowTurn.mockResolvedValue(answered(THREE));
    loadAnswers.push(slowRefresh.promise);
    await act(async () => {
      await a.result.current.send(ASK);
    });

    // B's own turn answers while that refresh is still out.
    sendRunWindowTurn.mockResolvedValue(answered(FOUR));
    await act(async () => {
      await b.result.current.send(ASK);
    });
    expect(b.result.current.entries).toEqual(FOUR);

    await act(async () => {
      slowRefresh.resolve(THREE);
      await Promise.resolve();
    });
    expect(b.result.current.entries).toEqual(FOUR);
  });
});
