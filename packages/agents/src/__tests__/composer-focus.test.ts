// COMPOSER FOCUS — the reducer and the store (cinatra#2566's composer-focus
// deliverable; the program Done-definition is cinatra#2573: "multiple concurrent
// gates require explicit composer focus").
//
// The rule these pin is the one a real decision-module call hangs on: WHICH
// review a typed chat message comments on. The failure mode this exists to stop
// is not a crash — it is a comment landing silently on a review the reader did
// not choose, which on a single-target automatic gate resolves as
// `changes_requested` and sends the run into a repair. So the test that matters
// most is the one that asserts NOTHING is chosen when the answer is not knowable.

import { describe, expect, it, vi } from "vitest";

import {
  createComposerFocusStore,
  resolveComposerTarget,
  type ComposerCommentAction,
} from "../lifecycle-card-runtime";

const noComment: ComposerCommentAction = async () => ({ ok: true, message: "ok" });

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

describe("resolveComposerTarget", () => {
  it("no eligible gate → none (the composer is untouched)", () => {
    expect(resolveComposerTarget({ eligible: [], focused: null, released: false })).toEqual({ kind: "none" });
    // A focus with nothing eligible is still nothing: the card is gone.
    expect(resolveComposerTarget({ eligible: [], focused: "ref-a", released: false })).toEqual({ kind: "none" });
  });

  it("exactly one eligible gate binds on its own — #2566's single-gate case", () => {
    expect(resolveComposerTarget({ eligible: ["ref-a"], focused: null, released: false })).toEqual({
      kind: "target",
      ref: "ref-a",
      explicit: false,
    });
  });

  it("TWO eligible gates and no focus → ambiguous, NEVER a pick", () => {
    const resolution = resolveComposerTarget({
      eligible: ["ref-a", "ref-b"],
      focused: null,
      released: false,
    });
    expect(resolution).toEqual({ kind: "ambiguous", count: 2 });
    // The property that matters: no branch of the union carries a ref here.
    expect(resolution).not.toHaveProperty("ref");
  });

  it("an explicit focus resolves the ambiguity, and says it was explicit", () => {
    expect(
      resolveComposerTarget({ eligible: ["ref-a", "ref-b"], focused: "ref-b", released: false }),
    ).toEqual({ kind: "target", ref: "ref-b", explicit: true });
  });

  it("registration ORDER is not a tiebreak — the last one in does not win", () => {
    expect(resolveComposerTarget({ eligible: ["ref-a", "ref-b", "ref-c"], focused: null, released: false })).toEqual(
      { kind: "ambiguous", count: 3 },
    );
    // Reversing the order changes nothing: there is no "latest gate" rule here.
    expect(resolveComposerTarget({ eligible: ["ref-c", "ref-b", "ref-a"], focused: null, released: false })).toEqual(
      { kind: "ambiguous", count: 3 },
    );
  });

  it("a RELEASE beats the single-gate rule — a lone review is refusable", () => {
    // Without this the composer could not be given back: one open review would
    // turn every chat message into a comment, and on a single-target automatic
    // gate a comment resolves as `changes_requested`.
    expect(
      resolveComposerTarget({ eligible: ["ref-a"], focused: null, released: true }),
    ).toEqual({ kind: "none" });
  });

  it("a RELEASE also silences the ambiguity prompt — the reader answered it", () => {
    expect(
      resolveComposerTarget({ eligible: ["ref-a", "ref-b"], focused: null, released: true }),
    ).toEqual({ kind: "none" });
  });

  it("an explicit focus OUTRANKS a release (taking the binding back)", () => {
    expect(
      resolveComposerTarget({ eligible: ["ref-a"], focused: "ref-a", released: true }),
    ).toEqual({ kind: "target", ref: "ref-a", explicit: true });
  });

  it("a STALE focus (no longer eligible) is not a target — it falls through", () => {
    // Two others open, the focused one gone: back to ambiguous, not to the
    // gate the reader chose a while ago and can no longer see as open.
    expect(
      resolveComposerTarget({ eligible: ["ref-a", "ref-b"], focused: "ref-gone", released: false }),
    ).toEqual({ kind: "ambiguous", count: 2 });
    // One other open: the single-gate rule applies, IMPLICITLY — the stale
    // choice must not be reported as the reader's current one.
    expect(resolveComposerTarget({ eligible: ["ref-a"], focused: "ref-gone", released: false })).toEqual({
      kind: "target",
      ref: "ref-a",
      explicit: false,
    });
  });
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

describe("createComposerFocusStore", () => {
  it("registration makes a gate eligible; the un-register takes it back", () => {
    const store = createComposerFocusStore();
    expect(store.getSnapshot()).toEqual({ eligible: [], focused: null, released: false });
    const release = store.registerEligible("ref-a", noComment);
    expect(store.getSnapshot().eligible).toEqual(["ref-a"]);
    release();
    expect(store.getSnapshot().eligible).toEqual([]);
  });

  it("the comment action is reachable ONLY while the gate is eligible", async () => {
    const store = createComposerFocusStore();
    const comment = vi.fn<ComposerCommentAction>(async () => ({ ok: true, message: "done" }));
    expect(store.getCommentAction("ref-a")).toBeUndefined();
    const release = store.registerEligible("ref-a", comment);
    await store.getCommentAction("ref-a")?.("shorten the intro");
    expect(comment).toHaveBeenCalledWith("shorten the intro");
    release();
    // A card that unmounted takes its transport with it — the composer cannot
    // post a comment through a gate that is no longer on screen.
    expect(store.getCommentAction("ref-a")).toBeUndefined();
  });

  it("REF-COUNTS: two mounts of one gate survive a single unmount", () => {
    const store = createComposerFocusStore();
    const releaseA = store.registerEligible("ref-a", noComment);
    const releaseB = store.registerEligible("ref-a", noComment);
    expect(store.getSnapshot().eligible).toEqual(["ref-a"]);
    releaseA();
    // Still shown by the other mount — a double-invoked effect (React
    // development mode) must not strike a live card off the composer.
    expect(store.getSnapshot().eligible).toEqual(["ref-a"]);
    releaseB();
    expect(store.getSnapshot().eligible).toEqual([]);
  });

  it("a double-release is idempotent — it cannot decrement another mount", () => {
    const store = createComposerFocusStore();
    const releaseA = store.registerEligible("ref-a", noComment);
    const releaseB = store.registerEligible("ref-a", noComment);
    releaseA();
    releaseA();
    releaseA();
    expect(store.getSnapshot().eligible).toEqual(["ref-a"]);
    releaseB();
    expect(store.getSnapshot().eligible).toEqual([]);
  });

  it("a re-registering card REPLACES its own action rather than stacking one", async () => {
    const store = createComposerFocusStore();
    const first = vi.fn<ComposerCommentAction>(async () => ({ ok: true, message: "first" }));
    const second = vi.fn<ComposerCommentAction>(async () => ({ ok: true, message: "second" }));
    store.registerEligible("ref-a", first);
    store.registerEligible("ref-a", second);
    expect(await store.getCommentAction("ref-a")?.("hi")).toEqual({
      ok: true,
      message: "second",
    });
    expect(first).not.toHaveBeenCalled();
  });

  it("focus / clearFocus move the binding, and notify subscribers", () => {
    const store = createComposerFocusStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.registerEligible("ref-a", noComment);
    store.registerEligible("ref-b", noComment);
    listener.mockClear();

    store.focus("ref-b");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(resolveComposerTarget(store.getSnapshot())).toEqual({
      kind: "target",
      ref: "ref-b",
      explicit: true,
    });

    // Re-focusing the same ref is a no-op, so a repeated press cannot churn
    // every subscribed card.
    listener.mockClear();
    store.focus("ref-b");
    expect(listener).not.toHaveBeenCalled();

    // clearFocus RELEASES: the reader answered the "which one" question by
    // saying "neither", so the prompt stops asking and nothing routes.
    store.clearFocus();
    expect(resolveComposerTarget(store.getSnapshot())).toEqual({ kind: "none" });
    unsubscribe();
    listener.mockClear();
    store.focus("ref-a");
    expect(listener).not.toHaveBeenCalled();
  });

  it("the snapshot IDENTITY is stable between mutations (useSyncExternalStore)", () => {
    const store = createComposerFocusStore();
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);
    store.registerEligible("ref-a", noComment);
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(store.getSnapshot()).toBe(after);
  });

  it("clearFocus RELEASES, and focus takes the binding back", () => {
    const store = createComposerFocusStore();
    store.registerEligible("ref-a", noComment);
    // Bound with no press at all (#2566's single-gate case).
    expect(resolveComposerTarget(store.getSnapshot())).toMatchObject({ kind: "target" });
    store.clearFocus();
    expect(store.getSnapshot().released).toBe(true);
    expect(resolveComposerTarget(store.getSnapshot())).toEqual({ kind: "none" });
    store.focus("ref-a");
    expect(store.getSnapshot().released).toBe(false);
    expect(resolveComposerTarget(store.getSnapshot())).toEqual({
      kind: "target",
      ref: "ref-a",
      explicit: true,
    });
  });

  it("a release is scoped to the reviews it was made against", () => {
    const store = createComposerFocusStore();
    const releaseA = store.registerEligible("ref-a", noComment);
    store.clearFocus();
    expect(resolveComposerTarget(store.getSnapshot())).toEqual({ kind: "none" });
    // A SECOND review arriving while the first is still open does not re-offer
    // the binding — the reader said "not now" and nothing has changed for them.
    const releaseB = store.registerEligible("ref-b", noComment);
    expect(resolveComposerTarget(store.getSnapshot())).toEqual({ kind: "none" });
    // But once every review is gone, a later one starts fresh: a single release
    // must not disable the composer binding for the rest of the thread.
    releaseA();
    releaseB();
    store.registerEligible("ref-c", noComment);
    expect(resolveComposerTarget(store.getSnapshot())).toEqual({
      kind: "target",
      ref: "ref-c",
      explicit: false,
    });
  });

  it("un-registering the FOCUSED gate cannot leave it routable", () => {
    const store = createComposerFocusStore();
    store.registerEligible("ref-a", noComment);
    const releaseB = store.registerEligible("ref-b", noComment);
    store.focus("ref-b");
    releaseB();
    // The raw focus value may still say "ref-b" — the reducer is what decides,
    // and it refuses to route to a gate that is no longer on screen.
    expect(resolveComposerTarget(store.getSnapshot())).toEqual({
      kind: "target",
      ref: "ref-a",
      explicit: false,
    });
    expect(store.getCommentAction("ref-b")).toBeUndefined();
  });
});
