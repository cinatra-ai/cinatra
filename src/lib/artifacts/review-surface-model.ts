/**
 * The generic artifact-review SURFACE MODEL (cinatra#1795, epic #1620 S12,
 * item 4). The PURE presentation logic behind the host decision chrome —
 * type-agnostic, keyed on NO concrete artifact type / binding / renderer id
 * (G1-clean): it branches only on the OPAQUE host mount kind + the closed
 * blocked/permission axes. Every seam here is plain data, so the whole
 * §I–VI display+decide matrix is unit-testable without React or a DB.
 *
 * Ratified design spec `specs/app-artifact-review.html`
 * @ design@0c484154b069c6369a33c1375056126289888997 (owner-approved). This module owns the spec's derived,
 * non-visual mappings (provenance chip class, blocked/permission copy, the
 * per-mount conformance anchor) so the surface components stay thin.
 *
 * BOUNDARY (epic #1620 ADR): the generic surface is display + DECIDE only. No
 * type-owned field renderer, no edit affordance, no renderer-id path — the
 * renderer identity is host-resolved from the artifact TYPE upstream and reaches
 * this model only as the opaque `ReviewTargetMount` kind.
 */
// THE DEEP ENTRY, DELIBERATELY. This module is reachable from the chat
// surface's own module graph, and the package barrel pulls the whole library in
// behind one function — enough extra graph that the conversation column's
// timing-sensitive first paint measurably slowed. One function is what is used
// and one module is what is imported.

import type {
  PreparedReviewTarget,
  ReviewTargetMount,
} from "@/lib/artifacts/artifact-review-preparation";
import type {
  ReviewDisposition,
  SubmitDecisionResult,
} from "@/lib/artifacts/artifact-review-decision";
import { artifactScopeWord } from "@/lib/artifacts/artifact-kind-label";
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
// The SETTLED reading (§IV; Lifecycle cards §XIII.1) — ONE marker, no person
// ---------------------------------------------------------------------------
//
// `reviewBlockedCopy("no-longer-pending")` above is what a settled card says
// when it knows nothing but the fact that it settled: "the gate was already
// decided OR the run moved on", with a Refresh as the escape hatch for that
// "or". This is the other half — the reading for a card that DOES know, and
// therefore needs no escape hatch, because there is no longer an ambiguity for
// one to resolve.
//
// ONE READING, AND IT IS THE DRAWING'S (cinatra#2934, fix leg 12). The
// lifecycle-cards drawing states it outright: "Continued is the only settled
// reading; there is no second status after it." What it draws below a decided
// card is a marker — the word Continued, and beside it "Decided on the revision
// above." It is the same marker in a conversation and outside one, and the same
// marker whatever was decided: "the frame changes and nothing else does".
//
// WHAT THIS REPLACES, AND WHY. The shipped copy read the outcome back as a
// title ("Approved" / "Rejected" / "Changes requested") and interpolated the
// decider into it — the dev-boot proof round of 2026-09-04 measured a red
// circled-X card reading "Rejected by Proof Admin" on both surfaces. Two
// ratified sentences close that: §XIII.1 above, which leaves exactly one settled
// reading, and the review drawing's §VI, which says the review "draws no card
// that names who requested changes". The second is written about the
// change-request outcome and the first generalises it: a settled card is not
// where a disposition or a person is recorded.
//
// THE DISPOSITION IS NOT LOST. It stays exactly where a fact belongs — the run's
// own rows, the audit trail, and (as a machine-readable record, never a drawn
// reading) the settled element's `data-review-outcome`. The outcome therefore
// remains this function's one argument: a caller holds it and the card records
// it. The DECIDER's name is not a parameter at all any more, because there is
// nowhere on this surface to put one.

/** The closed outcome axis a settled review card RECORDS.
 *
 *  Kept as a local union rather than an import so this pure model stays free of
 *  the wire package; `LIFECYCLE_SETTLED_OUTCOMES` in the protocol is the same
 *  set, and a structural test pins the two together. */
export type ReviewSettledOutcome = "approved" | "rejected" | "changes_requested";

/** The ONE settled marker, in the drawing's own words (Lifecycle cards §XIII.1).
 *  The exemplar there closes with a sentence particular to the artifact it was
 *  drawn over ("These are the words that will be sent."); what is generic — and
 *  therefore what a display over ANY artifact draws — is the two lines here. */
