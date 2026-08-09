// @vitest-environment jsdom
// The EFFECTFUL push/replace seam (cinatra#2562, codex round-1 finding #3).
// chat-client-url.test.ts locks down the PURE decision cores
// (resolveChatPushUrl / resolveChatSlugUpgradeUrl) exhaustively; this file
// proves the actual browser History calls those cores drive through
// `useChatUrlSync` — that selecting a pre-slug thread calls `pushState`
// exactly once with the id-shaped URL, and that a slug arriving later calls
// `replaceState` (never an EXTRA `pushState` — no history-stack spam), also
// covering codex round-1 finding #2 (a live deep-link query/hash surviving
// the automatic upgrade).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useChatUrlSync } from "../chat-client-url";
import type { UiThreadSummary } from "../types";

function thread(over: Partial<UiThreadSummary> & { id: string }): UiThreadSummary {
  return {
    title: "t",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    assistantPackage: "@cinatra-ai/cinatra-assistant",
    instanceId: null,
    titleSlug: null,
    ...over,
  };
}

describe("useChatUrlSync — the pushChatUrl / slug-upgrade seam (cinatra#2562)", () => {
  let pushSpy: ReturnType<typeof vi.spyOn>;
  let replaceSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.history.replaceState(null, "", "/chat/cinatra-ai/cinatra-assistant");
    pushSpy = vi.spyOn(window.history, "pushState");
    replaceSpy = vi.spyOn(window.history, "replaceState");
  });

  afterEach(() => {
    cleanup();
    pushSpy.mockRestore();
    replaceSpy.mockRestore();
  });

  it("pushChatUrl on a pre-slug thread pushState's the id-shaped URL exactly once — the thread stays in the URL", () => {
    const preSlug = thread({ id: "th-2" });
    const { result } = renderHook(() =>
      useChatUrlSync([preSlug], "@cinatra-ai/cinatra-assistant", null),
    );

    result.current.pushChatUrl("th-2");

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith(null, "", "/chat/cinatra-ai/cinatra-assistant/th-2");
    expect(window.location.pathname).toBe("/chat/cinatra-ai/cinatra-assistant/th-2");
  });

  it("slug arrival upgrades IN PLACE via replaceState — never an extra pushState (no history-stack spam)", () => {
    const preSlug = thread({ id: "th-2" });
    const { result, rerender } = renderHook(
      ({ threads }: { threads: UiThreadSummary[] }) =>
        useChatUrlSync(threads, "@cinatra-ai/cinatra-assistant", null),
      { initialProps: { threads: [preSlug] } },
    );

    result.current.pushChatUrl("th-2");
    expect(pushSpy).toHaveBeenCalledTimes(1);
    replaceSpy.mockClear();

    // The next threads refetch reflects the newly-minted slug.
    const nowSlugged = thread({ id: "th-2", titleSlug: "weekly-sync" });
    rerender({ threads: [nowSlugged] });

    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).toHaveBeenCalledWith(
      null,
      "",
      "/chat/cinatra-ai/cinatra-assistant/weekly-sync",
    );
    // The upgrade is IN PLACE — no additional back-button stop.
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/chat/cinatra-ai/cinatra-assistant/weekly-sync");
  });

  it("does not replaceState again once already on the canonical slug URL (idempotent)", () => {
    const nowSlugged = thread({ id: "th-2", titleSlug: "weekly-sync" });
    window.history.replaceState(null, "", "/chat/cinatra-ai/cinatra-assistant/weekly-sync");
    const { rerender } = renderHook(
      ({ threads }: { threads: UiThreadSummary[] }) =>
        useChatUrlSync(threads, "@cinatra-ai/cinatra-assistant", null),
      { initialProps: { threads: [nowSlugged] } },
    );
    replaceSpy.mockClear();

    rerender({ threads: [{ ...nowSlugged, updatedAt: "2026-01-01T00:00:01.000Z" }] });

    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it("never upgrades a thread the user has since navigated away from", () => {
    const preSlug = thread({ id: "th-2" });
    const { result, rerender } = renderHook(
      ({ threads }: { threads: UiThreadSummary[] }) =>
        useChatUrlSync(threads, "@cinatra-ai/cinatra-assistant", null),
      { initialProps: { threads: [preSlug] } },
    );
    // The user actually selected th-2 (its id URL is live) …
    result.current.pushChatUrl("th-2");
    expect(window.location.pathname).toBe("/chat/cinatra-ai/cinatra-assistant/th-2");
    // … then navigated away (New chat) BEFORE th-2's slug minted.
    result.current.pushNewChatUrl();
    expect(window.location.pathname).toBe("/chat/cinatra-ai/cinatra-assistant");
    replaceSpy.mockClear();

    const nowSlugged = thread({ id: "th-2", titleSlug: "weekly-sync" });
    rerender({ threads: [nowSlugged] });

    expect(replaceSpy).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/chat/cinatra-ai/cinatra-assistant");
  });

  it("preserves a live deep-link query/hash across the automatic slug-arrival upgrade (codex round-1 finding #2)", () => {
    window.history.replaceState(
      null,
      "",
      "/chat/cinatra-ai/cinatra-assistant/th-2?wf=w1&task=t1#foo",
    );
    const preSlug = thread({ id: "th-2" });
    const { rerender } = renderHook(
      ({ threads }: { threads: UiThreadSummary[] }) =>
        useChatUrlSync(threads, "@cinatra-ai/cinatra-assistant", null),
      { initialProps: { threads: [preSlug] } },
    );

    const nowSlugged = thread({ id: "th-2", titleSlug: "weekly-sync" });
    rerender({ threads: [nowSlugged] });

    expect(window.location.pathname).toBe("/chat/cinatra-ai/cinatra-assistant/weekly-sync");
    expect(window.location.search).toBe("?wf=w1&task=t1");
    expect(window.location.hash).toBe("#foo");
  });
});
