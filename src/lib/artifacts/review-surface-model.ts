/**
 * The generic artifact-review SURFACE MODEL (cinatra#1795, epic #1620 S12,
 * item 4). The PURE presentation logic behind the host decision chrome —
 * type-agnostic, keyed on NO concrete artifact type / binding / renderer id
 * (G1-clean): it branches only on the OPAQUE host mount kind + the closed
 * blocked/permission axes. Every seam here is plain data, so the whole
 * §I–VI display+decide matrix is unit-testable without React or a DB.
 *
 * Ratified design spec `specs/app-artifact-review.html`
 * @ design@458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f (owner-approved). This module owns the spec's derived,
 * non-visual mappings (provenance chip class, blocked/permission copy, the
 * per-mount conformance anchor) so the surface components stay thin.
 *
 * BOUNDARY (epic #1620 ADR): the generic surface is display + DECIDE only. No
 * type-owned field renderer, no edit affordance, no renderer-id path — the
 * renderer identity is host-resolved from the artifact TYPE upstream and reaches
 * this model only as the opaque `ReviewTargetMount` kind.
 */
import type {
  PreparedReviewTarget,
  ReviewTargetMount,
} from "@/lib/artifacts/artifact-review-preparation";
import type {
  ReviewDisposition,
  ReviewRunAccessOp,
  SubmitDecisionResult,
} from "@/lib/artifacts/artifact-review-decision";
import type { PinnedCapturePairView } from "@/lib/artifacts/cms-preview-capture-view";
import type { RecordChangesRequestedResult } from "@cinatra-ai/agents/lifecycle-review-changes-requested";

// ---------------------------------------------------------------------------
// The closed blocked axis (§V) — the gate can no longer be prepared or decided.
// A single closed set the surface names; never a silent degrade.
// ---------------------------------------------------------------------------

export type ReviewBlockedReason =
  /** The gate was already decided, or the run moved on (resolved / terminal). */
  | "no-longer-pending"
  /** The caller's view does not match the gate (stale or tampered) — a HARD
   * block, never a silent degrade. */
  | "targets-mismatch"
  /** A pinned revision is no longer a live member (cannot be terminally decided). */
  | "revision-not-live";

/** The user-facing copy for a blocked gate (§V). Title + one-line body; every
 * blocked state offers a refresh back to the live gate (owned by the component). */
export function reviewBlockedCopy(reason: ReviewBlockedReason): {
  title: string;
  body: string;
} {
  switch (reason) {
    case "no-longer-pending":
      return {
        title: "This review is no longer open",
        body: "The gate was already decided or the run moved on.",
      };
    case "targets-mismatch":
      return {
        title: "This review view is out of date",
        body: "What you are looking at no longer matches the gate. Refresh to the live gate.",
      };
    case "revision-not-live":
      return {
        title: "A reviewed revision is no longer live",
        body: "One of the pinned revisions has changed and can no longer be decided.",
      };
  }
}

// ---------------------------------------------------------------------------
// The SETTLED reading (§IV; plan §4.2) — a decided gate names what happened
// ---------------------------------------------------------------------------
//
// `reviewBlockedCopy("no-longer-pending")` above is what a settled card says
// when it knows nothing but the fact that it settled: "the gate was already
// decided OR the run moved on", with a Refresh as the escape hatch for that
// "or". This is the other half — the reading for a card that DOES know, which
// states the outcome and the person who took it and needs no escape hatch,
// because there is no longer an ambiguity for one to resolve.
//
// THE SENTENCES ARE THE SHIPPED ONES. Each body is the decision bar's own
// post-press line (`review-decision-bar.tsx`), minus its leading verb, so the
// card the reviewer read right after pressing and the card everyone reads
// afterwards say the same thing about the same gate. What is deliberately NOT
// carried over is the bar's `requested` / `escalated` split: that is a fact
// about the repair the reviewer's own press started, not about the gate's
// recorded outcome, and a settled card that claimed "a repair is now in flight"
// would be asserting a live state it has not read.
//
// THE DECIDER IS OPTIONAL AND ITS ABSENCE IS QUIET. A gate whose decider has no
// safely displayable name reads "Approved" rather than "Approved by" and a
// dangling nothing — and never an identifier pressed into service as a name.

/** The closed outcome axis a settled review card can name.
 *
 *  Kept as a local union rather than an import so this pure model stays free of
 *  the wire package; `LIFECYCLE_SETTLED_OUTCOMES` in the protocol is the same
 *  set, and a structural test pins the two together. */
