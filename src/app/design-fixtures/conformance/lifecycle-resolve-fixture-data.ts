// ---------------------------------------------------------------------------
// Fixture data for the RESOLVE-BACKED lifecycle card families (cinatra#3164,
// epic #3155 W8): the verification card (§VII), the review card's state ladder
// (§IV), and the decision floor the suggestion chips ride on (§VIII).
//
// WHY THIS FILE EXISTS, AND WHAT IT IS NOT.
//
// The suggestion chips W0 covered are props-only: the harness mounts them and
// the shipped component draws. Every card in THIS wave is different. It draws
// nothing at all until an AUTHORIZED RESOLVE has answered
// (`useLifecycleCardResolve` → POST /api/lifecycle-views/resolve), and that is
// the epic's whole posture: no card DOM before the server has said what this
// reader may see. A conformance harness has no session, so the ONE thing seeded
// for these families is THE SERVER'S ANSWER — in the protocol's own wire shape,
// at the card's own seam.
//
// NOTHING ELSE IS SUBSTITUTED, AND THE SEEDED ANSWER IS NOT A DRAWING. The
// answer is read by the SHIPPED parse (`parseLifecycleResolveEnvelope`), which
// refuses anything that is not a well-formed envelope for the kind that asked;
// everything after that parse is the shipped card's own: which rung of §IV's
// ladder is drawn, whether any DOM is drawn at all, which controls the floor
// offers, whether they are disabled and what the reason says, and every value on
// the verification card. A row below names a READING — never what is drawn for
// it, and never a control's name.
//
// THE SEEDING IS DONE BY THE TEST, NOT BY THE APP. The driver
// (tests/e2e/design/conformance/contract.ts) fulfils exactly the card's own
// resolve request from this table and then opens the harness. No product module
// is wrapped and no transport is patched inside the application: a harness page
// opened WITHOUT the driver's seam issues the same real request every host
// issues, and off a session it is answered with nothing — which is why the cards
// below draw nothing at all outside this suite.
//
// THIS FILE CARRIES NO PRODUCT BEHAVIOUR. It is a table of wire answers in the
// protocol's own types, so a change to what a lifecycle answer carries is a
// typecheck failure here rather than a fixture that quietly stops resembling the
// wire.
// ---------------------------------------------------------------------------

