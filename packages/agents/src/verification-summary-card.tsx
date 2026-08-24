"use client";

// ---------------------------------------------------------------------------
// `VerificationSummaryCard` — THE renderer of `verification_summary`
// (cinatra#2789, epic #2784 S9e). Design: `specs/app-lifecycle-cards.html` §VII
// (the verification card), §IX (where each card appears).
//
// WHAT IT IS, IN THE WORDS THE READER SEES. User-facing this is the AUDIT CARD
// (plan §8); the code and the drawing say verification, which is why this file,
// its view type, its data attributes and its tests all read "verification" while
// no sentence on screen does. Both names are deliberate and neither is a
// rename-in-progress: the plan fixes the user-facing noun, the wire fixes the
// kind.
//
// WHAT THE READING IS OF (plan course correction, 2026-08-19). The core checks
// the landed change against WHAT THE REVIEW AUTHORIZED — the accepted findings
// and the scope manifest they produced. That is the sentence the card leads
// with, and that is what each before/after row's `inScope` mark answers: a row
// whose field is outside the manifest is out-of-scope DRIFT and is marked in
// place. THE TABLE ITSELF IS ONLY THE FIELDS THAT WERE INSPECTED — an
// authorized field the repair left untouched carries no row at all, because
// the diff only ever carries changed paths. The card never presents the
// agent's SKILLS as the thing verified, and it has nothing in its body it
// could build such a list from.
//
// ONE RENDERER, EVERY HOST. The same component draws the reading in a chat
// transcript, on the run card, in the review page's verification region and on
// the site widget. §IX's rule is the epic's structural thesis, and this file is
// the only place §VII is composed: the registry dispatches `verification_summary`
// here, the run screen mounts it under `host="run_card"`, and the review page's
// `VerificationView` mounts it under `host="page_gate_region"` — keeping only
// the ONE adjunct that is genuinely the PAGE's (the pinned visual pair)
// composed AROUND it. The "back to the review gate" link that used to sit
// beside it is gone (plan §8.3(5), §8.4; cinatra#2789): the drawn card has no
// link and no buttons at all, so the reader reaches the gate the way they
// reached this reading — the run's step rail, and the browser's own back. The
// host supplies a frame; it never supplies a second drawing.
//
// IT CARRIES NO FLOOR AT ALL. §VII: "it asks nothing, so it draws nothing to
// press". There is no decision bar, no comment path, no composer binding and no
// refresh here — every one of those belongs to the review card, and a reading
// that grew a button would put an act where an advisory sits. The card is
// therefore a pure function of the authorized answer.
//
// THE READING ARRIVES IN THE BODY; NOTHING IS RE-DERIVED (epic S9, slice S9c).
// The resolver returns `{ kind, state, body }` and the body IS §VII's sanitized
// reading — verdict, the two pinned revisions, the field diff (each row
// carrying its own authorization mark) and the advisory comments. This card
// computes no verdict, re-reads no store and infers nothing the server did not
// authorize — INCLUDING each row's `inScope` mark itself (cinatra#2861): it
// arrives decided, against the review's whole scope manifest, and the card
// only reads it. It used to be re-derived here by testing the row against a
// clamped `scopePaths` projection; that membership test moved to the server,
// where the manifest is whole and unclamped, so an authorized path past the
// old projection's ceiling can no longer be mismarked as drift.
//
// TWO STATES DRAW, AND ONLY TWO. §VII's card resolves `advisory` — the reading
// — or `absent`, which draws NO DOM AT ALL (§IV: a reader who may not read the
// record, a record that does not exist and a store that failed are one answer).
// Every other rung of the ladder is refused rather than approximated: a
// `pending` verification would be a reading asking for a decision it has no
// floor to take, and a `settled` one would be a verdict the resolver never
// issues. An unexpected state draws nothing, which is the same silence as
// before the first resolve — fail closed, never a half-card.
//
// PROVENANCE IS A COMMENT, NOT A LINE. §VII fixes this precisely: "the
// reading's provenance is the body of a SERVICE comment there, not a line of
// its own". So there is no provenance row in this component; it is drawn only
// as one of the advisory comments, in the author-kind-over-body panel every
// comment gets. A card with no comments says so rather than inventing one.
// ---------------------------------------------------------------------------

import { type ReactElement } from "react";
import { ArrowRight, ScanSearch } from "lucide-react";

