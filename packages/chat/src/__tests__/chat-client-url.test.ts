// pushChatUrl seam regression tests (cinatra#2562). A thread must stay
// addressable in the URL BEFORE its title-slug mints (id fallback, reusing the
// same trailing route segment the guard already resolves — see
// chat-route-resolver.test.ts's "pre-slug id fallback" coverage on the server
// side), and the URL must upgrade to the canonical slug path IN PLACE
// (replaceState, never a new pushState entry) the moment the slug mints.
// Exercises the PURE decision cores directly (no DOM/React needed — see the
// file header on why the effectful hook is a thin wrapper over these).
import { describe, expect, it } from "vitest";
import {
  activeThreadIdForPathname,
  chatIdPathForThread,
  chatPathForThread,
  resolveChatPushUrl,
  resolveChatSlugUpgradeUrl,
  type ThreadUrlFields,
} from "../chat-client-url";

type T = ThreadUrlFields & { id: string };

const slugged: T = {
  id: "th-1",
  assistantPackage: "@cinatra-ai/cinatra-assistant",
  instanceId: null,
  titleSlug: "weekly-sync",
};
const preSlug: T = {
  id: "th-2",
  assistantPackage: "@cinatra-ai/cinatra-assistant",
  instanceId: null,
  titleSlug: null,
};
const remotePreSlug: T = {
  id: "th-3",
  assistantPackage: "@cinatra-ai/wordpress-assistant",
  instanceId: "site-9",
  titleSlug: null,
};

describe("chatPathForThread — pre-slug id fallback (cinatra#2562)", () => {
  it("still builds the canonical slug path when a titleSlug is minted (unchanged)", () => {
    expect(chatPathForThread(slugged)).toBe("/chat/cinatra-ai/cinatra-assistant/weekly-sync");
  });

  it("falls back to the thread's stable id when no titleSlug exists — never null", () => {
    expect(chatPathForThread(preSlug)).toBe("/chat/cinatra-ai/cinatra-assistant/th-2");
  });

  it("carries the instance segment for a remote, pre-slug thread", () => {
    expect(chatPathForThread(remotePreSlug)).toBe(
      "/chat/cinatra-ai/wordpress-assistant/site-9/th-3",
    );
  });

  it("is null only when the thread carries neither a slug nor an id", () => {
    expect(chatPathForThread({ assistantPackage: "@cinatra-ai/cinatra-assistant" })).toBeNull();
  });

  it("is null for an unresolvable package even with an id present", () => {
    expect(chatPathForThread({ id: "th-9", assistantPackage: "not-scoped" })).toBeNull();
  });
});

describe("chatIdPathForThread — always the pre-slug shape", () => {
  it("ignores a present titleSlug and always returns the id-addressed path", () => {
    expect(chatIdPathForThread(slugged)).toBe("/chat/cinatra-ai/cinatra-assistant/th-1");
  });
});

describe("activeThreadIdForPathname — matches slug OR id path (cinatra#2562)", () => {
  const threads = [slugged, preSlug];

  it("matches a slugged thread by its canonical path", () => {
    expect(activeThreadIdForPathname("/chat/cinatra-ai/cinatra-assistant/weekly-sync", threads)).toBe(
      "th-1",
    );
  });

  it("matches a pre-slug thread by its id-shaped path", () => {
    expect(activeThreadIdForPathname("/chat/cinatra-ai/cinatra-assistant/th-2", threads)).toBe("th-2");
  });

  it("re-highlights a SLUGGED thread from its lingering pre-slug id URL (issue's stated impact)", () => {
    // The thread now carries a titleSlug, but the browser is still sitting on
    // the id-shaped URL it was pushed with before the mint (e.g. reloaded in
    // the window between mint and the client-side replaceState upgrade).
    expect(activeThreadIdForPathname("/chat/cinatra-ai/cinatra-assistant/th-1", threads)).toBe("th-1");
  });

  it("returns null for a path matching no known thread (new/empty chat)", () => {
    expect(activeThreadIdForPathname("/chat/cinatra-ai/cinatra-assistant", threads)).toBeNull();
  });
});

