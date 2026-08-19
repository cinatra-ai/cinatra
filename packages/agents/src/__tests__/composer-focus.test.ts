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
  type ComposerCardActions,
  type ComposerCommentAction,
  type ComposerDecideAction,
  type ComposerEligibleCard,
} from "../lifecycle-card-runtime";

const noComment: ComposerCommentAction = async () => ({ ok: true, message: "ok" });
const noDecide: ComposerDecideAction = async () => ({ ok: true, message: "ok" });
const noActions: ComposerCardActions = { comment: noComment, decide: noDecide };

/** A review card, the kind that ships today. */
const review = (ref: string): ComposerEligibleCard => ({
  ref,
  kind: "artifact_review_gate",
});
/** A NON-review lifecycle card — the binding is kind-generic (cinatra#2853). */
const schedule = (ref: string): ComposerEligibleCard => ({
  ref,
  kind: "trigger_schedule_proposal",
});

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
    expect(resolveComposerTarget({ eligible: [review("ref-a")], focused: null, released: false })).toEqual({
      kind: "target",
      ref: "ref-a",
      cardKind: "artifact_review_gate",
      explicit: false,
    });
  });

  it("TWO eligible gates and no focus → ambiguous, NEVER a pick", () => {
    const resolution = resolveComposerTarget({
      eligible: [review("ref-a"), review("ref-b")],
      focused: null,
      released: false,
    });
    expect(resolution).toEqual({
      kind: "ambiguous",
      count: 2,
      cards: [review("ref-a"), review("ref-b")],
    });
    // The property that matters: no branch of the union carries a ref here.
    expect(resolution).not.toHaveProperty("ref");
  });

  it("an explicit focus resolves the ambiguity, and says it was explicit", () => {
    expect(
      resolveComposerTarget({ eligible: [review("ref-a"), review("ref-b")], focused: "ref-b", released: false }),
    ).toEqual({ kind: "target", ref: "ref-b", cardKind: "artifact_review_gate", explicit: true });
  });

  it("registration ORDER is not a tiebreak — the last one in does not win", () => {
    expect(resolveComposerTarget({ eligible: [review("ref-a"), review("ref-b"), review("ref-c")], focused: null, released: false })).toEqual(
      { kind: "ambiguous", count: 3, cards: [review("ref-a"), review("ref-b"), review("ref-c")] },
    );
    // Reversing the order changes nothing: there is no "latest gate" rule here.
    expect(resolveComposerTarget({ eligible: [review("ref-c"), review("ref-b"), review("ref-a")], focused: null, released: false })).toEqual(
      { kind: "ambiguous", count: 3, cards: [review("ref-c"), review("ref-b"), review("ref-a")] },
    );
  });

  it("a RELEASE beats the single-gate rule — a lone review is refusable", () => {
    // Without this the composer could not be given back: one open review would
    // turn every chat message into a comment, and on a single-target automatic
    // gate a comment resolves as `changes_requested`.
    expect(
      resolveComposerTarget({ eligible: [review("ref-a")], focused: null, released: true }),
    ).toEqual({ kind: "none" });
  });

  it("a RELEASE also silences the ambiguity prompt — the reader answered it", () => {
    expect(
      resolveComposerTarget({ eligible: [review("ref-a"), review("ref-b")], focused: null, released: true }),
    ).toEqual({ kind: "none" });
  });

  it("an explicit focus OUTRANKS a release (taking the binding back)", () => {
    expect(
      resolveComposerTarget({ eligible: [review("ref-a")], focused: "ref-a", released: true }),
    ).toEqual({ kind: "target", ref: "ref-a", cardKind: "artifact_review_gate", explicit: true });
  });

  it("a STALE focus (no longer eligible) is not a target — it falls through", () => {
    // Two others open, the focused one gone: back to ambiguous, not to the
    // gate the reader chose a while ago and can no longer see as open.
    expect(
      resolveComposerTarget({ eligible: [review("ref-a"), review("ref-b")], focused: "ref-gone", released: false }),
    ).toEqual({ kind: "ambiguous", count: 2, cards: [review("ref-a"), review("ref-b")] });
    // One other open: the single-gate rule applies, IMPLICITLY — the stale
    // choice must not be reported as the reader's current one.
    expect(resolveComposerTarget({ eligible: [review("ref-a")], focused: "ref-gone", released: false })).toEqual({
      kind: "target",
      ref: "ref-a",
      cardKind: "artifact_review_gate",
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
    const release = store.registerEligible(review("ref-a"), noActions);
    expect(store.getSnapshot().eligible).toEqual([review("ref-a")]);
    release();
    expect(store.getSnapshot().eligible).toEqual([]);
  });

  it("the comment action is reachable ONLY while the gate is eligible", async () => {
    const store = createComposerFocusStore();
    const comment = vi.fn<ComposerCommentAction>(async () => ({ ok: true, message: "done" }));
    expect(store.getCardActions("ref-a")).toBeUndefined();
    const release = store.registerEligible(review("ref-a"), { comment, decide: noDecide });
    await store.getCardActions("ref-a")?.comment("shorten the intro");
    expect(comment).toHaveBeenCalledWith("shorten the intro");
    release();
    // A card that unmounted takes its transport with it — the composer cannot
    // post a comment through a gate that is no longer on screen.
    expect(store.getCardActions("ref-a")).toBeUndefined();
  });

  it("REF-COUNTS: two mounts of one gate survive a single unmount", () => {
    const store = createComposerFocusStore();
    const releaseA = store.registerEligible(review("ref-a"), noActions);
    const releaseB = store.registerEligible(review("ref-a"), noActions);
    expect(store.getSnapshot().eligible).toEqual([review("ref-a")]);
    releaseA();
    // Still shown by the other mount — a double-invoked effect (React
    // development mode) must not strike a live card off the composer.
    expect(store.getSnapshot().eligible).toEqual([review("ref-a")]);
    releaseB();
    expect(store.getSnapshot().eligible).toEqual([]);
  });

  it("a double-release is idempotent — it cannot decrement another mount", () => {
    const store = createComposerFocusStore();
    const releaseA = store.registerEligible(review("ref-a"), noActions);
    const releaseB = store.registerEligible(review("ref-a"), noActions);
    releaseA();
    releaseA();
    releaseA();
    expect(store.getSnapshot().eligible).toEqual([review("ref-a")]);
    releaseB();
    expect(store.getSnapshot().eligible).toEqual([]);
  });

  it("a re-registering card REPLACES its own action rather than stacking one", async () => {
    const store = createComposerFocusStore();
    const first = vi.fn<ComposerCommentAction>(async () => ({ ok: true, message: "first" }));
    const second = vi.fn<ComposerCommentAction>(async () => ({ ok: true, message: "second" }));
    store.registerEligible(review("ref-a"), { comment: first, decide: noDecide });
    store.registerEligible(review("ref-a"), { comment: second, decide: noDecide });
    expect(await store.getCardActions("ref-a")?.comment("hi")).toEqual({
      ok: true,
      message: "second",
    });
    expect(first).not.toHaveBeenCalled();
  });

  it("focus / clearFocus move the binding, and notify subscribers", () => {
    const store = createComposerFocusStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.registerEligible(review("ref-a"), noActions);
    store.registerEligible(review("ref-b"), noActions);
    listener.mockClear();

    store.focus("ref-b");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(resolveComposerTarget(store.getSnapshot())).toEqual({
      kind: "target",
      ref: "ref-b",
      cardKind: "artifact_review_gate",
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
    store.registerEligible(review("ref-a"), noActions);
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(store.getSnapshot()).toBe(after);
  });

  it("clearFocus RELEASES, and focus takes the binding back", () => {
    const store = createComposerFocusStore();
    store.registerEligible(review("ref-a"), noActions);
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
      cardKind: "artifact_review_gate",
      explicit: true,
    });
  });

  it("a release is scoped to the reviews it was made against", () => {
    const store = createComposerFocusStore();
    const releaseA = store.registerEligible(review("ref-a"), noActions);
    store.clearFocus();
    expect(resolveComposerTarget(store.getSnapshot())).toEqual({ kind: "none" });
    // A SECOND review arriving while the first is still open does not re-offer
    // the binding — the reader said "not now" and nothing has changed for them.
    const releaseB = store.registerEligible(review("ref-b"), noActions);
    expect(resolveComposerTarget(store.getSnapshot())).toEqual({ kind: "none" });
    // But once every review is gone, a later one starts fresh: a single release
    // must not disable the composer binding for the rest of the thread.
    releaseA();
    releaseB();
    store.registerEligible(review("ref-c"), noActions);
    expect(resolveComposerTarget(store.getSnapshot())).toEqual({
      kind: "target",
      ref: "ref-c",
      cardKind: "artifact_review_gate",
      explicit: false,
    });
  });

  it("un-registering the FOCUSED gate cannot leave it routable", () => {
    const store = createComposerFocusStore();
    store.registerEligible(review("ref-a"), noActions);
    const releaseB = store.registerEligible(review("ref-b"), noActions);
    store.focus("ref-b");
    releaseB();
    // The raw focus value may still say "ref-b" — the reducer is what decides,
    // and it refuses to route to a gate that is no longer on screen.
    expect(resolveComposerTarget(store.getSnapshot())).toEqual({
      kind: "target",
      ref: "ref-a",
      cardKind: "artifact_review_gate",
      explicit: false,
    });
    expect(store.getCardActions("ref-b")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// KIND-GENERIC BINDING (cinatra#2853; plan §2.1 "the deterministic
// pick-the-card binding covers ALL lifecycle card kinds, not only reviews")
// ---------------------------------------------------------------------------
//
// The reducer never branches on the kind — it CARRIES it. These pin that: the
// same rules bind, release and refuse whatever kind is on screen, and the kind
// survives the resolution so the surface above can say what is waiting.

describe("the binding covers every lifecycle card kind", () => {
  it("a lone NON-review card binds the composer exactly as a lone review does", () => {
    const store = createComposerFocusStore();
    store.registerEligible(schedule("sched-1"), noActions);
    expect(resolveComposerTarget(store.getSnapshot())).toEqual({
      kind: "target",
      ref: "sched-1",
      cardKind: "trigger_schedule_proposal",
      explicit: false,
    });
  });

  it("a MIXED set with nothing picked is ambiguous, and names both kinds", () => {
    const store = createComposerFocusStore();
    store.registerEligible(review("ref-a"), noActions);
    store.registerEligible(schedule("sched-1"), noActions);
    // Nothing routes. Not to the review because it is a review, not to the
    // schedule because it arrived last — the reader has not said which.
    expect(resolveComposerTarget(store.getSnapshot())).toEqual({
      kind: "ambiguous",
      count: 2,
      cards: [review("ref-a"), schedule("sched-1")],
    });
  });

  it("an explicit pick resolves a MIXED set, and reports the picked kind", () => {
    const store = createComposerFocusStore();
    store.registerEligible(review("ref-a"), noActions);
    store.registerEligible(schedule("sched-1"), noActions);
    store.focus("sched-1");
    expect(resolveComposerTarget(store.getSnapshot())).toEqual({
      kind: "target",
      ref: "sched-1",
      cardKind: "trigger_schedule_proposal",
      explicit: true,
    });
  });

  it("a card publishes BOTH of its controls, and the composer calls the card's own", async () => {
    const store = createComposerFocusStore();
    const comment = vi.fn<ComposerCommentAction>(async () => ({ ok: true, message: "commented" }));
    const decide = vi.fn<ComposerDecideAction>(async () => ({ ok: true, message: "decided" }));
    const release = store.registerEligible(review("ref-a"), { comment, decide });

    expect(await store.getCardActions("ref-a")?.comment("shorten the intro")).toEqual({
      ok: true,
      message: "commented",
    });
    expect(await store.getCardActions("ref-a")?.decide("approve", null)).toEqual({
      ok: true,
      message: "decided",
    });
    expect(decide).toHaveBeenCalledWith("approve", null);

    // A card that unmounted takes BOTH transports with it — the composer can
    // neither comment on nor decide a gate that is no longer on screen.
    release();
    expect(store.getCardActions("ref-a")).toBeUndefined();
  });
});