export type ReviewSettledOutcome = "approved" | "rejected" | "changes_requested";

/** The user-facing copy for a settled gate whose outcome is recorded. Title +
 *  one line; NO refresh (the component draws none) — the reading is final. */
export function reviewSettledCopy(
  outcome: ReviewSettledOutcome,
  decidedByName?: string,
): { title: string; body: string } {
  const by = decidedByName ? ` by ${decidedByName}` : "";
  switch (outcome) {
    case "approved":
      // CONTINUED (cinatra#3080). The STORED disposition is still `approve` —
      // Continue performs the former approve transition and keeps writing the
      // same value, with no migration — so this is a relabel of the READING and
      // nothing else: a gate decided before the floor was redrawn and one
      // decided after it are the same row and read the same way.
      return {
        title: `Continued${by}`,
        body: "The gate is resolved and the run has been released to continue.",
      };
    case "rejected":
      // LEGACY ONLY (cinatra#3080). No new decision can produce a reject — the
      // decision operation refuses one — but rows decided before the retirement
      // must still read as what they were, so the copy stays.
      return {
        title: `Rejected${by}`,
        body: "The gate is resolved and the reviewed work has been turned back.",
      };
    case "changes_requested":
      // SUPERSEDED (cinatra#3080 acceptance item 4). The STORED disposition is
      // unchanged — Regenerate settles the gate "in the change road's existing
      // representation", with no migration — so this is a relabel of the READING
      // and nothing else. It reads as SUPERSEDED because on this floor the
      // canonical change operation has exactly ONE caller, Regenerate, and the
      // drawing's word for the gate a regeneration settles is `superseded`: the
      // reviewed revision is kept and displayed, and its successor opens beneath
      // it on the next revision. Nothing was turned back and nothing was lost.
      return {
        title: `Superseded${by}`,
        body: "The gate is settled as superseded. The reviewed revision is kept as it was, and the review has moved on from it.",
      };
  }
}

/**
 * THE SETTLED WORD FOR A STORED DISPOSITION (cinatra#3080).
 *
 * The card reads its outcome off the wire's closed set; the RAIL reads the gate
 * row's own column, and used to print it — so a settled Review entry read
 * APPROVE after a Continue and CHANGES_REQUESTED after a Regenerate, the
 * machine's vocabulary on a person's surface. The drawing's rail "records how it
 * was settled (continued, superseded by a regeneration, changes requested)", so
 * every place a disposition is DISPLAYED comes here for the word.
 *
 * Titles only, and they agree with `reviewSettledCopy` by test, so the rail row
 * and the card above it cannot drift into two names for one decision. A value
 * this build does not know reads "Settled" — true, and never a raw column.
 */
export function reviewSettledWord(disposition: string | null | undefined): string {
  switch (disposition) {
    case "approve":
      return "Continued";
    case "changes_requested":
      return "Superseded";
    case "reject":
      return "Rejected";
    default:
      return "Settled";
  }
}

// ---------------------------------------------------------------------------
// Renderer provenance (§III) — the surface shows HOW each target was rendered.
// The conformance anchor is derived from the OPAQUE mount kind, never a type id.
// ---------------------------------------------------------------------------

export type ReviewProvenanceConformanceId =
  | "review-provenance-native"
  | "review-provenance-marketplace"
  | "review-target-floor";

/** The design conformance id for a target's provenance region, from its host
 * mount kind: a build-time renderer → the native chip, a runtime (marketplace-
 * installed) renderer → the marketplace chip, and any floor → the generic-floor
 * anchor (§III). `null` means the target has NO provenance region — the strip is
 * not rendered at all.
 *
 * THE FORM RUNG HAS NO REGION (cinatra#2931 W4, the maintainer's answer of
 * 2026-08-23). The three regions §V draws state which PACKAGE's renderer drew
 * the work, or that nothing did. The host's own rendering of a declared text
 * form is neither: there is no package to name, and the work did render. Rather
 * than reuse a package tier that would name an extension that never ran, or
 * invent a fourth strip the drawing does not carry, the reviewer is shown the
 * draft with nothing above it. */
export function reviewProvenanceConformanceId(
  mount: ReviewTargetMount,
): ReviewProvenanceConformanceId | null {
  switch (mount.kind) {
    case "build-map":
      return "review-provenance-native";
    case "form":
      return null;
    case "runtime":
      return "review-provenance-marketplace";
    case "floor":
      return "review-target-floor";
  }
}

