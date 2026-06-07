// @vitest-environment jsdom
//
// Covers the chat shell bus that bridges the app shell and the chat package
// across mount boundaries (breadcrumb title seed + threads-flyout open
// across a non-chat-route navigation). This is the cheap scripted
// regression check the phase calls for: the cross-route open path (parked
// panel consumed on mount) + the no-stale-reopen guarantee.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHAT_TITLE_CHANGED_EVENT,
  CHAT_SHOW_PANEL_EVENT,
  publishChatThreadTitle,
  getCurrentChatThreadTitle,
  requestChatPanel,
  consumePendingChatPanel,
} from "../chat-shell-bus";

afterEach(() => {
  // Reset the holders between tests.
  publishChatThreadTitle(null);
  consumePendingChatPanel();
  vi.restoreAllMocks();
});

describe("chat thread title holder", () => {
  it("publish stores the last value + dispatches the live event", () => {
    const handler = vi.fn();
    window.addEventListener(CHAT_TITLE_CHANGED_EVENT, handler);
    publishChatThreadTitle("Launch plan");
    expect(getCurrentChatThreadTitle()).toBe("Launch plan");
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual({ title: "Launch plan" });
    window.removeEventListener(CHAT_TITLE_CHANGED_EVENT, handler);
  });

  it("a consumer that reads AFTER publish still gets the last value (mount-after-emit race)", () => {
    publishChatThreadTitle("Q3 roadmap");
    // Simulates AppShell seeding from the bus in its (later) listener effect.
    expect(getCurrentChatThreadTitle()).toBe("Q3 roadmap");
  });

  it("publish(null) clears the held title", () => {
    publishChatThreadTitle("x");
    publishChatThreadTitle(null);
    expect(getCurrentChatThreadTitle()).toBeNull();
  });
});

describe("pending chat panel holder", () => {
  it("requestChatPanel parks the panel + dispatches the live event", () => {
    const handler = vi.fn();
    window.addEventListener(CHAT_SHOW_PANEL_EVENT, handler);
    requestChatPanel("threads");
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe("threads");
    window.removeEventListener(CHAT_SHOW_PANEL_EVENT, handler);
  });

  it("cross-route open: a panel parked before mount is consumed once on mount", () => {
    // sidebar click on a non-chat route (no ChatViewPanel listener yet)
    requestChatPanel("threads");
    // ChatViewPanel mounts post-navigation and consumes the parked panel
    expect(consumePendingChatPanel()).toBe("threads");
    // a later remount must NOT re-open it (no stale pending)
    expect(consumePendingChatPanel()).toBeNull();
  });

  it("already-mounted: the live listener consuming clears the holder (no stale reopen)", () => {
    // sidebar click while already on /chat: requestChatPanel parks + dispatches;
    // the live listener handles it and consumes to clear.
    requestChatPanel("teams");
    expect(consumePendingChatPanel()).toBe("teams"); // live listener clears
    // a subsequent ChatViewPanel remount sees nothing parked
    expect(consumePendingChatPanel()).toBeNull();
  });
});
