// ---------------------------------------------------------------------------
// Fixture data for the ONE-OFF surfaces of the in-conversation lifecycle
// drawing (cinatra#3165, epic #3155 W9).
//
// W9 is the wave with no family to reuse: twelve surfaces that each stand for
// one thing the drawing says once. Four of them are addressable on the default
// branch today and are mounted by `lifecycle-one-off-fixtures.tsx` from the
// SHIPPED components; the other eight are recorded on the wave's
// surface-readiness list (tests/e2e/design/conformance/contract.ts) with the
// pull request or the missing anchor that will make them addressable, and are
// not approximated here.
//
// THIS FILE CARRIES NO PRODUCT BEHAVIOUR. It names the raw inputs a mount is
// given — an artifact's title and type id, one surfaced suggestion, the host
// vocabulary, the reader partitions — in the protocol's own shapes. What is
// then DRAWN from them (the type's display label, the chip's state, the control
// it offers, the sentence under a read-only row) is computed by the shipped
// components, never written down here.
// ---------------------------------------------------------------------------

import type {
  LifecycleCardHost,
  LifecycleSuggestion,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

/**
 * The reviewed target the §II / §XIII.1 mounts pin.
 *
 * ANTI-LOOKALIKE ON PURPOSE. The manifest binds `review-target-in-thread.name`
 * to `type.displayName` — the TYPE's short display label, not the artifact's
 * own title — so the two must share no token: a driver that read the title and
 * reported the type binding would otherwise pass. "Quarterly outreach draft"
 * and the label the product derives from `@acme/email:draft` have no word
 * in common.
 *
 * The label itself is NOT written here: the mount derives it with the shipped
 * `reviewTypeLabel`, which is the same function the review surface model uses
 * to compose a real gate's header, and {@link LIFECYCLE_REVIEW_TARGET_TYPE_LABEL}
 * below is the expectation the driver reconciles that derivation against.
 */
export const LIFECYCLE_REVIEW_TARGET_FIXTURE = {
  title: "Quarterly outreach draft",
  objectType: "@acme/email:draft",
  revisionId: "rev_8f3a4c21b7d0",
  facts: ["Team", "Private", "text/html", "updated 8 min ago"],
} as const;

/**
 * What `reviewTypeLabel(LIFECYCLE_REVIEW_TARGET_FIXTURE.objectType)` produces.
 *
 * It is stated once, here, as the EXPECTATION rather than as the value the
 * mount draws: the mount calls the shipped function, so a change to how the
 * product derives a type's display name moves the DOM away from this string and
 * reds the field driver instead of quietly re-defining what the field means.
 */
export const LIFECYCLE_REVIEW_TARGET_TYPE_LABEL = "Email";

/** The reason the §IV "no longer open" reading is drawn with. */
export const LIFECYCLE_REVIEW_BLOCKED_REASON = "no-longer-pending" as const;

/**
 * The four hosts §IX's presence matrix draws a column for, in the drawing's own
 * order. Typed as the protocol's host union, so a host the product retires (or
 * renames) is a typecheck failure here rather than a matrix cell that quietly
 * stops meaning anything.
 *
 * NOTHING IS MOUNTED FOR THAT MATRIX TODAY (it is on the wave's readiness list:
 * only a card that reads the host declaration can grade a presence claim, and
 * every shipped one resolves through the lifecycle-card transport first). This
 * list is what the written driver iterates, so the day such a mount lands the
 * columns it expects are already named here.
 */
export const LIFECYCLE_PRESENCE_HOSTS: readonly LifecycleCardHost[] = [
  "chat_thread",
  "site_widget",
  "run_card",
  "page_gate_region",
];

/**
 * The rows of §IX's reader matrix that are MOUNTED — what the READER may do,
 * which is what holds a card back or lets it through. They are drawn by handing
 * the shipped component the two different inputs the review card itself hands it
 * (a mark handler exactly when the reader may decide), never by styling one
 * reading to look like another.
 *
 * The matrix's third row, `may-not-read`, is deliberately NOT here. Its absence
 * is decided inside the review card — before an authorized resolve, and again
 * when the reader may not read the target — and reaching either needs the
 * transport this harness may not stand up. Drawing it from an empty suggestion
 * set would assert what an empty list does, so it is on the readiness list
 * instead (tests/e2e/design/conformance/contract.ts).
 */
export const LIFECYCLE_READER_STATES = ["may-view-and-act", "may-view-not-act"] as const;

export type LifecycleReaderState = (typeof LIFECYCLE_READER_STATES)[number];

/**
 * The one surfaced suggestion §IX's reader matrix draws a card with. The chips
 * are the piece of the review card a harness can mount as the product mounts it
 * (cinatra#3156), and the reader's reading is exactly what they compute from the
 * input they are handed.
 */
export const LIFECYCLE_MATRIX_SUGGESTION: LifecycleSuggestion = {
  id: "conformance-one-off-suggestion-1",
  label: "opening",
  op: "replace",
  message: "Open on the reader's own quarter, not on ours.",
  before: "we have had a strong quarter",
  after: "Your team closed out the quarter ahead of plan.",
};