/** The provenance label shown beside the chip (§III). build-time / runtime carry
 * the extension chip; a runtime additionally shows its package identity; a floor
 * reads "Floor". `null` for the form rung, which has no region to label at all
 * (see `reviewProvenanceConformanceId`). Pure copy — no type keying. */
export function reviewProvenanceLabel(mount: ReviewTargetMount): {
  kind: "build-time" | "runtime" | "floor";
  slot: string;
  packageName: string | null;
} | null {
  switch (mount.kind) {
    case "build-map":
      return { kind: "build-time", slot: mount.slot, packageName: mount.packageName };
    case "form":
      return null;
    case "runtime":
      return { kind: "runtime", slot: mount.slot, packageName: mount.packageName };
    case "floor":
      return { kind: "floor", slot: mount.slot, packageName: mount.packageName };
  }
}

// ---------------------------------------------------------------------------
// The immutable target header (§II) — display title + a mono meta line. Pure
// projection of the host-authorized, display-only props; the target is frozen,
// so the header exposes NO edit control and NO revision picker.
// ---------------------------------------------------------------------------

/** Prettify an artifact object-type id into a short type label for the header
 * type tag (§II) — `@cinatra-ai/email:draft` → "Email". Local (not imported
 * from the library client surface) so the review route grows no client-graph
 * coupling. */
export function reviewTypeLabel(objectType: string): string {
  const afterScope = objectType.includes("/")
    ? objectType.slice(objectType.indexOf("/") + 1)
    : objectType;
  const base = (afterScope.split(":")[0] ?? afterScope).trim();
  const pretty = base
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return pretty || objectType;
}

/**
 * The read-only row facts the header's meta line carries (§II) — the ones the
 * drawing names: "the read-only row facts the host authorized — owner level /
 * visibility, MIME, and updated time"
 * (design@fe2182547d4a specs/app-artifact-review.html §IV).
 *
 * THE HONESTY FIX (plan `PLAN: Agents Lifecycle (B)` §5). The line printed the
 * two scope facts BARE, one after the other, so the ordinary case read
 * "organization · organization" — the same word twice for two facts that are not
 * the same thing at all: which scope HOLDS the artifact, and who can SEE it. The
 * plan's fix is that "the line gets labels or drops the storage fact". The
 * drawing keeps BOTH facts on the line ("… · Team · Private · text/html ·
 * updated 8 min ago", specs/app-lifecycle-cards.html §II), so dropping the
 * storage fact would delete a fact the drawing draws: the facts are LABELLED
 * instead, in the drawing's own order, with the label the host already uses for
 * ownership on its other screens.
 *
 * Pure copy, no type keying — every artifact type reads the same line.
 */
export function reviewTargetRowFacts(artifact: {
  ownerLevel: string;
  visibility: string;
  mime: string;
  updatedAt: string;
}): string[] {
  return [
    `Ownership: ${artifact.ownerLevel}`,
    `Visibility: ${artifact.visibility}`,
    artifact.mime,
    `updated ${artifact.updatedAt}`,
  ];
}

/** A short, stable revision marker for the header (§II) — the mono revision id,
 * truncated for display, with the exact id preserved for the title attribute. */
export function reviewRevisionMarker(representationRevisionId: string): {
  short: string;
  full: string;
} {
  const full = representationRevisionId;
  const short = full.length > 14 ? `${full.slice(0, 12)}…` : full;
  return { short, full };
}

// ---------------------------------------------------------------------------
// The decision permission axis (§V) — deciding is run-access gated. A reviewer
// who may SEE the gate but not act on it gets the affordances DISABLED with a
// one-line reason, never a live control that fails on click.
// ---------------------------------------------------------------------------

export interface ReviewDecisionPermissions {
  /** The terminal floor actions, Continue and Regenerate — both require the
   *  run's decision (approve) access; only the WORDS retired, not the right. */
  canDecide: boolean;
  /** Comment — requires respond access on the run. */
  canComment: boolean;
}

/** The one-line reason a terminal decision is disabled (§V), or null when the
 * reviewer may decide. Only reached for a viewer who HAS read access (a viewer
 * with none never reaches the surface — the not-authorized panel). */
export function reviewDecideDisabledReason(
  perms: ReviewDecisionPermissions,
): string | null {
  if (perms.canDecide) return null;
  if (perms.canComment) {
    return "Continue and Regenerate need decision access on the run — you can Comment, but not decide.";
  }
  return "You do not have decision access on the run, so Continue and Regenerate are disabled.";
}

