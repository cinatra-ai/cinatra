// @vitest-environment jsdom
/**
 * The active thread's crumb: which answer it draws (cinatra#4453), and the rename
 * the thread panel announces so the page's list and crumb take the new name.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CHAT_THREAD_RENAMED_EVENT, chatThreadCrumbLabel } from "@/lib/chat-shell-bus";
import { crumbThreadName } from "../thread-crumb-name";

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

afterEach(() => cleanup());

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
