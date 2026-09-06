// ---------------------------------------------------------------------------
// Fixture data for the REVIEW-COMPOSER family (cinatra#3159, epic #3155 W3).
//
// §I of the in-conversation lifecycle drawing gives the row above the floor
// THREE readings and ONE control:
//
//   bound       a typed message comments on THIS review   -> release-review-composer
//   ambiguous   several reviews are open, none chosen     -> focus-review-composer
//   unbound     the binding is elsewhere, or given back   -> focus-review-composer
//
// None of the three is chosen here. Each is a branch of `resolveComposerTarget`,
// the shipped reducer the composer itself reads, so the sentence on screen and
// the behaviour on send cannot disagree — and the harness cannot put a row into
// a reading by naming it.
//
// WHAT A ROW HOLDS, AND WHY IT IS NOT AN OUTCOME. Exactly what §I says a reader
// holds: which open review they chose, or that they chose none. That one bit
// goes into the SHIPPED store before the mount renders, the same way W0's chip
// harness holds the reader's dismissal set and nothing else. Which reading each
// row is then drawn in, which control it offers and what that control is NAMED
// are all computed by `resolveComposerTarget` and the shipped row.
//
// WHY A ROW NAMES A MOUNT AND NOT A MANIFEST SURFACE — the same reason W0 gives
// for the chips, and one more. The row is ONE drawn thing that the drawing shows
// in several of its sections, so several manifest surfaces stand for one mount
// (`composer-row-bound` is both the §I row and its `review-composer-bound`
// sentence). A `data-surface-id` per manifest surface would therefore have to
// repeat one row under several names. So a row names its MOUNT here and the
// binding from mount to manifest surface lives on the test side, in the driver
// map, keyed by the mount union — a mount with no manifest surface is a
// typecheck failure rather than an undefined driver key.
//
// THIS FILE CARRIES NO PRODUCT BEHAVIOUR. A row names its mount, the gates the
// reader has open, and which of them the reader chose. Nothing else.
// ---------------------------------------------------------------------------

/** The mounts this family draws. The driver map binds each to the manifest
 *  surfaces it stands for. */
export const LIFECYCLE_COMPOSER_ROW_MOUNTS = [
  "composer-row-bound",
  "composer-row-acting",
  "composer-rows-unbound",
  "composer-row-choosing",
  "composer-row-elsewhere",
  "chat-composer-primary-field",
] as const;

export type LifecycleComposerRowMount = (typeof LIFECYCLE_COMPOSER_ROW_MOUNTS)[number];

export type LifecycleComposerRowFixture = {
  /** The harness mount this row draws, carried as `data-surface-id`. */
  mount: LifecycleComposerRowMount;
  /**
   * The gates this reader has open, in the order the transcript shows them.
   * Every one of them registers with the shipped store; the FIRST is the one
   * whose row this mount draws.
   *
   * One gate is a single open review, which §I binds with no press at all. Two
   * are what makes a choice necessary.
   */
  gates: readonly string[];
  /**
   * Which open review the reader chose, or `null` if they have not chosen.
   *
   * This is the reader's own held state and the only thing the harness carries.
   * A choice that is not the row's own gate is §I's "bound elsewhere"; no choice
   * with several gates open is §I's "none is bound until the reader picks one".
   */
  chosenGate: string | null;
};

export const LIFECYCLE_COMPOSER_ROW_FIXTURES: readonly LifecycleComposerRowFixture[] = [
  // A single open review. §I: it binds the composer with no press at all.
  { mount: "composer-row-bound", gates: ["conformance-gate-solo"], chosenGate: null },
  // The same row, in the section that draws it while the bound composer's own
  // message is being acted on. A second mount rather than a second reading of
  // the first, because the drawing draws it in two places.
  { mount: "composer-row-acting", gates: ["conformance-gate-acting"], chosenGate: null },
  // Two open reviews, no choice made: nothing routes until one is picked.
  {
    mount: "composer-row-choosing",
    gates: ["conformance-gate-choosing-a", "conformance-gate-choosing-b"],
    chosenGate: null,
  },
  // Two open reviews and the reader chose the OTHER one: this row's messages are
  // not going to this review.
  {
    mount: "composer-row-elsewhere",
    gates: ["conformance-gate-elsewhere-a", "conformance-gate-elsewhere-b"],
    chosenGate: "conformance-gate-elsewhere-b",
  },
];

/**
 * The mount that wraps the two UNBOUND readings, which §I draws as one example —
 * "waiting to be told which review, or given back".
 */
export const LIFECYCLE_COMPOSER_UNBOUND_GROUP_MOUNT = "composer-rows-unbound" as const;

/** The mounts drawn inside that group, in the order the drawing shows them. */
export const LIFECYCLE_COMPOSER_UNBOUND_GROUP_ROWS = [
  "composer-row-choosing",
  "composer-row-elsewhere",
] as const;

/** The chat box's own mount. §I: the conversation's ONE primary input. */
export const LIFECYCLE_CHAT_COMPOSER_MOUNT = "chat-composer-primary-field" as const;

/** The placeholder the harness gives the chat box. Presentation only — the
 *  surface declares no field binding. */
export const LIFECYCLE_CHAT_COMPOSER_PLACEHOLDER = "Type a message…";