// ---------------------------------------------------------------------------
// The surface model — the discriminated shape the page resolves and the chrome
// renders. `ready` carries the prepared (host-resolved) targets + the producing
// agent's one-line summary when present + the decision permissions.
// ---------------------------------------------------------------------------

export type ReviewSurfaceModel =
  /** A viewer with no read access to the run never sees the targets (§V). */
  | { kind: "not-authorized" }
  /** The gate cannot be prepared or decided (§V) — a single blocked state. */
  | { kind: "blocked"; reason: ReviewBlockedReason }
  /**
   * The gate EXISTS on this run, this reader may read the run, and it has been
   * DECIDED (plan §4.4 step 7: "Everyone looking at that run, in any channel,
   * sees the same settled card"; §4.2).
   *
   * WHY THIS IS ITS OWN KIND rather than a blocked reason. `blocked` is what a
   * surface says when it cannot show the review; a resolved gate is a review it
   * CAN show — the recorded outcome, its decider where one can be named, the
   * recorded suggestion chips — and the one renderer already draws exactly that
   * from its own ref. Collapsing the two is what made the page contradict the
   * transcript about the same gate at the same moment.
   *
   * IT CARRIES THE REVIEWED TARGETS. "A resolved gate opens read-only: what was
   * decided, and the reviewed target(s), kept for the run's audit trail." So the
   * decided reading keeps the work on screen: the same frozen pinned set,
   * prepared through the same never-blank ladder, drawn by the same panel and
   * the same type renderer the pending reading drew. It is the revision the gate
   * pinned and the decision was taken on, never a later one.
   *
   * IT STILL CARRIES NO DECISION. The outcome, its decider and the recorded
   * chips are resolved by the CARD, from the ref, against the live reader
   * (`lifecycle-card-refetch` → `lifecycle-settled-outcome`), which is the same
   * path every other host resolves them on. A second projection of THOSE facts,
   * on one host only, is what would drift — and the card draws no floor here, so
   * nothing on this reading can be decided again.
   *
   * WHAT IT IS NOT. It is NOT reached for an `unavailable` gate. A ref that
   * names nothing and a row too corrupt to read stay `blocked`: they are not a
   * decided review, and a surface that turned them into a settled card would be
   * inventing a decision. The card's own resolver draws the same line
   * (`resolved` → `settled`, `unavailable` → `absent`); this kind is that line,
   * drawn one layer up so the page reaches the card at all.
   */
  | {
      kind: "settled";
      /** The frozen pinned set, prepared READ-ONLY — the reviewed target(s) the
       * decided reading keeps, in gate order. */
      targets: PreparedReviewTarget[];
      /** As `ready`: the pinned before/after pair per target, where one exists. */
      pinnedCapturePairs: Record<string, PinnedCapturePairView>;
      /** As `ready`: the producing agent's one-line summary, when present. */
      agentSummary: string | null;
    }
  /** The pending gate, prepared: the targets to review + the decision chrome. */
  | {
      kind: "ready";
      runId: string;
      reviewTaskId: string;
      targets: PreparedReviewTarget[];
      /** The producing agent's one-line summary (§I/II) — rendered only when
       * present; absent for a gate whose producer supplied none. */
      agentSummary: string | null;
      /**
       * S6 (#2044 L-B + L-D) — the PINNED visual before/after PAIR per target,
       * keyed `<artifactId>:<representationRevisionId>` (the pinned pair):
       * the live page beside the proposal composed into that page's own
       * adapter-marked regions. Captured at gate creation and read from the
       * store; the surface NEVER fetches the remote site at view time, so an old
       * gate keeps showing its original pictures. Absent for a target that has
       * none (every other artifact type), which renders nothing at all — the
       * pictures are additive context.
       */
      pinnedCapturePairs: Record<string, PinnedCapturePairView>;
      /**
       * THE PROMPT THE REVIEWED REVISION RECORDS IT WAS MADE FROM (cinatra#3080
       * item 5) — the review SCREEN's own pre-filled field, beside the note.
       *
       * On the surface model rather than on a target's `props`, and that is the
       * point: `props` is what the DISPLAY is handed, and the display shows the
       * work, never the instructions the work was made from. Null when the gate
       * pins no single target that records one, and the screen then draws the
       * note alone exactly as it did before this field existed.
       */
      picturePrompt: string | null;
      permissions: ReviewDecisionPermissions;
    };

