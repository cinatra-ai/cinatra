// @vitest-environment jsdom
/**
 * The active thread's crumb: which answer it draws (cinatra#4453), and the rename
 * the thread panel announces so the page's list and crumb take the new name.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";

import {
  CHAT_THREAD_RENAMED_EVENT,
  chatThreadCrumbLabel,
  getCurrentChatThreadTitle,
  publishChatThreadTitle,
} from "@/lib/chat-shell-bus";
import { crumbThreadName, useThreadCrumbName } from "../thread-crumb-name";

const renameChatThread = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../actions", () => ({
  renameChatThread,
  deleteChatThread: vi.fn(async () => undefined),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/chat" }));

const ID = "0f0f4a25-6a0d-4c60-9d3a-2f1a1b1c9d20";
const NAMED = { state: "named", name: "From the server" } as const;
const base = {
  activeThreadId: ID,
  read: null,
  threads: [],
  initialThreadId: ID,
  initialThreadName: NAMED,
  serverNameSpent: false,
};

afterEach(() => {
  cleanup();
  publishChatThreadTitle(null);
});

describe("crumbThreadName", () => {
  it("takes the page's read of the active thread first", () => {
    expect(
      crumbThreadName({
        ...base,
        read: { threadId: ID, title: "From the read" },
        threads: [{ id: ID, title: "From the list" }],
      }),
    ).toEqual({ state: "named", name: "From the read" });
  });

  it("answers unavailable when the read found no thread, whatever the list and the server held", () => {
    expect(
      crumbThreadName({
        ...base,
        read: { threadId: ID, title: null },
        threads: [{ id: ID, title: "From the list" }],
      }),
    ).toEqual({ state: "unavailable" });
  });

  it("ignores a read of another thread and takes the list", () => {
    expect(
      crumbThreadName({
        ...base,
        read: { threadId: "other", title: "Other" },
        threads: [{ id: ID, title: "From the list" }],
      }),
    ).toEqual({ state: "named", name: "From the list" });
  });

  it("takes the server's answer only for the route's own thread, and only until it is spent", () => {
    expect(crumbThreadName(base)).toEqual(NAMED);
    expect(crumbThreadName({ ...base, serverNameSpent: true })).toEqual({ state: "unavailable" });
    expect(crumbThreadName({ ...base, activeThreadId: "other" })).toEqual({ state: "unavailable" });
  });

  it("answers unavailable with no active thread", () => {
    expect(crumbThreadName({ ...base, activeThreadId: null })).toEqual({ state: "unavailable" });
  });

  it("answers blank for an empty title from the read or the list", () => {
    expect(crumbThreadName({ ...base, read: { threadId: ID, title: " " } })).toEqual({
      state: "blank",
    });
    expect(crumbThreadName({ ...base, threads: [{ id: ID, title: "" }] })).toEqual({
      state: "blank",
    });
  });
});

describe("chatThreadCrumbLabel", () => {
  it("draws the name, the id's first eight characters for blank, and nothing for unavailable", () => {
    expect(chatThreadCrumbLabel({ state: "named", name: "Plan" }, ID)).toBe("Plan");
    expect(chatThreadCrumbLabel({ state: "blank" }, ID)).toBe("0f0f4a25…");
    expect(chatThreadCrumbLabel({ state: "unavailable" }, ID)).toBeNull();
  });
});

describe("the thread panel's rename", () => {
  it("announces the new name once the rename is saved", async () => {
    const { ChatThreadPanel } = await import("../chat-thread-panel");
    const heard: unknown[] = [];
    const listener = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener(CHAT_THREAD_RENAMED_EVENT, listener);
    try {
      render(
        <ChatThreadPanel
          initialThreads={[
            {
              id: ID,
              title: "Quarterly plan",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-02T00:00:00.000Z",
            },
          ]}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Rename conversation" }));
      const input = screen.getByDisplayValue("Quarterly plan");
      fireEvent.change(input, { target: { value: "  Annual plan " } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(heard).toEqual([{ threadId: ID, title: "Annual plan" }]));
      expect(renameChatThread).toHaveBeenCalledWith(ID, "Annual plan");
    } finally {
      window.removeEventListener(CHAT_THREAD_RENAMED_EVENT, listener);
    }
  });

  it("announces nothing when the name did not change", async () => {
    const { ChatThreadPanel } = await import("../chat-thread-panel");
    const heard: unknown[] = [];
    const listener = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener(CHAT_THREAD_RENAMED_EVENT, listener);
    try {
      render(
        <ChatThreadPanel
          initialThreads={[
            {
              id: ID,
              title: "Quarterly plan",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-02T00:00:00.000Z",
            },
          ]}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Rename conversation" }));
      fireEvent.keyDown(screen.getByDisplayValue("Quarterly plan"), { key: "Enter" });
      await new Promise((r) => setTimeout(r, 50));
      expect(heard).toEqual([]);
    } finally {
      window.removeEventListener(CHAT_THREAD_RENAMED_EVENT, listener);
    }
  });
});

// The hook's reads, asked and answered by hand in any order. `answer(read, title)`
// hands a read its answer: a title, or `null` for the read route's not-found.
type Listed = { id: string; title: string };
type Answer = (thread: { title?: string | null } | null) => void;
const OTHER = "7c1e2b9a-0d3f-4e5a-8b6c-1d2e3f4a5b6c";

function mountCrumb(activeThreadId: string | null, threads: Listed[] = []) {
  const setThreads = vi.fn();
  return renderHook(
    (p: { activeThreadId: string | null; threads: Listed[] }) =>
      useThreadCrumbName<Listed>({ activeThreadId: p.activeThreadId, threads: p.threads, setThreads }),
    { initialProps: { activeThreadId, threads } },
  );
}

function answer(read: Answer, title: string | null) {
  act(() => read(title === null ? null : { title }));
}

describe("the crumb's reads of the active thread, when they overlap or outlive a visit", () => {
  it("keeps the newer read's name when an older read answers after it", () => {
    const { result } = mountCrumb(ID);
    let older!: Answer;
    let newer!: Answer;
    act(() => {
      older = result.current(ID);
      newer = result.current(ID);
    });
    answer(newer, "Annual plan");
    expect(getCurrentChatThreadTitle()).toBe("Annual plan");
    answer(older, "Quarterly plan");
    expect(getCurrentChatThreadTitle()).toBe("Annual plan");
  });

  it("keeps a newer read's not-found when an older read of the thread answers after it", () => {
    const { result } = mountCrumb(ID, [{ id: ID, title: "From the list" }]);
    expect(getCurrentChatThreadTitle()).toBe("From the list");
    let older!: Answer;
    let newer!: Answer;
    act(() => {
      older = result.current(ID);
      newer = result.current(ID);
    });
    answer(newer, null);
    expect(getCurrentChatThreadTitle()).toBeNull();
    answer(older, "Quarterly plan");
    expect(getCurrentChatThreadTitle()).toBeNull();
  });

  it("takes each answer in turn when the reads answer in the order they were asked", () => {
    const { result } = mountCrumb(ID);
    let older!: Answer;
    let newer!: Answer;
    act(() => {
      older = result.current(ID);
      newer = result.current(ID);
    });
    answer(older, "Quarterly plan");
    expect(getCurrentChatThreadTitle()).toBe("Quarterly plan");
    answer(newer, "Annual plan");
    expect(getCurrentChatThreadTitle()).toBe("Annual plan");
  });

  it("keeps no read across a switch away and back: the list names the thread until a new read answers", () => {
    const listed = [{ id: ID, title: "Annual plan" }];
    const { result, rerender } = mountCrumb(ID, listed);
    answer(result.current(ID), "Quarterly plan");
    expect(getCurrentChatThreadTitle()).toBe("Quarterly plan");
    rerender({ activeThreadId: OTHER, threads: listed });
    expect(getCurrentChatThreadTitle()).toBeNull();
    rerender({ activeThreadId: ID, threads: listed });
    expect(getCurrentChatThreadTitle()).toBe("Annual plan");
    answer(result.current(ID), "Annual plan, renamed");
    expect(getCurrentChatThreadTitle()).toBe("Annual plan, renamed");
  });

  it("drops a read asked before a switch away and back that answers after it", () => {
    const listed = [{ id: ID, title: "Annual plan" }];
    const { result, rerender } = mountCrumb(ID, listed);
    let early!: Answer;
    act(() => {
      early = result.current(ID);
    });
    rerender({ activeThreadId: null, threads: listed });
    rerender({ activeThreadId: ID, threads: listed });
    answer(early, "Quarterly plan");
    expect(getCurrentChatThreadTitle()).toBe("Annual plan");
  });

  it("drops a read of the thread left behind that answers after the switch", () => {
    const listed = [{ id: OTHER, title: "Other plan" }];
    const { result, rerender } = mountCrumb(ID, listed);
    let early!: Answer;
    act(() => {
      early = result.current(ID);
    });
    rerender({ activeThreadId: OTHER, threads: listed });
    answer(early, "Quarterly plan");
    expect(getCurrentChatThreadTitle()).toBe("Other plan");
  });

  it("starts with no read after a remount, and an answer to the old mount reaches nothing", () => {
    const listed = [{ id: ID, title: "Annual plan" }];
    const first = mountCrumb(ID, listed);
    answer(first.result.current(ID), "Quarterly plan");
    let late!: Answer;
    act(() => {
      late = first.result.current(ID);
    });
    first.unmount();
    mountCrumb(ID, listed);
    expect(getCurrentChatThreadTitle()).toBe("Annual plan");
    answer(late, "Quarterly plan");
    expect(getCurrentChatThreadTitle()).toBe("Annual plan");
  });
});
