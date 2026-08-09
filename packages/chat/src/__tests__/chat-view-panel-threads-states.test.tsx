// @vitest-environment jsdom
//
// cinatra#2548 — the Threads panel could sit on "Loading…" forever. The fetch
// had no `.catch()` and flipped its loaded-flag only inside `.then()`, so any
// rejection (auth session, team query, schema ensure) wedged the panel for the
// rest of the session.
//
// The contract pinned here is that the panel has THREE distinct states and
// never conflates them:
//   loading  → "Loading…"
//   ready    → the thread list, or its own "No threads yet" empty state
//   error    → an explicit failure notice + a working retry
//
// The retry case is the one that matters most: a state machine that reaches
// "error" but cannot leave it is only half a fix.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const fetchChatThreads = vi.fn<() => Promise<unknown[]>>();
const fetchUserTeams = vi.fn<() => Promise<unknown[]>>();
const ensureTeamThread = vi.fn();

vi.mock("../actions", () => ({
  fetchChatThreads: () => fetchChatThreads(),
  fetchUserTeams: () => fetchUserTeams(),
  ensureTeamThread: (...args: unknown[]) => ensureTeamThread(...args),
}));

import { ChatViewPanel } from "../chat-view-panel";
import { CHAT_SHOW_PANEL_EVENT } from "@/lib/chat-shell-bus";

function openThreadsPanel() {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(CHAT_SHOW_PANEL_EVENT, { detail: "threads" }),
    );
  });
}

beforeEach(() => {
  fetchChatThreads.mockReset();
  fetchUserTeams.mockReset().mockResolvedValue([]);
  ensureTeamThread.mockReset();
});

afterEach(cleanup);

describe("ChatViewPanel — threads panel states (#2548)", () => {
  it("renders the error state with a retry when the fetch rejects", async () => {
    // The panel logs the rejection; keep the test output clean.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchChatThreads.mockRejectedValue(new Error("db blip"));

    render(<ChatViewPanel />);
    openThreadsPanel();

    expect(await screen.findByText(/couldn't load your threads/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
    // the defect: a rejection must NOT leave the panel claiming it is loading
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("recovers on retry — the error state is escapable", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchChatThreads.mockRejectedValueOnce(new Error("db blip"));

    render(<ChatViewPanel />);
    openThreadsPanel();

    const retry = await screen.findByRole("button", { name: /try again/i });
    fetchChatThreads.mockResolvedValueOnce([]);
    act(() => {
      retry.click();
    });

    await waitFor(() => expect(screen.getByText(/no threads yet/i)).toBeTruthy());
    expect(screen.queryByText(/couldn't load your threads/i)).toBeNull();
    expect(fetchChatThreads).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it("reaches the empty state (not an endless spinner) when there are no threads", async () => {
    fetchChatThreads.mockResolvedValue([]);

    render(<ChatViewPanel />);
    openThreadsPanel();

    expect(await screen.findByText(/no threads yet/i)).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("renders the list when threads load", async () => {
    fetchChatThreads.mockResolvedValue([
      {
        id: "t1",
        title: "Quarterly review",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
      },
    ]);

    render(<ChatViewPanel />);
    openThreadsPanel();

    expect(await screen.findByText("Quarterly review")).toBeTruthy();
    expect(screen.queryByText(/no threads yet/i)).toBeNull();
  });

  it("last request wins — a slow older failure cannot bury a newer success", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchChatThreads.mockRejectedValueOnce(new Error("db blip"));

    render(<ChatViewPanel />);
    openThreadsPanel();

    const retry = await screen.findByRole("button", { name: /try again/i });

    // Two retries in flight at once (a double-click): the FIRST rejects, the
    // SECOND succeeds — and settles last only in wall-clock order, not in
    // start order. Without a generation guard the stale rejection would flip
    // the panel back to the error state.
    let failStale: (err: Error) => void = () => {};
    fetchChatThreads.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (failStale = reject)),
    );
    fetchChatThreads.mockResolvedValueOnce([]);
    act(() => {
      retry.click();
      retry.click();
    });
    await waitFor(() => expect(screen.getByText(/no threads yet/i)).toBeTruthy());

    await act(async () => {
      failStale(new Error("stale rejection"));
    });

    expect(screen.getByText(/no threads yet/i)).toBeTruthy();
    expect(screen.queryByText(/couldn't load your threads/i)).toBeNull();
    consoleError.mockRestore();
  });

  it("fetches once per open — the effect does not loop", async () => {
    fetchChatThreads.mockResolvedValue([]);

    render(<ChatViewPanel />);
    openThreadsPanel();

    await screen.findByText(/no threads yet/i);
    expect(fetchChatThreads).toHaveBeenCalledTimes(1);
  });
});