/** The key a target's pinned captures are stored under on the surface model. */
export function pinnedCaptureKey(target: {
  artifactId: string;
  representationRevisionId: string;
}): string {
  return `${target.artifactId}:${target.representationRevisionId}`;
}

// ---------------------------------------------------------------------------
// The decision submit OUTCOME the client renders after a submit (§IV/V). Maps
// the #1807 decision core's typed result to the surface's visible states.
// ---------------------------------------------------------------------------

export type ReviewSubmitOutcome =
  /** Committed (or an idempotent re-submit of the same decision) — the gate is
   * resolved; a terminal decision hands the run its outcome. */
  | { kind: "decided"; disposition: ReviewDisposition; idempotent: boolean }
  /** A non-terminal comment landed; the gate stays pending. */
  | { kind: "annotated" }
  /** LIFECYCLE prompt-window path (cinatra#2063): the typed feedback closed the
   * gate as `changes_requested` and opened a repair. `requested` — a repair-capable
   * producer's repair is in flight; `escalated` — routed to a human / org route (or
   * the cycle bound tripped). Either way the gate is RESOLVED and the held effect
   * stays held pending the repair. Reached ONLY on a lifecycle gate with the fence
   * on; the plain Comment path is unchanged. */
  | { kind: "changes-requested"; status: "requested" | "escalated"; idempotent: boolean }
  /** The gate changed under the reviewer (§IV/V) — blocked, never a silent
   * slip-through; the reviewer refreshes to the live gate. */
  | { kind: "blocked"; reason: ReviewBlockedReason }
  /** The reviewer lacks the access the decision needs (§V). */
  | { kind: "not-permitted"; message: string }
  /** A transient failure — the decision did not commit; safe to retry. */
  | { kind: "error"; message: string };

/**
 * The set a NEW decision may carry (§IV, redrawn by cinatra#3080).
 *
 * NOT the floor: the floor is Comment · Regenerate · Continue, and it lives in
 * `@/lib/artifacts/review-surface-model`. This is what reaches the #1807 decision core
 * once the floor's vocabulary has been resolved — Continue's stored `approve`
 * and Comment's `comment`. Regenerate is absent because it takes the change
 * road, and `reject` is absent because it is retired.
 */
export const REVIEW_DISPOSITIONS: ReadonlyArray<ReviewDisposition> = ["approve", "comment"];

/**
 * Map the #1807 decision core's typed `SubmitDecisionResult` to the surface's
 * visible outcome (§IV/§V). FAIL-CLOSED presentation is the load-bearing rule: a
 * fingerprint conflict (`gate-conflict` — a DIFFERENT decision resolved the gate,
 * or the gate moved on) NEVER reads as a silent success — it surfaces as a
 * BLOCKED gate (§IV "the gate can change under you"), so a stale decision can
 * never slip through. A run-access denial disables (not-permitted); a vanished
 * revision / substituted target is a hard block naming the reason; only a genuine
 * transient (invalid/commit-failed) is a retryable error.
 *
 * Pure — no React / DB — so the whole conflict/permission mapping is unit-tested.
 */
export function mapSubmitResultToOutcome(
  result: SubmitDecisionResult,
  disposition: ReviewDisposition,
): ReviewSubmitOutcome {
  if (result.ok) {
    if (disposition === "comment") return { kind: "annotated" };
    return { kind: "decided", disposition, idempotent: result.idempotent };
  }
  switch (result.error.kind) {
    case "run-access-denied":
      return {
        kind: "not-permitted",
        message:
          "You do not have the run access this decision needs — Continue and Regenerate require decision access, a comment requires respond access.",
      };
    // FAIL-CLOSED: a conflicting/settled gate is a block, never a silent success.
    case "gate-conflict":
    case "gate-not-pending":
      return { kind: "blocked", reason: "no-longer-pending" };
    case "target-substitution":
    case "incomplete-coverage":
    // A suggestion the gate's pinned snapshot never surfaced (cinatra#2571) is
    // the SAME class of failure as a substituted target: what the reviewer is
    // looking at no longer matches the gate. It maps to the same block — and to
    // the same block a FORGED id produces, so a prober cannot tell "your chips
    // are stale" from "that id does not exist" (the epic's non-enumerating
    // refusal contract; the offending ids stay in the server's typed error).
    case "suggestion-not-surfaced":
      return { kind: "blocked", reason: "targets-mismatch" };
    case "revision-not-member":
      return { kind: "blocked", reason: "revision-not-live" };
    case "invalid-decision":
      return { kind: "error", message: result.error.message };
    case "commit-failed":
      return { kind: "error", message: "The decision could not be recorded." };
  }
}

