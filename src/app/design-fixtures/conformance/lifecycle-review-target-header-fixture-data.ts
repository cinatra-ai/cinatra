// ---------------------------------------------------------------------------
// Fixture data for the ARTIFACT-KIND family of the in-conversation review card
// (cinatra#3157, epic #3155 W1).
//
// The drawing gives every artifact kind the same opening. The rule is worded on
// the review screen's drawing at §IV: "Every target opens with a header that
// names what is under review and fixes it in place: the artifact's display title
// over a mono meta line carrying its type, the pinned representation revision
// (shown as a mono revision id with a pinned marker), and the read-only row facts
// the host authorized — owner level / visibility, MIME, and updated time. The
// header is inert: it exposes no edit control and no revision picker, because the
// target is versioned and frozen." This manifest's own drawing draws that header
// over every kind and rules at §XIII.1 that "nothing in either drawing is
// particular to email except the panel in the middle".
//
// The kinds differ BELOW that line, in the representation the island renders,
// and they are identical ON it. So the artifact-kind cards are one shape with
// one fixture list and one family factory (`reviewTargetHeaderDriver`,
// tests/e2e/design/conformance/contract.ts), exactly as the six extension
// listing cards are driven by `cardDriver` over CONFORMANCE_CARD_FIXTURES and
// the chips by `suggestionChipDriver` over LIFECYCLE_SUGGESTION_CHIP_FIXTURES.
//
// A ROW CARRIES THE ARTIFACT, NOT THE READING. This is the rule the whole file
// turns on. A row seeds only what a stored artifact row carries — title, type
// id, pinned revision id, and the four authorized row values (owner level,
// visibility, MIME, updated instant) — and NOTHING the product composes out of
// them. The type tag's wording and the meta line's row facts are composed by the
// product's own `reviewTypeLabel` and `reviewTargetRowFacts`, the same two calls
// the server-side composer makes (src/lib/lifecycle/lifecycle-target-headers.ts).
// A fixture that named a finished fact instead would make the driver an echo
// test — it would prove only that the React component prints the props it was
// handed, and it would let a row assert a reading the shipped composer cannot
// produce at all. What this family drives is the chain composer → component.
//
// THE RELATIVE TIME IS READ AGAINST A FIXED INSTANT. `reviewTargetRowFacts`
// takes the instant as an argument precisely so a reading is deterministic; the
// harness passes {@link LIFECYCLE_REVIEW_TARGET_HEADER_NOW} and the driver reads
// the line against the same one, so "updated N ago" is stable in a browser run.
//
// TWO DRAWN READINGS THIS WAVE REPORTS RATHER THAN ASSERTS, because the shipped
// composer has no reading for them and a drivers wave does not change product
// code:
//   • the scope pair's CASING. The drawing prints "… · Team · Private · …";
//     `reviewTargetRowFacts` returns the row's stored values verbatim, which are
//     lower case ("team", "private") — see
//     src/lib/artifacts/__tests__/review-surface-model.test.ts. The driver
//     asserts the product's own reading, so the departure is visible in the
//     fixture rather than papered over by a capitalized fixture value.
//   • the CMS page's PLATFORM and page ADDRESS. Its drawn identity line carries
//     both; `reviewTargetRowFacts` composes owner level, visibility, MIME and
//     updated time and nothing else, for every kind alike. There is no product
//     slot to bind them to, so this row seeds none and the two facts stay on the
//     wave's readiness list.
//
// THE TYPE ID IS A STAND-IN VENDOR ID, and it has to be. `objectType` is row
// data an artifact carries, not a registry key: nothing here looks it up, and
// the product words the tag from it purely by shape (scope, package, reading).
// Core source may not name a shipped extension instance — the pinned-empty
// coupling ban (scripts/audit/core-extension-instance-coupling-ban.mjs) is the
// rule, and a conformance fixture is core source like any other. So a row
// carries the drawing's KIND under the repository's stand-in vendor scope
// (`@acme/...`, the way every other fixture and test in this tree spells a
// third-party type), which leaves the drawn reading intact — the meta line
// still carries a type id of the product's own shape, and the tag over it is
// still worded by the product from that id — while naming no extension.
//
// WHAT A ROW DELIBERATELY DOES NOT CARRY. The representation beneath the header
// — the email body, the capture, the pinned dashboard view — is server-rendered
// inside the island document, and no per-kind representation ships on the
// default branch. So no row seeds one and no driver asserts one; the manifest's
// `representation.*` field bindings are on this wave's readiness list instead of
// being approximated here.
// ---------------------------------------------------------------------------

/**
 * The manifest surfaces this family draws. The mount IS the manifest surface id
 * here — the harness's ordinary convention — because none of these ids is also
 * a production anchor (the suggestion chips are the one place that is true of,
 * which is why that family binds mount to surface on the test side instead).
 *
 * The ids are spelled out as literals, and the test that guards this list
 * spells the same seven out AGAIN from the manifest's own vocabulary rather
 * than importing this constant, so dropping a surface from both places at once
 * cannot stay green.
 */
export const LIFECYCLE_REVIEW_TARGET_HEADER_SURFACES = [
  "review-card-email-body",
  "review-card-mixed-kind",
  "review-card-screenshot",
  "review-card-slide-deck",
  "review-card-dashboard",
  "review-card-portlet",
  "review-card-cms-page",
] as const;

export type LifecycleReviewTargetHeaderSurface =
  (typeof LIFECYCLE_REVIEW_TARGET_HEADER_SURFACES)[number];

/**
 * The instant every fixture row's relative updated reading is taken against.
 * Fixed so the browser run reads the same line the driver expects.
 */
export const LIFECYCLE_REVIEW_TARGET_HEADER_NOW = "2026-09-02T12:00:00.000Z";