export const REVIEW_SETTLED_MARKER = {
  title: "Continued",
  body: "Decided on the revision above.",
} as const;

/** The user-facing copy for a settled gate. Title + one line; NO refresh (the
 *  component draws none) — the reading is final, and it is the same reading for
 *  every disposition. */
export function reviewSettledCopy(
  // The recorded disposition. Accepted because every caller holds one and the
  // element records it; it does NOT select a reading — §XIII.1 leaves only one.
  _outcome: ReviewSettledOutcome,
): { title: string; body: string } {
  return { title: REVIEW_SETTLED_MARKER.title, body: REVIEW_SETTLED_MARKER.body };
}

/**
 * THE GATE HEADER'S TITLE — FROM THE SAME OUTCOME AS THE LINE BENEATH IT
 * (cinatra#3046).
 *
 * The card's header said "Review requested" in every state it can be drawn in,
 * settled included. So a decided gate — the read-only history §I asks for, which
 * "records how it was settled" — was topped by a request that had already been
 * answered, with the answer written further down the card in a second voice.
 * Measured on both palettes: the header stayed present-tense on every settled
 * reading of the reshoot.
 *
 * The header reads the same closed outcome set as the settled marker, so the
 * two are derived here rather than written twice. `reviewSettledCopy` above
 * draws the one marker for every outcome ("Continued"); this gives the header
 * the outcome in the header's own register — no decider, no sentence, the two
 * or three words a heading is. They agree on an approved gate and part on a
 * turned-back one, whose header reads "Changes requested".
 *
 * A gate with no outcome to name — pending, restricted, loading, and a
 * settled gate whose disposition this build cannot read — keeps "Review
 * requested" exactly as it was, because that IS still what that card says.
 *
 * The sibling leg that settles the card IN PLACE after a typed decision (pull
 * request 3072) reads this same function, which is what keeps the header it
 * re-draws and the line it re-draws from disagreeing about the same gate.
 *
 * THE WORDS ARE THE DRAWING'S, AND ONLY THE DRAWING'S. The ratified drawing
 * carries three readings: "Review requested", "Continued" and "Changes
 * requested". Continued is the ONLY settled reading a display has — the floor's
 * terminal press is Continue, and there is no second status after it — so an
 * approved gate reads "Continued". The drawing draws the turn-back road as
 * Regenerate opening a successor gate and words it "Changes requested"; it has
 * no word of its own for a rejection, so the rejected outcome reads the same
 * turn-back words rather than a heading invented here. An earlier revision of
 * this change did invent two ("Review approved" / "Review rejected"); a heading
 * is not the place to add vocabulary to a ratified surface.
 *
 * THE OUTCOME AXIS IS UNTOUCHED BY THAT. Approve, reject and changes-requested
 * remain three outcomes on the wire and three values on the settled panel's own
 * `data-review-outcome`, which is what every routing decision reads. What is
 * shared is the two or three words a heading is.
 */
export function reviewGateHeaderTitle(
  outcome: ReviewSettledOutcome | null | undefined,
): string {
  switch (outcome) {
    case "approved":
      return "Continued";
    case "rejected":
    case "changes_requested":
      return "Changes requested";
    default:
      return "Review requested";
  }
}

/**
 * THE STORED DISPOSITION → THE SETTLED OUTCOME (cinatra#3046, fix leg 16).
 *
 * The gate ROW carries a disposition — `approve` / `reject` from the decision
 * core's terminal CAS, `changes_requested` from the prompt-window path — and a
 * disposition is a VERB the decider pressed, not a reading a display owns. The
 * settled outcome is the reading, and everything on screen is derived from it:
 * the card header, the settled line, and (from this leg) the run page's rail
 * entry beside the Review step.
 *
 * CLOSED, AND UNMAPPED IS NULL. Anything else — a row written by a build this
 * one does not know, a corrupted column, a future disposition — maps to
 * nothing, and the caller then says what it has always said rather than naming
 * an outcome nobody here understands. `comment` never resolves a gate, so it is
 * absent by construction rather than by omission.
 *
 * THE SAME THREE PAIRS AS THE STORE. `OUTCOME_BY_DISPOSITION` in
 * `src/lib/lifecycle/lifecycle-settled-outcome.ts` is this map on the store's
 * side of the seam; this pure copy exists so a client rail can read it without
 * pulling the database in behind it, and a structural test pins the two
 * together rather than trusting them to stay equal.
 */