/**
 * Map the S2 `recordChangesRequested` store result (the LIFECYCLE prompt-window
 * path, cinatra#2063) to the surface's visible outcome (§IV/§V). A committed
 * request — `requested` (a producer repair is in flight) or `escalated` (routed to
 * a human / org route, or the cycle bound tripped) — is the `changes-requested`
 * outcome; the gate is RESOLVED, so the surface refreshes to the (now blocked)
 * live gate exactly as a terminal decision does.
 *
 * FAIL-CLOSED, reusing the SAME blocked/error states the base decision maps to: a
 * gate that resolved under the reviewer (`gate-conflict` / `gate-not-pending`) is a
 * BLOCK, never a silent success; a tombstoned/moved base is a `revision-not-live`
 * block; a mismatched pinned set is a `targets-mismatch` block; anything else is a
 * retryable error. Pure — no React / DB — so the whole mapping is unit-tested.
 */
export function mapChangesRequestedToOutcome(
  result: RecordChangesRequestedResult,
): ReviewSubmitOutcome {
  if (result.ok) {
    return { kind: "changes-requested", status: result.status, idempotent: result.idempotent };
  }
  switch (result.code) {
    // FAIL-CLOSED: a conflicting / settled gate is a block, never a silent success.
    case "gate-conflict":
    case "gate-not-pending":
    case "not-a-lifecycle-gate":
      return { kind: "blocked", reason: "no-longer-pending" };
    case "tombstoned-base":
    case "stale-base":
      return { kind: "blocked", reason: "revision-not-live" };
    case "targets-mismatch":
      return { kind: "blocked", reason: "targets-mismatch" };
    case "regenerate-unavailable":
      // NOT a block: the operation refused BEFORE it settled anything, so the
      // gate is still pending and the floor is still live. The reason the store
      // stated is the reason the person reads — carried through verbatim rather
      // than replaced by a generic line, because "it could not be recorded" and
      // "there is nothing here that can make this again" are different answers.
      return { kind: "error", message: result.error };
    default:
      // invalid-request / idempotency-key-reuse / empty-feedback / a transient
      // failure — the decision did not commit; safe to retry.
      return { kind: "error", message: "The change request could not be recorded." };
  }
}

// ===========================================================================
// THE REVIEW FLOOR (cinatra#3080, part of epic #3023 — `PLAN: Agents Lifecycle
// (C)` §6 step 4). The one place the three review actions, their labels, their
// required access and the words a person may type for them are written down.
//
// "On every review the floor offers three things and no more — Comment, the note
// that decides nothing; Regenerate, which sends the person's words to the
// producing step for the next revision; Continue, which goes on with the frozen
// revision — a person who wants neither leaves the run as it is, so there is no
// Reject; and Regenerate lives only on the review screen, never in an artifact's
// renderer."
//
// THREE THINGS THIS SECTION IS, AND ONE IT IS NOT.
//
//   · It is the FLOOR's vocabulary — what is drawn, in what order, under what
//     access. Every surface (the card in the chat, the review page, the run
//     page's review step, the card inside a third-party application) reads its
//     labels from here, so "the same three and no more" is true by construction
//     rather than by four independent button lists agreeing.
//   · It is the TYPED ROAD — which floor action a typed word asks for. One pure
//     function, so "continue" and the compatibility alias "approve" cannot drift
//     apart, and "reject" has exactly one answer in exactly one place.
//   · It is the RETIREMENT of Reject, whose one refusal sentence lives below.
//
// It is NOT a second decision path. A floor action resolves to the disposition
// the #1807 decision core already takes (`continue` → the stored `approve`,
// unchanged and unmigrated) or, for Regenerate, to NO disposition at all —
// Regenerate rides the change road's canonical `changes_requested` operation,
// and `floorActionDisposition` deliberately answers null for it rather than
// inventing a fourth stored value.
//
// PERSISTENCE IS UNTOUCHED. Continue keeps storing `approve` in
// `artifact_review_gates.disposition`; a legacy `approve` row reads as Continued
// and a legacy `reject` row stays readable. There is no migration here, and none
// is needed: the change is what the floor OFFERS, not what the store HOLDS.
//
// IT LIVES IN THIS MODULE, not in one of its own, and that is a deliberate
// choice rather than a convenience: this file is already THE pure, client-safe
// surface model every review host imports, and the route-graph ratchet is a
// no-new-rot budget — a new leaf on four locked routes' first-party graphs would
// have to be paid for with a ceiling raise. The vocabulary belongs to the
// surface model; putting it here costs those graphs nothing.
// ===========================================================================