/**
 * The four authorized values the stored artifact row carries — exactly the
 * argument `reviewTargetRowFacts` reads, and never the facts it returns.
 */
export type LifecycleReviewTargetHeaderRow = {
  ownerLevel: string;
  visibility: string;
  mime: string;
  /** The stored instant; the product words it relative to the fixed now. */
  updatedAt: string;
};

/**
 * One pinned target as the gate carries it — the artifact's own values, minus
 * every reading the product composes (`typeLabel`, `facts`).
 */
export type LifecycleReviewTargetHeaderSeed = {
  title: string;
  objectType: string;
  revisionId: string;
  row: LifecycleReviewTargetHeaderRow;
};

export type LifecycleReviewTargetHeaderFixture = {
  /** The manifest surface this row draws, carried as `data-surface-id`. */
  surfaceId: LifecycleReviewTargetHeaderSurface;
  /**
   * The pinned target(s) of this gate, in gate order.
   *
   * EVERY ROW IN THIS WAVE CARRIES EXACTLY ONE, and the plural reading is NOT
   * exercised here. The mixed-kind gate looked like the row that would exercise
   * it — the drawing draws that kind twice, over text on the markdown display
   * and over pdf in the embedded viewer — but both drawings are the SAME
   * artifact at the SAME pinned revision under two content forms, and target
   * normalization deduplicates that identity
   * (src/lib/artifacts/artifact-review-target.ts), so the gate has one target,
   * not two. The content form is what the manifest binds as
   * `representation.content-form`, which ships nowhere yet.
   *
   * The plural ordering reading therefore stays on this wave's readiness list.
   * It is not seeded with an invented second target, and the shipped list's key
   * (`${revisionId}:${objectType}` in packages/agents/src/review-gate-card.tsx)
   * is reported as a hazard rather than worked around by a fixture value: two
   * distinct artifacts sharing an object type and a revision string collide on
   * it, because the key omits the artifact id that is part of a target's
   * identity.
   */
  headers: readonly LifecycleReviewTargetHeaderSeed[];
};

export const LIFECYCLE_REVIEW_TARGET_HEADER_FIXTURES: readonly LifecycleReviewTargetHeaderFixture[] =
  [
    {
      surfaceId: "review-card-email-body",
      headers: [
        {
          title: "Re-connecting on Q3 priorities",
          objectType: "@acme/email-body:body",
          revisionId: "rev_4c21",
          row: {
            ownerLevel: "team",
            visibility: "private",
            mime: "text/markdown",
            updatedAt: "2026-09-02T11:52:00.000Z",
          },
        },
      ],
    },
    {
      surfaceId: "review-card-mixed-kind",
      headers: [
        {
          title: "Acme brand voice — 2026",
          objectType: "@acme/brand-voice:artifact",
          revisionId: "rev_11b8",
          row: {
            ownerLevel: "team",
            visibility: "private",
            mime: "text/markdown",
            updatedAt: "2026-09-02T11:52:00.000Z",
          },
        },
      ],
    },
    {
      surfaceId: "review-card-screenshot",
      headers: [
        {
          title: "Checkout — step 2",
          objectType: "@acme/screenshot:artifact",
          revisionId: "rev_66d0",
          row: {
            ownerLevel: "team",
            visibility: "private",
            mime: "image/png",
            updatedAt: "2026-09-02T11:52:00.000Z",
          },
        },
      ],
    },
    {
      surfaceId: "review-card-slide-deck",
      headers: [
        {
          title: "Q3 business review",
          objectType: "@acme/slide-deck:artifact",
          revisionId: "rev_9ac3",
          row: {
            ownerLevel: "team",
            visibility: "private",
            mime: "application/pdf",
            updatedAt: "2026-09-02T11:52:00.000Z",
          },
        },
      ],
    },
    {
      surfaceId: "review-card-dashboard",
      headers: [
        {
          title: "Pipeline health — Q3",
          objectType: "@acme/dashboard:dashboard",
          revisionId: "rev_2e77",
          row: {
            ownerLevel: "team",
            visibility: "private",
            mime: "application/json",
            updatedAt: "2026-09-02T11:52:00.000Z",
          },
        },
      ],
    },
    {
      surfaceId: "review-card-portlet",
      headers: [
        {
          title: "Qualified pipeline — Q3",
          objectType: "@acme/dashboard:portlet",
          revisionId: "rev_5b02",
          row: {
            ownerLevel: "team",
            visibility: "private",
            mime: "application/json",
            updatedAt: "2026-09-02T11:52:00.000Z",
          },
        },
      ],
    },
    {
      // The CMS page. Its drawn identity line is the one in this family that
      // carries a PLATFORM and the page ADDRESS among the row facts. The shipped
      // composer has no reading for either — it composes owner level,
      // visibility, MIME and updated time for every kind alike — so this row
      // seeds neither and the driver asserts neither. Both are on the wave's
      // readiness list, where a missing product reading belongs; approximating
      // them through a hand-written fact would only hide the gap. The header
      // itself is the same pinned, inert header as every other kind, and what is
      // particular to this one sits below it in the embedded page and the changed
      // excerpts, which is representation and does not ship. Its `open-in-cms`
      // action is drawn UNDER the representation, not in the header, and no
      // shipped control carries it.
      surfaceId: "review-card-cms-page",
      headers: [
        {
          title: "Pricing — 2026 plans",
          objectType: "@acme/cms-page:content-snapshot",
          revisionId: "rev_c410",
          row: {
            ownerLevel: "team",
            visibility: "private",
            mime: "text/html",
            updatedAt: "2026-09-02T11:52:00.000Z",
          },
        },
      ],
    },
  ];