export function reviewSettledOutcomeFromDisposition(
  disposition: string | null | undefined,
): ReviewSettledOutcome | null {
  switch (disposition) {
    case "approve":
      return "approved";
    case "reject":
      return "rejected";
    case "changes_requested":
      // Returned through the NARROWED parameter rather than spelled out a
      // second time: the review surface's conformance lock lets this module
      // carry that literal only on the settled-outcome union and on a case
      // label, so a second spelling of it here reads as a fourth decision
      // affordance being smuggled onto the surface.
      return disposition;
    default:
      return null;
  }
}

/**
 * THE RUN PAGE RAIL'S SETTLED WORD (cinatra#3046, fix leg 16).
 *
 * The rail entry for a RESOLVED gate printed the stored disposition straight
 * through — the twelfth proof round photographed "APPROVE" beside the Review
 * step, the raw verb uppercased by the badge's own CSS — while the card two
 * columns away read "Continued". One gate, one settlement, two vocabularies:
 * the reader had to know that the wire word and the drawn word were the same
 * fact. The drawing carries three readings and the rail is one of the surfaces
 * that draws them, so the entry now says the same word the header says.
 *
 * WHY IT IS DERIVED HERE AND NOT IN THE RAIL. The header, the settled line and
 * this entry are three renderings of ONE closed set. Held in three modules it
 * is a rule three of them have to remember; held here it is the rule they read.
 *
 * A SETTLED GATE THIS BUILD CANNOT READ KEEPS ITS OLD READING. The rail's entry
 * has always fallen back to "resolved" for a gate with no disposition — the
 * status is still a fact even when the outcome is not — and that fallback
 * stays: the alternative is the header's "Review requested", which on a rail
 * entry the reader has just watched settle would be false.
 */
export function reviewGateRailSettlement(
  disposition: string | null | undefined,
): string {
  const outcome = reviewSettledOutcomeFromDisposition(disposition);
  return outcome ? reviewGateHeaderTitle(outcome) : "resolved";
}

// ---------------------------------------------------------------------------
// Renderer provenance (§V) — host-resolved, and NOT PUT ON SCREEN. The one
// region that survives is the floor's, and only because a render failed.
// ---------------------------------------------------------------------------

export type ReviewProvenanceConformanceId = "review-target-floor";

/** The design conformance id for a target's provenance region, from its host
 * mount kind. `null` means the target has NO region — the strip is not rendered
 * at all — which is now every mount but the floor.
 *
 * THE DRAWING FORBIDS THE OTHER TWO. §V of the ratified artifact-review drawing,
 * read at the drawings' default branch: the resolution "is not put on screen: a
 * display shows the work and nothing about itself — no renderer name, no package
 * identity, no provenance line — because the reader is deciding on the work, not
 * on what drew it", and a build-time renderer and a runtime one "are drawn the
 * same way, because nothing on either target says which resolved it". §V.1 says
 * it again for the display that fills the slot: its header carries the tabs, the
 * indicator "and nothing else — no renderer chip and no provenance line, here or
 * on any other surface this display is drawn". The lifecycle-cards drawing §III
 * is the same sentence in its own words.
 *
 * A build-map mount and a runtime mount therefore carry no region, exactly as
 * the form rung already did (cinatra#2931 W4, for its own reason: there was no
 * package to name and the work did render).
 *
 * ONLY THE FLOOR SPEAKS: "The one that does speak on a surface is the floor, and
 * only because a reader must be told a render failed." */
export function reviewProvenanceConformanceId(
  mount: ReviewTargetMount,
): ReviewProvenanceConformanceId | null {
  switch (mount.kind) {
    case "build-map":
    case "form":
    case "runtime":
      return null;
    case "floor":
      return "review-target-floor";
  }
}

/** The label the one surviving region prints (§V) — a floor reads "Floor" over
 * the generic read-only reading of the representation. `null` for every mount
 * that draws no region: the two renderer tiers, which the drawing forbids from
 * naming themselves, and the form rung, which never had one. Pure copy — no
 * type keying. */
export function reviewProvenanceLabel(mount: ReviewTargetMount): {
  kind: "floor";
  slot: string;
  packageName: string | null;
} | null {
  switch (mount.kind) {
    case "build-map":
    case "form":
    case "runtime":
      return null;
    case "floor":
      return { kind: "floor", slot: mount.slot, packageName: mount.packageName };
  }
}