import type {
  LifecycleCardHost,
  LifecycleCardState,
  LifecycleSuggestion,
  VerificationSummaryBody,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

/**
 * The path the shipped card resolves on. Kept as a literal here so the
 * Playwright driver can seed the answer without importing a client module; the
 * harness mount checks it against the SHIPPED constant
 * (`LIFECYCLE_VIEW_RESOLVE_PATH`) at both compile time and mount time, so the
 * two can never drift apart in silence.
 */
export const LIFECYCLE_RESOLVE_PATH = "/api/lifecycle-views/resolve";

/**
 * The mounts this wave draws. Unlike the suggestion chips — whose spec anchors
 * may appear as a literal in exactly ONE production module, which is why a chip
 * row names a mount and the driver map binds it to a surface — these mounts
 * carry the manifest surface id itself, the way every other surface on this
 * harness does.
 */
export const LIFECYCLE_RESOLVE_MOUNTS = [
  "verification-verified",
  "verification-drift",
  "verification-findings-not-met",
  "verification-in-thread",
  "state-loading",
  "state-restricted",
  "state-no-longer-open",
  "state-absent",
  "suggestion-floor",
] as const;

export type LifecycleResolveMount = (typeof LIFECYCLE_RESOLVE_MOUNTS)[number];

type LifecycleResolveFixtureCommon = {
  /** The harness mount, carried as `data-surface-id`. */
  mount: LifecycleResolveMount;
  /**
   * The host this mount declares. §IX: every card appears on every host and is
   * the same card wherever it appears — only the frame changes — so the host is
   * part of the reading a row seeds, and the driver reads it back off the card's
   * own `data-lifecycle-card-host`.
   */
  host: LifecycleCardHost;
  /** The opaque ref the card was minted with; the driver keys the answer on it. */
  ref: string;
  /** The state the server answers with. The card decides what that draws. */
  state: LifecycleCardState;
};

export type LifecycleResolveFixture =
  | (LifecycleResolveFixtureCommon & {
      kind: "verification_summary";
      body: VerificationSummaryBody;
    })
  | (LifecycleResolveFixtureCommon & { kind: "artifact_review_gate"; body: null });

/** The wire answer for one row — `{ kind, state, body }`, exactly what the
 *  resolve route returns and exactly what the shipped parse reads. */
export function lifecycleResolveAnswer(fixture: LifecycleResolveFixture): {
  kind: LifecycleResolveFixture["kind"];
  state: LifecycleCardState;
  body: VerificationSummaryBody | null;
} {
  return { kind: fixture.kind, state: fixture.state, body: fixture.body };
}

/**
 * The two pinned revisions every verification reading is between. §VII draws
 * them in mono, in this order, and the driver reads both back off the card.
 */
const REVIEWED_REVISION = "rev-base";
const REPAIRED_REVISION = "rev-repaired";

/** The provenance §VII puts in the body of a SERVICE comment, never on a line of
 *  its own — so it is seeded as a comment and asserted as one. */
const SERVICE_PROVENANCE_COMMENT = {
  authorKind: "service",
  body: "Core analysis of 3 disclosed field(s). 3 disclosed field(s) carry content.",
} as const;

/**
 * ANTI-LOOKALIKE by construction (the seeded-kit rule of cinatra#986): the
 * before and after of every row share no token, so a card that rendered the
 * wrong side of a row is a red rather than a lookalike pass.
 */
const SUBJECT_ROW = {
  field: "subject",
  before: "Reengage Q3 churned cohort",
  after: "Win back your Q3 favourites",
  inScope: true,
} as const;

const BODY_ROW = {
  field: "body",
  before: "Old body copy that needed a rewrite.",
  after: "Fresh re-engagement copy with a clear CTA.",
  inScope: true,
} as const;

/**
 * The out-of-scope row §VII marks IN PLACE: a field that changed which the
 * review never authorized. It is `inScope: false` on the row — the server's own
 * mark — and the card is what decides how that is drawn.
 */
const DRIFTED_ROW = {
  field: "bcc",
  before: null,
  after: "a recipient the review never covered",
  inScope: false,
} as const;

/**
 * The row of an unmet finding: the field was inspected and did NOT move, so
 * before and after are the same value. §VII: "One requested change is absent
 * from the repaired revision."
 */
const UNMOVED_BODY_ROW = {
  field: "body",
  before: "Old body copy that needed a rewrite.",
  after: "Old body copy that needed a rewrite.",
  inScope: true,
} as const;

function verificationBody(
  outcome: VerificationSummaryBody["outcome"],
  fieldDiff: VerificationSummaryBody["fieldDiff"],
): VerificationSummaryBody {
  return {
    version: 1,
    outcome,
    reviewedRevisionId: REVIEWED_REVISION,
    repairedRevisionId: REPAIRED_REVISION,
    fieldDiff,
    advisoryComments: [SERVICE_PROVENANCE_COMMENT],
  };
}

/**
 * The two suggestions the decision floor carries. §VIII: the chips have no
 * submit of their own — "they ride the review card's one terminal decision" —
 * so the floor beneath them is what this row is seeded to draw.
 */
const FLOOR_SUGGESTIONS: LifecycleSuggestion[] = [
  {
    id: "conformance-floor-suggestion-1",
    label: "Subject line",
    op: "replace",
    message: "Open on the reader's own question rather than on ours.",
    before: "Re-connecting on Q3 priorities",
    after: "A quick question about your Q3 pilot",
  },
  {
    id: "conformance-floor-suggestion-2",
    label: "Closing ask",
    op: "replace",
    message: "Make the ask concrete and small.",
    before: "Are you open to a short call next week?",
    after: "Book 15 minutes here — no prep needed.",
  },
];

export const LIFECYCLE_RESOLVE_FIXTURES: readonly LifecycleResolveFixture[] = [
  // §VII — the three outcomes. Every row is drawn on the CONVERSATION host,
  // because the enumerated adapter this harness mounts through is the
  // conversation's own renderable-view dispatch; §IX's rule is that the card is
  // the same on every host, and the host it was drawn on is read back off the
  // card rather than assumed.
  {
    mount: "verification-verified",
    host: "chat_thread",
    ref: "conformance-verification-verified",
    kind: "verification_summary",
    state: { state: "advisory" },
    body: verificationBody("verified", [BODY_ROW, SUBJECT_ROW]),
  },
  {
    mount: "verification-drift",
    host: "chat_thread",
    ref: "conformance-verification-drift",
    kind: "verification_summary",
    state: { state: "advisory" },
    body: verificationBody("drifted", [DRIFTED_ROW, BODY_ROW, SUBJECT_ROW]),
  },
  {
    mount: "verification-findings-not-met",
    host: "chat_thread",
    ref: "conformance-verification-unmet",
    kind: "verification_summary",
    state: { state: "advisory" },
    body: verificationBody("unmet", [UNMOVED_BODY_ROW, SUBJECT_ROW]),
  },
  // §VII's worked example of the SAME card in the assistant's turn — the one
  // reading the drawing puts in a conversation, and the drift outcome is the one
  // it draws there.
  {
    mount: "verification-in-thread",
    host: "chat_thread",
    ref: "conformance-verification-in-thread",
    kind: "verification_summary",
    state: { state: "advisory" },
    body: verificationBody("drifted", [DRIFTED_ROW, SUBJECT_ROW]),
  },
  // §IV — the four drawn states, and the one that draws nothing. All four are
  // read the same way on every host (§IX), and the conversation is the host the
  // drawing walks through, so they are seeded there.
  {
    mount: "state-loading",
    host: "chat_thread",
    ref: "conformance-state-loading",
    kind: "artifact_review_gate",
    state: { state: "loading" },
    body: null,
  },
  {
    mount: "state-restricted",
    host: "chat_thread",
    ref: "conformance-state-restricted",
    kind: "artifact_review_gate",
    state: {
      state: "restricted",
      canDecide: false,
      canComment: true,
      reason: "This reader may respond to the review but may not decide it.",
    },
    body: null,
  },
  {
    mount: "state-no-longer-open",
    host: "chat_thread",
    ref: "conformance-state-no-longer-open",
    kind: "artifact_review_gate",
    // A settled gate whose recorded outcome this build could not read: §IV's
    // "no longer open" — the gate was already decided or the run moved on.
    state: { state: "settled" },
    body: null,
  },
  {
    mount: "state-absent",
    host: "chat_thread",
    ref: "conformance-state-absent",
    kind: "artifact_review_gate",
    state: { state: "absent" },
    body: null,
  },
  // §VIII — the floor the chips ride on: a pending gate this reader may decide,
  // carrying two suggestions.
  {
    mount: "suggestion-floor",
    host: "chat_thread",
    ref: "conformance-suggestion-floor",
    kind: "artifact_review_gate",
    state: {
      state: "pending",
      canDecide: true,
      canComment: true,
      suggestions: FLOOR_SUGGESTIONS,
    },
    body: null,
  },
];

/** The mount whose answer is `absent`, and the mount beside it that DRAWS — the
 *  pair §IV's danger callout is about ("restricted and absent are never drawn
 *  for each other"). Named here so the driver reads both from one place. */
export const LIFECYCLE_ABSENT_MOUNT: LifecycleResolveMount = "state-absent";
export const LIFECYCLE_DRAWN_CONTROL_MOUNT: LifecycleResolveMount = "state-restricted";
