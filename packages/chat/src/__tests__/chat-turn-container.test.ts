// The CONTAINER a /chat turn asserts (cinatra#2650) — the client half.
//
// `resolveChatTurnContainer` is the pure decision core the dispatcher calls at
// SEND time to say which assistant container the turn's thread is homed in. The
// server re-resolves that assertion and BINDS it, so this function deciding
// wrong writes the wrong home into the database — which is why every SPA
// transition that can move the answer is pinned here.
import { describe, expect, it } from "vitest";
import { DEFAULT_ASSISTANT_PACKAGE } from "../chat-path-codec";
import {
  chatBasePathForAssistant,
  chatPathForThread,
  resolveChatPushUrl,
  resolveChatTurnContainer,
} from "../chat-client-url";

const OTHER = "@acme/helper-assistant";
const REMOTE = "@cinatra-ai/wordpress-assistant";

type T = { id: string; assistantPackage?: string | null; instanceId?: string | null; titleSlug?: string | null };

/** The mount's live binding (what `useChatUrlSync`'s ref holds). */
const mount = (assistantPackage: string | null, instanceId: string | null = null) => ({
  assistantPackage,
  instanceId,
});

describe("resolveChatTurnContainer — the thread's live logical container", () => {
  it("a KNOWN bound thread reports its OWN container, not the mount's", () => {
    const threads: T[] = [{ id: "t1", assistantPackage: OTHER, instanceId: null }];
    expect(resolveChatTurnContainer("t1", threads, mount(REMOTE, "site-9"))).toEqual({
      assistantPackage: OTHER,
      instanceId: null,
    });
  });

  it("a KNOWN instance-scoped thread carries its instance", () => {
    const threads: T[] = [{ id: "t1", assistantPackage: REMOTE, instanceId: "site-1" }];
    expect(resolveChatTurnContainer("t1", threads, mount(DEFAULT_ASSISTANT_PACKAGE))).toEqual({
      assistantPackage: REMOTE,
      instanceId: "site-1",
    });
  });

  // THE TRANSITION codex round 1 flagged. `adoptThreadBinding` treats an
  // explicit `assistantPackage: null` as "keep the current binding" BY DESIGN
  // (so the New-chat button stays in the container the user is browsing), which
  // leaves the mount ref on the non-default package after an unbound thread is
  // selected. The turn must still assert the DEFAULT: that is where an unbound
  // thread's URL resolves (`chatPathForThread` addresses it at
  // `assistantPackage ?? DEFAULT`) and where #2649's alias finds it.
  it("mounted at a NON-DEFAULT assistant, a KNOWN UNBOUND thread still reports the DEFAULT", () => {
    const threads: T[] = [{ id: "t1", assistantPackage: null, instanceId: null }];
    expect(resolveChatTurnContainer("t1", threads, mount(OTHER))).toEqual({
      assistantPackage: DEFAULT_ASSISTANT_PACKAGE,
      instanceId: null,
    });
  });

  it("an UNBOUND thread never inherits a stale INSTANCE from the mount — the container key is the PAIR, and an instance with no package is a shape the server refuses", () => {
    const threads: T[] = [{ id: "t1", assistantPackage: null, instanceId: null }];
    expect(resolveChatTurnContainer("t1", threads, mount(REMOTE, "site-7"))).toEqual({
      assistantPackage: DEFAULT_ASSISTANT_PACKAGE,
      instanceId: null,
    });
  });

  it("a thread carrying an instance but NO package is normalized to the default container, instance dropped", () => {
    const threads: T[] = [{ id: "t1", assistantPackage: null, instanceId: "site-3" }];
    expect(resolveChatTurnContainer("t1", threads, mount(OTHER))).toEqual({
      assistantPackage: DEFAULT_ASSISTANT_PACKAGE,
      instanceId: null,
    });
  });

  it("a thread NOT yet in the list (just seeded this render) reports the MOUNT's container — exactly the one it is being created in", () => {
    expect(resolveChatTurnContainer("new-1", [], mount(REMOTE, "site-2"))).toEqual({
      assistantPackage: REMOTE,
      instanceId: "site-2",
    });
    // …and the seeded summary then carries the same pair, so the next call for
    // the SAME thread through the known-thread branch is identical (a retry can
    // never silently downgrade the container).
    const seeded: T[] = [{ id: "new-1", assistantPackage: REMOTE, instanceId: "site-2" }];
    expect(resolveChatTurnContainer("new-1", seeded, mount(REMOTE, "site-2"))).toEqual(
      resolveChatTurnContainer("new-1", [], mount(REMOTE, "site-2")),
    );
  });

  it("an unbound MOUNT (no server-seeded package) falls back to the default", () => {
    expect(resolveChatTurnContainer("new-1", [], mount(null))).toEqual({
      assistantPackage: DEFAULT_ASSISTANT_PACKAGE,
      instanceId: null,
    });
  });

  it("no active thread at all still yields a well-formed container (the New-chat case)", () => {
    expect(resolveChatTurnContainer(null, [], mount(OTHER))).toEqual({
      assistantPackage: OTHER,
      instanceId: null,
    });
  });

  it("cross-container selection: switching between two KNOWN threads switches the asserted container with them", () => {
    const threads: T[] = [
      { id: "a", assistantPackage: OTHER, instanceId: null },
      { id: "b", assistantPackage: REMOTE, instanceId: "site-5" },
    ];
    expect(resolveChatTurnContainer("a", threads, mount(REMOTE, "site-5")).assistantPackage).toBe(OTHER);
    expect(resolveChatTurnContainer("b", threads, mount(OTHER)).assistantPackage).toBe(REMOTE);
  });

  // The invariant that makes the whole design safe: the URL the client PUSHES
  // and the container the server BINDS are two readings of the same fact, so
  // they must be built from the same normalization. Asserted by driving the
  // REAL URL builders and reconstructing the container from the path they
  // produce — not by restating the rule.
  it("the asserted container is exactly the container the client's own URL builders address the thread at", () => {
    const cases: T[] = [
      { id: "t1", assistantPackage: null, instanceId: null },
      { id: "t2", assistantPackage: OTHER, instanceId: null },
      { id: "t3", assistantPackage: REMOTE, instanceId: "site-1" },
      // the malformed-partial shape: an instance with NO package. Both sides
      // must drop the instance, or the client builds an instance URL under the
      // DEFAULT assistant — which has no instance scope to resolve it.
      { id: "t4", assistantPackage: null, instanceId: "site-3" },
    ];
    for (const t of cases) {
      const container = resolveChatTurnContainer(t.id, cases, mount(OTHER, "stale-instance"));
      const pushed = resolveChatPushUrl(t.id, cases, { assistantPackage: OTHER, instanceId: "stale-instance" });
      expect(pushed).toBe(chatPathForThread(t));
      // The container, re-encoded as a path, IS the path the client pushed.
      expect(chatPathForThread({ id: t.id, ...container })).toBe(pushed);
    }
  });

  it("a NEW chat's base path agrees with the container a first turn would assert", () => {
    for (const binding of [
      mount(null, null),
      mount(null, "site-3"), // instance with no package — dropped on both sides
      mount(OTHER, null),
      mount(REMOTE, "site-1"),
    ]) {
      const container = resolveChatTurnContainer(null, [], binding);
      expect(chatBasePathForAssistant(binding.assistantPackage, binding.instanceId)).toBe(
        chatBasePathForAssistant(container.assistantPackage, container.instanceId),
      );
    }
  });

  it("an instance is NEVER pinned onto the default assistant's path — the container is the PAIR", () => {
    expect(chatPathForThread({ id: "t1", assistantPackage: null, instanceId: "site-3" })).toBe(
      chatPathForThread({ id: "t1", assistantPackage: null, instanceId: null }),
    );
    expect(chatBasePathForAssistant(null, "site-3")).toBe(chatBasePathForAssistant(null, null));
  });
});