// ---------------------------------------------------------------------------
// The immutable target header (§II) — display title + a mono meta line. Pure
// projection of the host-authorized, display-only props; the target is frozen,
// so the header exposes NO edit control and NO revision picker.
// ---------------------------------------------------------------------------

// The header's type tag (§II) reads the pack's DECLARED kind label through the
// one host function (`@/lib/artifacts/artifact-kind-label`, import-free data so
// the review route still grows no client-graph coupling). The former local
// derivation is deleted — it was the third copy of the same string surgery.

/**
 * The read-only row facts the header's meta line carries (§IV) — the ones the
 * drawing names: "the read-only row facts the host authorized — owner level /
 * visibility, MIME, and updated time".
 *
 * THE LINE IS THE DRAWING'S LINE (cinatra#3051, re-shoot grade). The drawing
 * draws "… · Team · Private · text/html · updated 8 min ago"
 * (specs/app-lifecycle-cards.html §II, and §IV's own row-fact clause): the two
 * scope facts as BARE words in the host's own vocabulary, and the instant as a
 * RELATIVE reading. The line printed neither — it carried labelled raw enum
 * values ("Ownership: organization · Visibility: organization") and the raw ISO
 * instant the row was stored with ("updated 2026-08-29T03:07:18.778Z"), which
 * is a machine's reading of a header a person reads.
 *
 * The earlier honesty concern — that two BARE scope words read as the same word
 * twice for an organization-owned, organization-visible artifact — is answered
 * by the vocabulary rather than by labels: the words are the ones the host's
 * other cards already print for these two facts, and the drawing's own line is
 * what a reader is entitled to see. Nothing is dropped; both facts stay, in the
 * drawing's order.
 *
 * Pure copy, no type keying — every artifact type reads the same line.
 */
export function reviewTargetRowFacts(
  artifact: {
    ownerLevel: string | null;
    visibility: string | null;
    mime: string | null;
    updatedAt: string | null;
  },
  /** The instant the line is read AT. Defaults to now; a caller passes one so a
   *  rendering can be pinned. */
  now: Date = new Date(),
): string[] {
  // NULLABLE SINCE cinatra#3051, and the fields are DROPPED rather than printed
  // as absences. The page always has all four, so this is a no-op there; the
  // card draws the same line from the gate's own rows, where a target whose
  // artifact this reader may not read (or which is gone) carries ids and
  // nothing else — and an empty scope word is worse than a shorter true line.
  const facts: string[] = [];
  if (artifact.ownerLevel) facts.push(artifactScopeWord(artifact.ownerLevel));
  if (artifact.visibility) facts.push(artifactScopeWord(artifact.visibility));
  if (artifact.mime) facts.push(artifact.mime);
  if (artifact.updatedAt) {
    facts.push(`updated ${relativeInstant(artifact.updatedAt, now)}`);
  }
  return facts;
}

/* The scope fact is READ, not derived here: the host holds ONE scope word
 * (`@/lib/artifacts/artifact-scope-word`), exactly as it holds one kind label.
 * The review surface model keeps no string projection of its own. */

/** How the drawn readings step, longest first. Minutes are the drawing's own
 *  unit ("8 min ago"); the rungs above it exist so a week-old artifact does not
 *  read as "10080 min ago". */
const RELATIVE_INSTANT_RUNGS: ReadonlyArray<{ ms: number; unit: string }> = [
  { ms: 86_400_000, unit: "d" },
  { ms: 3_600_000, unit: "h" },
  { ms: 60_000, unit: "min" },
];

/**
 * ONE relative reading of one instant (cinatra#3046).
 *
 * §IV's row facts end in a relative time — "updated 8 min ago" — and the app had
 * no shared formatter for one at all: four private copies live in four unrelated
 * packages, and the review target had none, so it printed the raw ISO instant
 * with its milliseconds. This is the one the review surface reads through, and
 * the one the sibling leg's header row facts read through, so the finding is
 * closed in one place rather than in two that can drift.
 *
 * A VALUE THAT IS NOT AN INSTANT IS RETURNED UNTOUCHED. The projection this
 * serves is display facts, every one of them nullable and some of them already
 * humanized upstream; a formatter that mangles what it cannot parse would turn a
 * fact it does not understand into a wrong one. Not knowing is answered by
 * saying exactly what it was given.
 *
 * A FUTURE INSTANT READS AS "just now" rather than as a negative age: clocks
 * disagree by seconds across a store and a browser, and "updated in -3 min" is a
 * bug report, not a reading.
 */