/** The three review actions a pending review offers, and no fourth. */
export type ReviewFloorAction = "comment" | "regenerate" | "continue";

/**
 * The floor, IN DRAWN ORDER: the note that decides nothing, then the two acts
 * that settle the gate. The order is part of the drawing, so it is pinned here
 * and asserted rather than left to each surface's JSX.
 */
export const REVIEW_FLOOR_ACTIONS: readonly ReviewFloorAction[] = [
  "comment",
  "regenerate",
  "continue",
] as const;

/** The words on the buttons. The ONE source every surface renders from. */
export const REVIEW_FLOOR_LABELS: Record<ReviewFloorAction, string> = {
  comment: "Comment",
  regenerate: "Regenerate",
  continue: "Continue",
};

/**
 * THE ANSWER TO A REJECT, wherever it is asked — the button that no longer
 * exists, the typed word, the API. ONE sentence, defined here with the rest of
 * the floor's vocabulary and quoted verbatim by the decision operation that
 * refuses the word, so a person hears the same answer wherever they ask.
 */
export const REVIEW_REJECT_RETIRED_REASON =
  "There is no Reject on a review. Ask for another go with Regenerate, or leave the run as it is.";

/** Regenerate carries the person's words to the producing step, so it cannot be
 *  pressed with nothing to carry. Refused with the reason, never silently. */
export const REGENERATE_NEEDS_A_NOTE =
  "Regenerate needs a note saying what to change — the note is what goes back to the step that made this.";

/**
 * A gate that still pins MORE THAN ONE target (a legacy row from before
 * one-review-per-artifact) cannot say which piece of work to remake, so
 * Regenerate is refused on it WITH THE REASON — and Comment and Continue still
 * work. No new multi-target gate is minted, so this is a reading of history, not
 * a state the product can reach again.
 */
export const REGENERATE_MULTI_TARGET_REASON =
  "This review covers more than one piece of work, so Regenerate cannot say which one to make again. Comment or Continue instead.";

/** A review with no producing step behind it (a batch gate, or a review the
 *  lifecycle road never opened) has nowhere to send the words back to. */
/**
 * The ledger-row property a producing step records the prompt it worked from on.
 * ONE name, read by the surface and never guessed: a row that carries it was
 * made from a prompt, and that is the whole of what the floor asks.
 */
export const RECORDED_PROMPT_PROPERTY = "imagePrompt";

export const REGENERATE_NOT_ON_THIS_REVIEW =
  "This review has no producing step to send the words back to, so Regenerate is not available on it. Comment or Continue instead.";

/**
 * THE ANSWER WHEN NOTHING CAN MAKE THE WORK AGAIN (cinatra#3080 item 4).
 *
 * The review IS on the lifecycle road — it has a producing step on paper — but
 * that step declares no repair capability and no other route can remake this
 * artifact, so a Regenerate would settle the gate and never bring a successor
 * back. Refused with this reason and the gate left PENDING: a review closed for
 * a revision that is not coming is worse than a refusal, because the run is
 * released from a decision nobody made.
 */
export const REGENERATE_HAS_NO_PRODUCING_STEP =
  "Nothing can make this piece of work again, so Regenerate would close the review with no new revision to come. Comment or Continue instead.";

/** The same refusal, for a lineage that has already been remade as many times as
 *  a review allows. The bound exists so a regeneration loop cannot run forever;
 *  reaching it leaves the gate pending rather than settling it into nothing. */
export const REGENERATE_BOUND_REACHED =
  "This work has already been sent back to be made again as many times as a review allows. Comment or Continue instead.";

/**
 * What a CALLER may submit. The three floor actions, plus the two retired words
 * every already-shipped client and every stored row still speaks: `approve`
 * (a compatibility alias of Continue, decided in the issue so the existing typed
 * decision tests MOVE rather than break) and `reject` (refused, with the reason).
 */
export type ReviewFloorSubmission = ReviewFloorAction | "approve" | "reject";

export type ResolvedFloorSubmission =
  | { kind: "action"; action: ReviewFloorAction; alias: boolean }
  | { kind: "retired"; reason: string };

const FLOOR_ACTION_SET: ReadonlySet<string> = new Set(REVIEW_FLOOR_ACTIONS);