describe("resolveChatPushUrl — the pushChatUrl seam (cinatra#2562)", () => {
  const binding = { assistantPackage: "@cinatra-ai/cinatra-assistant", instanceId: null };

  it("a slugged, known thread pushes its canonical path (existing behavior unchanged)", () => {
    expect(resolveChatPushUrl("th-1", [slugged], binding)).toBe(
      "/chat/cinatra-ai/cinatra-assistant/weekly-sync",
    );
  });

  it("a pre-slug, known thread pushes its id path — the thread stays in the URL", () => {
    expect(resolveChatPushUrl("th-2", [preSlug], binding)).toBe(
      "/chat/cinatra-ai/cinatra-assistant/th-2",
    );
  });

  it("a thread NOT yet in the live list still pushes an id path under the current binding", () => {
    // Reproduces sendMessage's synchronous pushChatUrl(threadId) right after
    // seeding — the threads-state effect has not re-run yet, so the list
    // lookup misses; the current binding is exactly the container the new
    // thread was seeded into.
    expect(resolveChatPushUrl("brand-new-id", [], binding)).toBe(
      "/chat/cinatra-ai/cinatra-assistant/brand-new-id",
    );
  });

  it("no threadId (explicit clear) falls back to the bound assistant's base path", () => {
    expect(resolveChatPushUrl(null, [slugged], binding)).toBe("/chat/cinatra-ai/cinatra-assistant");
  });

  it("never drops the thread from the URL — pushChatUrl's base-path fallback is UNREACHABLE for a real threadId", () => {
    // The regression this issue exists to close: previously
    // `chatPathForThread(thread) ?? chatBasePathForAssistant(...)` fell all the
    // way to the base path whenever titleSlug was absent. With the id
    // fallback, a truthy threadId ALWAYS resolves to a thread-scoped path.
    const url = resolveChatPushUrl("th-2", [preSlug], binding);
    expect(url).not.toBe("/chat/cinatra-ai/cinatra-assistant");
    expect(url).toContain("th-2");
  });
});

describe("resolveChatSlugUpgradeUrl — replaceState on slug arrival (cinatra#2562)", () => {
  it("upgrades when the browser sits on the active thread's pre-slug URL and its slug just minted", () => {
    const nowSlugged: T = { ...preSlug, titleSlug: "weekly-sync" };
    const url = resolveChatSlugUpgradeUrl("/chat/cinatra-ai/cinatra-assistant/th-2", [nowSlugged]);
    expect(url).toBe("/chat/cinatra-ai/cinatra-assistant/weekly-sync");
  });

  it("does nothing when the current URL already IS the canonical slug path", () => {
    expect(resolveChatSlugUpgradeUrl("/chat/cinatra-ai/cinatra-assistant/weekly-sync", [slugged])).toBeNull();
  });

  it("does nothing while the active thread still has no titleSlug", () => {
    expect(resolveChatSlugUpgradeUrl("/chat/cinatra-ai/cinatra-assistant/th-2", [preSlug])).toBeNull();
  });

  it("never touches the URL for an UNRELATED thread minting a slug elsewhere in the list", () => {
    const unrelatedNowSlugged: T = {
      id: "th-99",
      assistantPackage: "@cinatra-ai/cinatra-assistant",
      instanceId: null,
      titleSlug: "some-other-thread",
    };
    // Browser is on th-2's pre-slug URL; th-99 (a different thread) just minted.
    const url = resolveChatSlugUpgradeUrl("/chat/cinatra-ai/cinatra-assistant/th-2", [
      unrelatedNowSlugged,
    ]);
    expect(url).toBeNull();
  });

  it("does nothing on a new/empty chat path (no thread addressed at all)", () => {
    const nowSlugged: T = { ...preSlug, titleSlug: "weekly-sync" };
    expect(resolveChatSlugUpgradeUrl("/chat/cinatra-ai/cinatra-assistant", [nowSlugged])).toBeNull();
  });
});