import {
  LIFECYCLE_VIEW_SCHEMA_VERSION,
  type LifecycleCardHost,
  type VerificationSummaryAdvisoryComment,
  type VerificationSummaryBody,
  type VerificationSummaryFieldDiff,
  type VerificationSummaryOutcome,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { StatusPill, type StatusPillStatus } from "@/components/ui/status-pill";

import { useLifecycleCardHost, useLifecycleCardResolve } from "./lifecycle-card-runtime";

// Re-exported for the same reason the review card re-exports it: a HOST that
// mounts this card should not have to reach into the protocol package for the
// one constant it needs to name a payload.
export { LIFECYCLE_VIEW_SCHEMA_VERSION };

/** The wire payload — a kind, a version and an opaque ref, and nothing else. */
export type VerificationSummaryCardView = {
  viewType: "verification_summary";
  schemaVersion: number;
  ref: string;
};

/**
 * The per-host FRAME (§IX: "presence is not layout").
 *
 * A total map over `LifecycleCardHost`, exactly like the review card's, so a
 * new host cannot be added to the epic without deciding its frame here.
 *
 * THE BORDERED PANEL IS PART OF THE FRAME, AND THAT IS §VII'S OWN RULING rather
 * than a liberty taken here. The spec's callout is explicit: "the bordered panel
 * is the card treatment for a CONVERSATION, where the reading has to separate
 * itself from the turns around it; on the run's own review page the same regions
 * sit UNFRAMED in the page column, and that surface is unchanged." So the two
 * conversation hosts get the plate and the vertical rhythm of a turn's content
 * slot; the two column hosts get neither — they are already inside their own
 * spacing and their own surface, and a border there would box a region the page
 * draws flat.
 *
 * This is exactly the seam §IX reserves for a host: the FRAME changes, the
 * DRAWING does not. Everything inside this element is byte-identical on all four
 * hosts, and a test pins that.
 */
const HOST_FRAME: Record<LifecycleCardHost, string> = {
  chat_thread:
    "my-3 flex w-full min-w-0 flex-col gap-3 rounded-card border border-line bg-surface-strong p-3.5",
  site_widget:
    "my-3 flex w-full min-w-0 flex-col gap-3 rounded-card border border-line bg-surface-strong p-3.5",
  run_card: "flex w-full min-w-0 flex-col gap-3",
  page_gate_region: "flex w-full min-w-0 flex-col gap-3",
};

/**
 * §VII's three outcomes: the label, the pill tone, and the SCOPE SENTENCE that
 * says what this particular verdict means about the authorization.
 *
 * THE PILL IS THE ONLY STATE COLOUR ON THE CARD (§VII), and it is the SHIPPED
 * pill rather than a local tone table — `approved` / `hold` / `failed` are the
 * three treatments the spec's own `.pill` classes name, so the card inherits
 * the app's status vocabulary instead of minting a fourth one.
 *
 * The sentences are written to the course correction: each names the
 * AUTHORIZATION (the accepted findings and the scope manifest) as the thing the
 * landed change was measured against, and the user-facing noun is "audit".
 */
const OUTCOME_COPY: Record<
  VerificationSummaryOutcome,
  { label: string; pill: StatusPillStatus; scope: string }
> = {
  verified: {
    label: "Verified",
    pill: "approved",
    scope:
      "This audit checks the repaired revision against what the review authorized — " +
      "the accepted findings and the scope manifest they produced. The before / after " +
      "below shows exactly the fields that were inspected — nothing more; an authorized field the " +
      "repair left untouched carries no row here, and none of the rows below fell " +
      "outside that authorization.",
  },
  drifted: {
    label: "Out-of-scope drift",
    pill: "hold",
    scope:
      "A field changed that the review never authorized. It is marked in place in the " +
      "before / after below rather than folded into the result, so the authorized scope " +
      "and the drift stay readable apart.",
  },
  unmet: {
    label: "Findings not met",
    pill: "failed",
    scope:
      "An accepted finding the review authorized is absent from the repaired revision. " +
      "The reading is advisory — the review card still holds the decision.",
  },
};

/** The outcome as it must be drawn, or `null` for a verdict this build cannot
 *  read. The body's schema already closes the set; this keeps the component
 *  total anyway, so an untyped edge can never paint an unlabelled pill. */
function outcomeCopy(outcome: string): (typeof OUTCOME_COPY)[VerificationSummaryOutcome] | null {
  return Object.hasOwn(OUTCOME_COPY, outcome)
    ? OUTCOME_COPY[outcome as VerificationSummaryOutcome]
    : null;
}

/**
 * The AUDIT CARD. `view` is the wire payload; every fact drawn below comes from
 * the authorized resolve, and the card renders nothing at all until one lands.
 */
export function VerificationSummaryCard({
  view,
}: {
  view: VerificationSummaryCardView;
}): ReactElement | null {
  const host = useLifecycleCardHost();
  // The FIRST absence: a subtree that declared no host is not a lifecycle
  // surface at all, so this is not a card that belongs to it.
  const present = host !== null;
  const resolved = useLifecycleCardResolve({
    viewType: "verification_summary",
    ref: view.ref,
    enabled: present,
  });
  const state = resolved?.state ?? null;
  const body: VerificationSummaryBody | null = resolved?.body ?? null;

  // Nothing before an authorized resolve (S1's contract) — not even a skeleton.
  if (!present || state === null) return null;
  // The SECOND absence: `absent` is the collapse of every denial, and it draws
  // no card DOM whatsoever (§IV).
  if (state.state !== "advisory") return null;
  // A body-less `advisory` cannot happen through the parse seam (the kind is
  // refused without its body) and would be a verdict with no reading if it did.
  if (body === null) return null;
  const copy = outcomeCopy(body.outcome);
  if (copy === null) return null;

  return (
    <div
      className={HOST_FRAME[host]}
      data-lifecycle-card="verification_summary"
      data-lifecycle-card-state={state.state}
      data-lifecycle-card-host={host}
      data-conformance-id="verification-card"
    >
      {/* §VII — the Core-analysis chrome and its outcome pill. */}
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="grid size-[26px] flex-none place-items-center rounded-lg bg-mustard-ink/15 text-mustard-ink">
          <ScanSearch aria-hidden="true" className="size-3.5" />
        </span>
        <span
          className="font-sans text-sm font-bold text-foreground"
          data-verification-chrome="Core analysis"
        >
          Audit
        </span>
        <StatusPill status={copy.pill} data-verification-outcome={body.outcome}>
          {copy.label}
        </StatusPill>
      </div>

      {/* The scope sentence — what was verified, against what authorized it. */}
      <p className="max-w-[66ch] text-xs leading-relaxed text-muted-foreground">
        {copy.scope}
      </p>

      {/* §VII — the two revision pins, in mono. */}
      <div
        className="flex flex-wrap items-center gap-1.5 font-mono text-badge-2xs text-muted-foreground"
        data-verification-revisions=""
      >
        <span title="reviewed revision">{body.reviewedRevisionId}</span>
        <ArrowRight aria-hidden="true" className="size-3" />
        <span title="repaired revision">{body.repairedRevisionId}</span>
      </div>

      <FieldDiffTable rows={body.fieldDiff} />
      <AdvisoryComments comments={body.advisoryComments} />
    </div>
  );
}

/**
 * §VII's field-by-field BEFORE / AFTER — the columns of the authorized scope.
 *
 * THIS TABLE IS WHERE THE AUTHORIZATION IS DRAWN. The plan's binding correction
 * asks the card's COPY and these BEFORE/AFTER COLUMNS to carry what the review
 * authorized — and §VII draws no region listing the manifest — so the scope is
 * read off the rows, not off a list above them.
 *
 * DISCLOSED AND OUT OF SCOPE ARE SEPARATE MARKS (§VII, verbatim): "a field may
 * be disclosed to the analysis and still lie outside what the review covered,
 * and the table says so on the row". Every row here was disclosed — that is
 * what being in the diff means — so the only mark the row carries is whether
 * the AUTHORIZATION covered it. `data-diff-in-scope` records the same fact for
 * a machine, so a capture and a test read one answer.
 *
 * THE MARK IS THE SERVER'S, NOT THIS COMPONENT'S (cinatra#2861). `row.inScope`
 * arrives decided, against the review's WHOLE scope manifest. This card must
 * not re-derive it: everything it receives has been through a bounded, clamped
 * projection, and membership tested against a truncated manifest would mark an
 * authorized field as drift — the card accusing a repair of going outside what
 * a human authorized, on nothing but a ceiling.
 *
 * `null` is the honest "this side had no value" and draws an em dash. A struck
 * BEFORE beside an identical AFTER is exactly how §VII draws an unmet finding —
 * the field was inspected and did not move — so the strike is not conditional
 * on the values differing.
 */
function FieldDiffTable({
  rows,
}: {
  rows: readonly VerificationSummaryFieldDiff[];
}): ReactElement {
  return (
    <div
      className="min-w-0 overflow-x-auto rounded-panel border border-line"
      data-verification-field-diff=""
    >
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-xs text-muted-foreground">
          This audit projected no field-level changes for the repaired revision.
        </p>
      ) : (
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-line text-badge-2xs uppercase tracking-widest text-muted-foreground">
              <th className="px-3 py-2 font-medium">Field</th>
              <th className="px-3 py-2 font-medium">Before</th>
              <th className="px-3 py-2 font-medium">After</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const inScope = row.inScope;
              return (
                <tr
                  // The body carries no row ids (they name nothing on screen),
                  // and a diff can legitimately repeat a path, so the key is
                  // positional over a list the server already ordered.
                  key={`${index}:${row.field}`}
                  className="border-b border-line/60 align-top"
                  data-diff-field={row.field}
                  data-diff-in-scope={inScope ? "true" : "false"}
                >
                  <td className="px-3 py-2 font-mono text-foreground">
                    {row.field}
                    {inScope ? null : (
                      <span className="ms-1.5 whitespace-nowrap rounded-chip border border-warning/40 bg-warning/15 px-1.5 py-0.5 font-mono text-badge-2xs uppercase tracking-wide text-warning">
                        out of scope
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground line-through">
                    {row.before ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-foreground">{row.after ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * §VII's ADVISORY COMMENTS — "a label over one panel per comment, each carrying
 * its author kind in mono above the comment itself".
 *
 * This is also where the reading's PROVENANCE lives: §VII puts it in the body
 * of a service comment rather than on a line of its own, so this component
 * draws comment bodies verbatim (as React text nodes — never HTML) and adds no
 * provenance row of its own. An analysis with no comments says so; a card that
 * quietly omitted the section would drop the provenance without saying it had.
 *
 * THREE ANSWERS, NOT TWO (cinatra#2861). `null` is not `[]`. An empty list is a
 * fact the server established — this analysis carries no comments — and the
 * card states it. `null` means the comment store could not be read, and the
 * card must NOT then state that fact: "no advisory comments on this audit"
 * would assert an absence nobody checked, and it would do so about the one
 * region §VII makes load-bearing (the provenance). So the failure gets its own
 * line, and `data-advisory-unavailable` records it for a machine. The rest of
 * the reading is untouched — the verdict and the diff were authorized, and one
 * unread panel does not un-authorize them.
 */
function AdvisoryComments({
  comments,
}: {
  comments: readonly VerificationSummaryAdvisoryComment[] | null;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-verification-advisory="">
      <span className="font-mono text-badge-2xs uppercase tracking-widest text-muted-foreground">
        Advisory comments
      </span>
      {comments === null ? (
        <p className="text-xs text-muted-foreground" data-advisory-unavailable="">
          Advisory comments unavailable — they could not be read for this audit.
        </p>
      ) : comments.length === 0 ? (
        <p className="text-xs text-muted-foreground">No advisory comments on this audit.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {comments.map((comment, index) => (
            <li
              // Positional, for the same reason the diff rows are: the body
              // deliberately carries no comment ids.
              key={index}
              className="rounded-panel border border-line bg-surface-muted px-3 py-2 text-xs"
              data-advisory-comment={index}
              data-advisory-author-kind={comment.authorKind}
            >
              <span className="font-mono text-badge-2xs uppercase tracking-wide text-muted-foreground">
                {comment.authorKind}
              </span>
              {/* `whitespace-pre-wrap` keeps the author's own line breaks;
                  `break-words` is what contains a body that has none. A comment
                  body is arbitrary text — a stack frame, a base64 blob, a URL —
                  and one unbroken token would otherwise widen the panel past
                  the card on every host. Prose idiom (`break-words`), not the
                  machine-string one (`break-all`), so ordinary sentences still
                  wrap at their spaces. */}
              <p className="mt-1 whitespace-pre-wrap break-words text-foreground">
                {comment.body}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