/**
 * Resolve a submitted word to the floor action it asks for.
 *
 * `approve` resolves to Continue and says so (`alias: true`), because a caller
 * that still speaks the old word gets the new behaviour and the surfaces can
 * still tell the two apart when they report what happened. `reject` resolves to
 * nothing at all — it is the ONE word with no action behind it.
 */
export function resolveReviewFloorSubmission(
  submission: ReviewFloorSubmission | string,
): ResolvedFloorSubmission {
  if (submission === "reject") {
    return { kind: "retired", reason: REVIEW_REJECT_RETIRED_REASON };
  }
  if (submission === "approve") {
    return { kind: "action", action: "continue", alias: true };
  }
  if (FLOOR_ACTION_SET.has(submission)) {
    return { kind: "action", action: submission as ReviewFloorAction, alias: false };
  }
  return { kind: "retired", reason: `Unknown review action "${submission}".` };
}

/**
 * The gate disposition a floor action STORES.
 *
 * Continue keeps storing `approve` — the same value, the same fingerprint
 * identity, no migration. Comment stores `comment`. Regenerate stores NOTHING
 * through this road: it settles the gate as superseded through the change road's
 * own canonical operation, which records `changes_requested` itself, so a null
 * here is the honest answer and the action that reads it must take the other
 * road rather than fall back to a disposition.
 */
export function floorActionDisposition(action: ReviewFloorAction): ReviewDisposition | null {
  switch (action) {
    case "continue":
      return "approve";
    case "comment":
      return "comment";
    case "regenerate":
      return null;
  }
}

/**
 * The run access a floor action needs.
 *
 * Regenerate SETTLES THE GATE (as superseded), so it needs exactly what a
 * terminal decision needs — not the reader's respond access. Comment keeps the
 * respond access it has always had.
 */
export function floorActionRunAccessOp(action: ReviewFloorAction): ReviewRunAccessOp {
  return action === "comment" ? "respondToHitl" : "approveHitl";
}

/** The typed road's answer for a word that asks for nothing on the floor. */
export type TypedReviewWord = ResolvedFloorSubmission | { kind: "unknown" };

/**
 * THE TYPED ROAD (acceptance item 6). Which floor action a person's typed word
 * asks for, deterministically and in one place.
 *
 * A word that is not a floor word is `unknown` — ordinary chat, never a
 * decision. `reject` is NOT unknown: it is a word the platform recognises and
 * refuses with the reason, because "we did not understand you" and "there is no
 * such thing here" are different answers and the person is owed the second one.
 */
export function resolveTypedReviewWord(message: string): TypedReviewWord {
  const word = message.trim().replace(/[.!]+$/, "").toLowerCase();
  if (word === "reject" || word === "rejected") {
    return { kind: "retired", reason: REVIEW_REJECT_RETIRED_REASON };
  }
  if (word === "approve" || word === "approved") {
    return { kind: "action", action: "continue", alias: true };
  }
  if (word === "continue" || word === "continued") {
    return { kind: "action", action: "continue", alias: false };
  }
  if (word === "regenerate") return { kind: "action", action: "regenerate", alias: false };
  if (word === "comment") return { kind: "action", action: "comment", alias: false };
  return { kind: "unknown" };
}

/**
 * THE PICTURE'S PROMPT (acceptance item 5), read off the reviewed revision's
 * ledger row.
 *
 * TYPE-AGNOSTIC, and deliberately so. It does NOT ask "is this a picture" — the
 * review surface is G1-clean and may not key on an artifact type, a mime family
 * or a renderer identity, and a core that sniffed `image/` would be exactly the
 * identity keying the artifact-UI boundary forbids. What it asks instead is the
 * only question the floor actually needs answered: DOES THE REVIEWED REVISION'S
 * LEDGER ROW RECORD THE PROMPT IT WAS MADE FROM? A row that records one has a
 * prompt to show and re-send; a row that does not shows the note alone.
 *
 * That reads the same way for the picture the drawing is about and for anything
 * else a producing step later records a prompt on, which is the correct
 * behaviour rather than a lucky one: the field belongs to "made from a prompt",
 * not to "is an image".
 *
 * THE DISPLAY IS NOT GIVEN THIS. The prompt is the review SCREEN's field, beside
 * the note; the renderer props contract carries no prompt at all, so there is
 * nothing for a display to show even if one wanted to.
 */
export function reviewPicturePrompt(input: {
  properties: Record<string, unknown> | null | undefined;
}): string | null {
  const raw = input.properties?.[RECORDED_PROMPT_PROPERTY];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