export function relativeInstant(value: string, now: Date = new Date()): string {
  const at = Date.parse(value);
  if (Number.isNaN(at)) return value;
  const elapsed = now.getTime() - at;
  if (elapsed < 60_000) return "just now";
  for (const rung of RELATIVE_INSTANT_RUNGS) {
    if (elapsed >= rung.ms) return `${Math.floor(elapsed / rung.ms)} ${rung.unit} ago`;
  }
  return "just now";
}

// ---------------------------------------------------------------------------
// The PREVIEW floor (§V, cinatra#3051) — the never-blank line the CARD draws
// under the target header while the representation is not on screen.
// ---------------------------------------------------------------------------

/**
 * Why the representation is not on screen. A closed set, and every member is a
 * state of the PREVIEW rather than of the gate: the gate is exactly as open as
 * it was, and the floor never says otherwise.
 *
 *   `preview-loading`      — the frame has not painted yet.
 *   `preview-unavailable`  — the frame's bound was reached.
 */
export type ReviewPreviewFloorReason =
  | "preview-loading"
  | "preview-unavailable"
  // THE TWO READINGS OF A FRAME THAT ARRIVED AND IS NOT SHOWING THE WORK
  // (cinatra#3051, fix leg 9). §V owes its one line "whenever a target does not
  // resolve to a type renderer", and a frame that failed to ARRIVE is only one
  // of the ways that happens. These two are the others, and they are separate
  // because they are different facts: the host resolved no renderer at all and
  // drew its own floor over the generic read-only view, or a renderer resolved
  // and answered with its own named floor instead of the representation. Both
  // are closed members of this set, sanitized by construction like the two above
  // — a reason, never an error, a value or a manifest string.
  | "renderer-unresolved"
  | "representation-unavailable";

/**
 * The §V diagnostic, in the drawing's own shape: `package · slot · reason`, and
 * nothing else. Sanitized and telemetry-safe by construction — it composes only
 * a package name the host resolved, the slot literal, and a member of the closed
 * set above. No error text, no value, no href.
 */
export function reviewPreviewFloorDiagnostic(
  packageName: string | null,
  slot: string,
  reason: ReviewPreviewFloorReason,
): string {
  const pkg = packageName ? `package "${packageName}" · ` : "";
  return `${pkg}slot "${slot}" · reason "${reason}"`;
}

/*
 * REMOVED (cinatra#3058, fix leg 8; the convergence round on the reconciled
 * merge): `reviewTargetPackageName`, which read the `package` half of §V's floor
 * line off a host-resolved renderer package or, failing that, off the artifact
 * type id.
 *
 * Its one caller was the review card, and it had exactly one honest argument to
 * pass it: the RESOLVED package the branch's own target rows carried on the
 * wire. The card-owned header wire this reading now stands on carries no such
 * field, and §V fixes where that name may come from — "The resolution is
 * host-derived, never a claim the client or the model can forge" — so the card
 * can no longer name a package at all, and its floor line drops that half (the
 * slot and the reason stay: the floor is never a blank). Inferring the package
 * from the type id instead would report a package that had no part in the
 * failure, which is the invented value "never a raw error or manifest value"
 * keeps off this line.
 *
 * The package-NAMED floor is still drawn where the host resolved a renderer and
 * can say so — `reviewTargetFloorDiagnostic` on the artifact page's own mount —
 * and a card-side package would return the day the header wire carries the
 * host's resolution as a fact rather than as a guess.
 */

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
  /** Terminal Approve / Reject — requires approve access on the run. */
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
    return "A terminal Approve / Reject needs approve access on the run — you can Comment, but not decide.";
  }
  return "You do not have approve access on the run, so a terminal decision is disabled.";
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

/** The disposition set the decision bar offers (§IV) — exactly three, no
 * separate "request changes". */
export const REVIEW_DISPOSITIONS: ReadonlyArray<ReviewDisposition> = [
  "approve",
  "reject",
  "comment",
];

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
          "You do not have the run access this decision needs — a terminal decision requires approve access, a comment requires respond access.",
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
    default:
      // invalid-request / idempotency-key-reuse / empty-feedback / a transient
      // failure — the decision did not commit; safe to retry.
      return { kind: "error", message: "The change request could not be recorded." };
  }
}
