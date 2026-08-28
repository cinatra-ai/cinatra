"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactElement,
} from "react";
import { useRouter } from "next/navigation";
import { Check, SlidersHorizontal, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

import {
  LIFECYCLE_RECOMMENDATION_DECIDE_PATH,
  LIFECYCLE_RECOMMENDATION_HOLD_PATH,
  useLifecycleCardAuth,
  useLifecycleCardHost,
  type LifecycleCardAuth,
} from "./lifecycle-card-runtime";
import type { RecommendedSkillForChip } from "./server-actions";
import { getRunRecommendedSkillsAction } from "./server-actions";
import {
  confirmRunRecommendationAction,
  getRunRecommendationHoldStateAction,
  skipRunRecommendationAction,
  type RunRecommendationDecisionResult,
  type RunRecommendationHoldState,
  type RunRecommendationSettledCandidate,
} from "./run-recommendation-actions";
import type { RunRecommendationDecidedSkill } from "@/lib/run-selected-skill-revisions";

// ---------------------------------------------------------------------------
// RunRecommendationChipRow — the SHARED run-start recommendation chip-row
// (cinatra#2067, epic #2037 C3; REDRAWN to the ratified drawing by cinatra#2841).
// ONE component serving every host that draws `recommendation_hold` — the run
// page's trigger position today, the chat mount as it lands — so a redraw here
// is the redraw everywhere.
//
// THE DRAWING THIS RENDERS. design `specs/app-lifecycle-cards.html` §V "The
// recommendation card", at design commit 60b27dfbb8a2 (the ratified redraw):
//
//   "the turn carries a chip-row: ONE CHIP PER SKILL, each carrying its own
//    Confirm, Adjust and Skip, so the reader shapes the run one skill at a time
//    before it runs."
//   "THE ROW IS THE WHOLE CARD. There is no heading plate above it and no
//    row-level submit beneath it — nothing states the question a second time,
//    and nothing decides every skill at once. A skill is settled by pressing
//    one of ITS OWN three affordances, and each chip then shows what it
//    recorded."
//
// WHAT WENT, AND WHY IT MAY NOT COME BACK. The shipped card carried a heading
// plate restating the question with a subtitle under it, a collapsible skills
// selector whose pills were the only adjust affordance, and ONE card-level
// submit pair that decided the whole row at once. §V draws
// none of those, so none of them is rendered here: the row IS the card.
//
// THE THREE AFFORDANCES, PER CHIP:
//
//   CONFIRM — take this skill as scored: it rides the run's authoritative
//             selection. (On a candidate the scorer did NOT recommend, that is
//             the shipped force-add — its exact revision is pinned. See the
//             CANDIDATE-SET deviation below.)
//   ADJUST  — open THIS skill's panel and edit its selection: keep it in, or
//             leave it out. The chip records `adjusted` either way, so "I looked
//             at this one and shaped it" is distinguishable from "I took it as
//             offered". The drawing does not fix what Adjust opens; the panel it
//             opens is the SHIPPED per-skill detail panel, and the selection is
//             the ONE thing the run's store records per skill — nothing wider is
//             invented here.
//
//             THE ADJUSTED MARK IS NOW DURABLE FOR "KEEP" (cinatra#2841 fix).
//             An in-set Adjust → "Keep it in this run" is written as a
//             `user_adjusted` selection row, so the settled row reads back
//             `Adjusted` instead of `Confirmed`. Before this it was written
//             `recommended_confirmed` — indistinguishable from a plain Confirm —
//             and `adjusted` was UNREACHABLE on a settled chip, because the only
//             source that mapped to it (`user_forced`) is stamped exclusively
//             for an id OUTSIDE the scored set, and the row only offers the
//             scored set.
//
//             RESIDUAL, NAMED: Adjust → "Leave it out" is durably a REJECTED
//             row, and the rejected half records only that the skill was not
//             kept — so it reads back `Skipped`, which is what it is (the skill
//             is not in the run). Distinguishing "skipped outright" from
//             "inspected, then dropped" would need the rejected row to carry a
//             third source, and this slice does not widen the store.
//   SKIP    — leave this skill out of the run.
//
// DEVIATION — THE RELEASE IS STILL WHOLE-ROW (named, cinatra#2841). The shipped
// store has no per-skill decision record to write against a LIVE hold: the
// recommendation hold carries one scored candidate set and one selection, and
// the two decision actions (`confirmRunRecommendationAction`,
// `skipRunRecommendationAction`) each write a decision AND release the park in
// one shot. So the per-chip decision model is UI state over the shipped release:
// each chip records its own mark, and when EVERY chip is decided the row
// releases once — a confirm carrying the kept set, or a skip when the reader
// kept nothing. No new store semantics are invented, and a chip stays
// re-pressable until that release lands.
//
// DEVIATION — THE CANDIDATE SET IS EVERY OFFERED CANDIDATE (named,
// cinatra#2841). §V draws chips for the skills the assistant PROPOSES. The
// shipped row offers the scorer's whole candidate list — recommended ones plus
// the below-threshold ones a reader may force on — and dropping the latter would
// delete a shipped affordance, which this slice may not do. Every candidate
// therefore gets a chip; a non-recommended one keeps its shipped marking
// (`data-forced`) and its shipped tooltip.
//
// `decision` drives the two readings §V draws:
//   "pending"   → the interactive chip-row (a live parked hold).
//   a summary   → the SETTLED row: one chip per skill, each stating what it
//                 recorded (Confirmed / Adjusted / Skipped), nothing left to
//                 press and nothing summarised above it.
//   a summary
//   with NO skill → the SETTLED OUTCOME PANEL (cinatra#2893): the outcome word
//                 in place of the row, with the decider beside it only where the
//                 record carries a safely displayable name.
// The fourth reading, READ-ONLY, is `canDecide === false`: every chip keeps its
// three affordances on screen, disabled, over the reason line.
// ---------------------------------------------------------------------------

/** What one chip recorded — the three marks §V draws on a settled chip. */
export type RunRecommendationChipMark = "confirmed" | "adjusted" | "skipped";

export type RunRecommendationDecision =
  | { kind: "pending" }
  | {
      kind: "confirmed";
      skillNames: string[];
      /** Per-skill settled marks, derived from the run's durable evidence. */
      decided?: RunRecommendationDecidedSkill[];
      /**
       * THE SKILLS THE HOLD ASKED ABOUT (cinatra#2790). One chip is drawn for
       * each of them; see `settledChipsForRow`.
       */
      candidates?: RunRecommendationSettledCandidate[];
    }
  | {
      kind: "skipped";
      decided?: RunRecommendationDecidedSkill[];
      /** The same offer, for the same reason — see the `confirmed` arm above. */
      candidates?: RunRecommendationSettledCandidate[];
      /**
       * The decider as a SURFACE-SAFE DISPLAY NAME, for §V's zero-chip settled
       * reading (cinatra#2893) — never an id and never an address. Absent on
       * this trunk: the resolver's `skipped` answer carries the decided set and
       * no decider, so the ratified outcome-only face is what renders. See
       * `SettledOutcomePanel` for why that is a true reading, not a gap.
       */
      decidedByName?: string;
    };

/** One chip's live (pre-release) state: what was pressed, and what it means. */
type ChipDecision = { mark: RunRecommendationChipMark; keep: boolean };

/**
 * The row's decision transport (cinatra#2790, epic #2784 S9f) — the two terminal
 * acts, with the SAME answer shape the shipped server actions return, so the
 * row's error handling is one code path whichever host it is drawn on.
 */
export type RunRecommendationSubmit = {
  confirm: (input: {
    runId: string;
    agentPackageName: string;
    confirmedSkillIds: string[];
    promptText?: string;
    forcedRevisions?: Record<string, string>;
    adjustedSkillIds?: string[];
    holdRef?: string;
  }) => Promise<RunRecommendationDecisionResult>;
  skip: (input: { runId: string; holdRef?: string }) => Promise<RunRecommendationDecisionResult>;
};

/**
 * THE BROKER TRANSPORT for a host that declares a credential (the site widget).
 *
 * Built at the moment of the call from the host's own declaration, exactly like
 * the review card's decision POST: the token never enters React state, a prop, a
 * log or the DOM — only the request being built. `credentials` comes from the
 * declaration too, and the provider refuses to mount a non-cookie host that does
 * not say `omit`, so this can never send an ambient cookie.
 *
 * A transport failure answers with the row's own fixed refusal rather than
 * throwing: an unreachable endpoint must read as "nothing was decided", never as
 * a decided run.
 */
export function brokerRecommendationSubmit(auth: LifecycleCardAuth): RunRecommendationSubmit {
  const post = async (path: string, body: unknown): Promise<unknown | null> => {
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth.headers() },
        body: JSON.stringify(body),
        credentials: auth.credentials,
      });
      if (!response.ok) return null;
      return (await response.json()) as unknown;
    } catch {
      return null;
    }
  };
  const readOutcome = (payload: unknown): RunRecommendationDecisionResult => {
    const outcome = (payload as { outcome?: unknown } | null)?.outcome;
    if (outcome && typeof outcome === "object" && "ok" in outcome) {
      return outcome as RunRecommendationDecisionResult;
    }
    return { ok: false, error: RECOMMENDATION_ROW_REFUSAL };
  };
  return {
    confirm: async (input) =>
      readOutcome(
        await post(LIFECYCLE_RECOMMENDATION_DECIDE_PATH, {
          runId: input.runId,
          decision: "confirm",
          confirmedSkillIds: input.confirmedSkillIds,
          ...(input.promptText !== undefined ? { promptText: input.promptText } : {}),
          ...(input.forcedRevisions ? { forcedRevisions: input.forcedRevisions } : {}),
          ...(input.adjustedSkillIds ? { adjustedSkillIds: input.adjustedSkillIds } : {}),
          ...(input.holdRef ? { holdRef: input.holdRef } : {}),
        }),
      ),
    skip: async (input) =>
      readOutcome(
        await post(LIFECYCLE_RECOMMENDATION_DECIDE_PATH, {
          runId: input.runId,
          decision: "skip",
          ...(input.holdRef ? { holdRef: input.holdRef } : {}),
        }),
      ),
  };
}

/** The row's own fixed refusal — one string, whichever transport failed. */
const RECOMMENDATION_ROW_REFUSAL = "Could not record that decision.";

/**
 * The SESSION transport: the shipped cookie-bound server actions, unchanged.
 * The default, so a cookie host that passes nothing behaves byte-for-byte as it
 * did before this slice.
 */
const SESSION_SUBMIT: RunRecommendationSubmit = {
  confirm: (input) => confirmRunRecommendationAction(input),
  skip: (input) => skipRunRecommendationAction(input),
};

type Props = {
  runId: string;
  agentPackageName: string;
  /** JSON-serialized run intent (inputParams) for request-aware scoring. */
  promptText?: string;
  /** Server-prefetched candidates (run view). Omit to fetch on mount (chat). */
  initialRecommendations?: RecommendedSkillForChip[];
  /**
   * OPAQUE handle to the hold this row is showing (cinatra#2568). Handed back on
   * confirm/skip so the decision binds to the hold it was taken against: a run
   * that was decided, dispatched and held AGAIN refuses a decision meant for the
   * previous hold instead of applying it to the new one. Absent on surfaces that
   * do not (yet) carry it — the action then keeps its pre-#2568 run-scoped
   * behaviour.
   */
  holdRef?: string;
  decision: RunRecommendationDecision;
  /**
   * Whether THIS reader may shape the run (§V's read-only reading). Presentation
   * only: the decision actions re-authorize on their own and are untouched by
   * this flag, so a `true` it should not have been given buys nothing but a
   * refusal line. It therefore defaults to `true` — a reader who may decide must
   * never lose the affordances to an unresolvable presentation hint.
   */
  canDecide?: boolean;
  /** Compact styling for the inline chat mount. */
  variant?: "panel" | "inline";
  /**
   * HOW THIS ROW SUBMITS ITS DECISION (cinatra#2790, epic #2784 S9f).
   *
   * The row draws §V and decides §V; WHO the decision is recorded as is the
   * host's question, not the drawing's. A cookie host passes nothing and the row
   * keeps its shipped server actions. A credential-declaring host — the site
   * widget — passes a submitter that posts to the broker endpoint with the
   * host's own proof and cookies OMITTED, because a server action cannot carry a
   * credential and would ride the ambient cookie of a same-origin frame.
   *
   * ONE ROW, TWO TRANSPORTS, NEVER TWO ROWS: the affordances, the marks, the
   * whole-row release and the refusal line below are identical on both.
   */
  submit?: RunRecommendationSubmit;
  /**
   * Fired after a confirm/skip SUCCEEDS (cinatra#2568 AC-1). The card host
   * re-reads the authoritative hold state so the row settles into its decided
   * summary on the spot. Without it the only thing that could flip the row was
   * the retired 4-second poll: `router.refresh()` below re-renders the SERVER
   * tree (which is what the run-detail mount needs) but says nothing to a
   * client-resolved card. Both fire — they serve different mounts, and a
   * refresh a mount does not need is a no-op, never a wrong state.
   */
  onDecided?: () => void;
};

const MARK_LABEL: Record<RunRecommendationChipMark, string> = {
  confirmed: "Confirmed",
  adjusted: "Adjusted",
  skipped: "Skipped",
};

/** Per-mark chip treatment — §V's confirmed tint, adjusted tint, dashed skip. */
const MARK_CHIP_CLASS: Record<RunRecommendationChipMark, string> = {
  confirmed: "border-success/45 bg-success/10 text-foreground",
  adjusted: "border-warning/50 bg-warning/12 text-foreground",
  skipped: "border-dashed border-line bg-transparent text-muted-foreground",
};

function MarkIcon({ mark }: { mark: RunRecommendationChipMark }): ReactElement {
  if (mark === "confirmed") return <Check className="h-3 w-3" aria-hidden />;
  if (mark === "adjusted") return <SlidersHorizontal className="h-3 w-3" aria-hidden />;
  return <X className="h-3 w-3" aria-hidden />;
}

/**
 * THE SETTLED ROW'S OWN SET — one chip per skill the hold ASKED ABOUT, each
 * stating what it recorded (cinatra#2790, epic #2784 S9f).
 *
 * §V, on the reading this builds:
 *
 *   "SETTLED — ONE CHIP PER SKILL, EACH SHOWING WHAT IT RECORDED · The settled
 *    row is still the whole card: each chip states its own outcome in place.
 *    Nothing is summarised above it, and there is nothing left to press."
 *
 * and its own settled drawing is `Enrich contacts ✓ Confirmed`, `Draft email
 * ⇄ Adjusted`, `Schedule send ✕ Skipped` — three skills asked about, three
 * chips, and the skipped one drawn in the skipped treatment (the dashed edge
 * and the muted ground, never a status colour).
 *
 * WHAT THIS FIXES. The decided evidence names only the skills that left a row:
 * a confirm writes a selection row, an adjust writes one, and a SKIP writes
 * neither — the rejected half is recorded only for a candidate the scorer
 * RECOMMENDED. A row whose chips were all force-adds therefore settled one chip
 * short for every Skip that was pressed on it, and the skill the reader had just
 * decided about disappeared from the card that is supposed to state its outcome.
 *
 * THE RULE, stated as the drawing states it: a candidate of the hold's own
 * offer with NO decision row after the hold settled was SKIPPED, because that is
 * the only thing a settled hold can mean by it — the run is not using it.
 *
 * ONE ROW, EVERY HOST. This is the shared §V row: `RecommendationHoldCard` is
 * the one renderer of `recommendation_hold` (cinatra#2573) and it is what the
 * chat transcript, the widget's own conversation column, the run panel and the
 * review page's gate region each mount. Fixing the reading here fixes it on all
 * four by construction, and no host carries a settled reading of its own.
 *
 * A DECIDED ROW THE OFFER DOES NOT NAME IS STILL DRAWN, appended after the
 * offer's own chips: durable evidence is never dropped because the claim it
 * belongs to could not be read. With NO offer at all the answer is the decided
 * evidence unchanged, which is exactly the reading a pre-cinatra#2906 hold has
 * today.
 */
export function settledChipsForRow(
  candidates: ReadonlyArray<RunRecommendationSettledCandidate> | undefined,
  decided: ReadonlyArray<RunRecommendationDecidedSkill>,
): RunRecommendationDecidedSkill[] {
  // ONE CHIP PER SKILL is what the drawing says, so the skill id is what
  // identifies a chip and a repeated id is one skill, not two. BOTH inputs are
  // normalized FIRST-WINS before anything is drawn. Neither durable source can
  // produce a repeat today — the offer is unique on `(hold_id, skill_id)` and
  // `decidedSkillsFromEvidence` keys a map by skill id — but a reading that
  // would draw the same skill twice, under two React keys and possibly two
  // different outcomes, is not something to leave resting on a caller's
  // invariant that this function's own signature does not state.
  const rowBySkillId = new Map<string, RunRecommendationDecidedSkill>();
  for (const row of decided) if (!rowBySkillId.has(row.skillId)) rowBySkillId.set(row.skillId, row);
  const recorded = [...rowBySkillId.values()];
  if (!candidates || candidates.length === 0) return recorded;
  const offered = new Map<string, RunRecommendationSettledCandidate>();
  for (const c of candidates) if (!offered.has(c.skillId)) offered.set(c.skillId, c);
  const drawn = [...offered.values()].map(
    (c) => rowBySkillId.get(c.skillId) ?? { skillId: c.skillId, name: c.name, mark: "skipped" as const },
  );
  for (const row of recorded) if (!offered.has(row.skillId)) drawn.push(row);
  return drawn;
}

/**
 * One SETTLED chip — the skill and the mark it recorded, and nothing to press.
 * §V: "The settled row is still the whole card: each chip states its own outcome
 * in place. Nothing is summarised above it, and there is nothing left to press."
 */
function SettledChip({ skillId, name, mark }: RunRecommendationDecidedSkill): ReactElement {
  return (
    <span
      data-recommendation-chip=""
      data-skill-id={skillId}
      data-chip-mark={mark}
      className={`inline-flex items-center gap-2 rounded-chip border px-3 py-1 text-xs ${MARK_CHIP_CLASS[mark]}`}
    >
      {/* THE NAME, not the id and not the slug (cinatra#2841). §V draws
          "Enrich contacts", "Draft email", "Schedule send" on its settled
          chips — the same labels its held chips carry — and draws NO second,
          package-qualified line beside them, so none is rendered. The name
          arrives already resolved: it is the owning extension's manifest
          `cinatra.displayName`, joined onto the run's id-only evidence by
          `resolveDecidedSkillNames`. The id stays machine-readable on
          `data-skill-id` where the conformance walk reads it. */}
      <span className="font-medium">{name}</span>
      <span className="inline-flex items-center gap-1 font-mono text-badge-2xs uppercase tracking-kicker text-muted-foreground">
        <MarkIcon mark={mark} />
        {MARK_LABEL[mark]}
      </span>
    </span>
  );
}

/**
 * THE ZERO-CHIP SETTLED READING (cinatra#2893) — the outcome panel a settled
 * hold draws when the recorded set names NO skill at all.
 *
 * §V, at the design commit this file's row is drawn to:
 *
 *   "A settled row with nothing to state per skill still states the outcome.
 *    Where the hold settles and the recorded set names NO SKILL AT ALL, there is
 *    no chip to draw — and the card does NOT disappear. In place of the row it
 *    draws one OUTCOME PANEL: the outcome word, and beneath it the one sentence
 *    for that outcome."
 *   "The decider is named only when it can be named. The panel reads 'Skipped
 *    by' a person when the record carries a SAFELY DISPLAYABLE NAME, and the
 *    OUTCOME WORD ALONE when it does not. There is no third face: an
 *    identifier, an address or a truncated handle is NEVER pressed into service
 *    as a name, and the outcome word alone is a true reading, not a degraded
 *    one."
 *
 * THE SAME TREATMENT AS THE SETTLED REVIEW CARD (cinatra#2855). `ReviewGateSettled`
 * composes its title the same way — the outcome word, plus " by <name>" only
 * when the resolver handed it a name it could safely display — and this panel
 * takes that copy rule together with §IV's settled-panel geometry: the size-9
 * marked square over a text-sm semibold outcome line and a text-xs muted
 * sentence. What it does NOT take is a status colour: §V marks a skipped chip
 * with the dashed edge and the muted ground and no tint, so the panel that
 * states the same outcome for a whole row carries exactly that.
 *
 * ONLY THE SKIPPED OUTCOME REACHES IT, and that is a property of the evidence
 * rather than a choice made here. `run-recommendation-actions.ts` answers
 * `confirmed` only when `readRunSelectedSkillRevisions` returned a non-empty
 * set, and `decidedSkillsFromEvidence` writes one entry per selected row — so a
 * confirmed settled state always carries at least one chip. An empty decided
 * set can therefore only accompany the `skipped` answer, which is exactly the
 * state this panel is drawn for.
 */
function SettledOutcomePanel({
  decidedByName,
}: {
  /**
   * A SURFACE-SAFE DISPLAY NAME, or nothing.
   *
   * NOTHING SUPPLIES ONE ON THIS TRUNK, and the reason is worth stating exactly
   * rather than leaving as "not wired yet". The run-level skip record IS here:
   * `run_recommendation_skips` records the decision keyed by run, and it
   * records WHO — `skipped_by`, written from the deciding session's `userId`.
   * What it records is therefore an IDENTIFIER, and an identifier is not a
   * name. `getRunRecommendationHoldStateAction` answers a settled skip with the
   * decided set alone and reads no decider, so every settled zero-chip card
   * drawn from the shipped resolver takes the FALLBACK face — the outcome word
   * alone.
   *
   * THAT IS THE RATIFIED READING, NOT A DEGRADED ONE. The drawing gives the
   * panel two faces and no third: an identifier, an address or a truncated
   * handle is never pressed into service as a name, because "Skipped" is true
   * and "Skipped by 4f3a…" is an id read out to whoever opens the transcript.
   * This prop is the seam a projection lands on when one can resolve
   * `skipped_by` to a name it may safely show — the same class of value
   * `ReviewGateSettled` takes, bounded and meant to be read by a person. A
   * caller holding only an identifier passes nothing.
   */
  decidedByName?: string;
}): ReactElement {
  const by = decidedByName ? ` by ${decidedByName}` : "";
  return (
    <div
      data-recommendation-outcome-panel=""
      data-recommendation-outcome="skipped"
      // The two faces the drawing names, each with its own anchor, so a capture
      // is graded against the face it actually photographed rather than against
      // "the panel".
      data-conformance-id={
        decidedByName
          ? "recommendation-settled-outcome-named"
          : "recommendation-settled-outcome-only"
      }
      className="w-full rounded-control border border-dashed border-line bg-transparent px-4 py-5 text-center"
    >
      <div className="mx-auto mb-2.5 grid size-9 place-items-center rounded-lg bg-surface-muted text-muted-foreground">
        <X aria-hidden="true" className="size-[18px]" />
      </div>
      <p className="font-sans text-sm font-semibold text-foreground">{`Skipped${by}`}</p>
      <p className="mx-auto mt-1 max-w-[46ch] text-xs text-muted-foreground">
        The recommendation is recorded as skipped, and the run went ahead with its
        default skill set.
      </p>
    </div>
  );
}

export function RunRecommendationChipRow({
  runId,
  agentPackageName,
  promptText,
  initialRecommendations,
  holdRef,
  decision,
  canDecide = true,
  variant = "panel",
  submit = SESSION_SUBMIT,
  onDecided,
}: Props) {
  const router = useRouter();
  // The host that declared this surface, read for the card-root declaration
  // above. `null` outside a `LifecycleCardSurfaceProvider`, which on a shipped
  // host cannot happen — `RecommendationHoldCard` refuses to draw without one.
  const lifecycleHost = useLifecycleCardHost();
  // THE CHAT TRANSCRIPT'S EVIDENCE ANCHOR (S9b, cinatra#2794), on the card's OWN
  // root. Under §V the ROW IS THE CARD, so that root is this row's outermost
  // element — the same element carrying the kind/host/state declaration above,
  // not a second wrapper. That is what keeps the mount FAIL-OPEN: a turn with no
  // live hold draws no row, so it adds no marker and no node, and a conversation
  // without a hold is byte-identical to one from before this mount existed. A
  // wrapper rendered by the transcript would sit in every turn whether or not
  // anything was inside it.
  const chatThreadHoldMarker =
    lifecycleHost === "chat_thread" ? { "data-chat-thread-recommendation-hold": "" } : {};
  const [recs, setRecs] = useState<RecommendedSkillForChip[]>(
    initialRecommendations ?? [],
  );
  const [loaded, setLoaded] = useState(initialRecommendations != null);
  /** Per-chip marks — the decision model §V draws, held until the row releases. */
  const [chips, setChips] = useState<Record<string, ChipDecision>>({});
  /**
   * The SAME marks, carried across a batch of presses (cinatra#2905). `chips` is
   * what the row DRAWS; this is what the next press accumulates onto, so a run
   * of presses with no render between them still ends with every mark. The two
   * are written together in `decideChip`, the only place either is set.
   */
  const chipsRef = useRef<Record<string, ChipDecision>>({});
  const [detail, setDetail] = useState<RecommendedSkillForChip | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Chat mount: fetch candidates on mount when not server-prefetched.
  useEffect(() => {
    if (loaded || decision.kind !== "pending") return;
    let cancelled = false;
    getRunRecommendedSkillsAction({ agentPackageName, promptText })
      .then((r) => {
        if (cancelled) return;
        setRecs(r);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loaded, decision.kind, agentPackageName, promptText]);

  // ── The SETTLED row (a released hold) — one chip per skill, each with its
  //    own recorded outcome. No heading, no summary line, nothing to press.
  if (decision.kind !== "pending") {
    const recorded: RunRecommendationDecidedSkill[] =
      decision.decided ??
      (decision.kind === "confirmed"
        ? decision.skillNames.map((name) => ({
            // The pre-#2841 fallback shape: `skillNames` is a bare list with no
            // per-skill evidence behind it, so the one label it carries is both
            // the chip's name and its only handle.
            skillId: name,
            name,
            mark: "confirmed" as const,
          }))
        : []);
    // §V's settled row is one chip per skill the hold ASKED ABOUT, not one per
    // skill that happened to leave a row — see `settledChipsForRow`.
    const settled = settledChipsForRow(decision.candidates, recorded);
    // A settled hold whose durable evidence names no skill at all has nothing
    // PER-SKILL to state — and since cinatra#2893 §V draws the reading for
    // exactly that row: the outcome panel below, in place of the chips. The card
    // root is untouched by the choice, so the kind/host/state declaration a
    // capture is identified by is the same one either reading carries.
    //
    // The one state with no ratified face left. `confirmed` with an empty
    // decided set contradicts its own answer — `confirmed` means at least one
    // skill was kept, and the resolver cannot produce it (see
    // `SettledOutcomePanel`) — so no host mounts it, no outcome word is true of
    // it, and none is invented for it.
    const zeroChip = settled.length === 0;
    if (zeroChip && decision.kind !== "skipped") return null;
    return (
      <div
        data-run-recommendation-chip-row=""
        data-conformance-id="run-chip-row"
        // THE CARD-ROOT DECLARATION (cinatra#2841). The capture contract
        // (`scripts/ci/lib/capture-record-contract.mjs`) identifies a
        // `recommendation_hold` capture by the card root's OWN three
        // attributes, exactly as it does for the review gate — the kind, the
        // host that declared the surface, and the state. The row IS the card
        // (§V), so the row's outermost element carries them; without them no
        // truthful capture of this card could ever satisfy its own contract.
        data-lifecycle-card="recommendation_hold"
        data-lifecycle-card-state="decided"
        // Omitted rather than guessed when no surface declared a host: the
        // component renders outside a provider only in tests.
        data-lifecycle-card-host={lifecycleHost ?? undefined}
        {...chatThreadHoldMarker}
        data-run-recommendation-decision={decision.kind}
        data-run-recommendation-settled="true"
        data-variant={variant}
        className="flex flex-wrap gap-2"
      >
        {zeroChip ? (
          <SettledOutcomePanel
            {...(decision.kind === "skipped" && decision.decidedByName
              ? { decidedByName: decision.decidedByName }
              : {})}
          />
        ) : (
          settled.map((s) => (
            <SettledChip key={s.skillId} skillId={s.skillId} name={s.name} mark={s.mark} />
          ))
        )}
      </div>
    );
  }

  // ── The interactive chip-row (a live parked hold) ────────────────────────

  /**
   * Release the hold with the marks the reader ended on. THE WHOLE-ROW RELEASE
   * DEVIATION lives here: the store cannot record a partial decision, so the row
   * releases once, when every chip has been decided — a confirm carrying the
   * kept set, or a skip when nothing was kept. A skip is not "an empty confirm":
   * an empty selection writes no row at all, which reads back as no decision.
   */
  const release = (next: Record<string, ChipDecision>) => {
    setError(null);
    const kept = recs.filter((r) => next[r.skillId]?.keep === true);
    if (kept.length === 0) {
      startTransition(async () => {
        // A REJECTED action is a refusal, not silence (cinatra#2905 AC-1). The
        // guard is around the ACTION ONLY: an action that rejects — a transport
        // failure, or a server-side throw the framework surfaces as a rejection
        // — left this branch with nothing drawn, the hold still parked and every
        // control still present, which is #2905's observation verbatim. What
        // follows a SUCCESSFUL decision is deliberately outside the guard, so a
        // recorded decision can never be reported as a refusal.
        let res: RunRecommendationDecisionResult;
        try {
          res = await submit.skip({
            runId,
            ...(holdRef ? { holdRef } : {}),
          });
        } catch {
          setError(RECOMMENDATION_ROW_REFUSAL);
          return;
        }
        if (!res.ok) {
          setError(res.error || "Could not skip.");
          return;
        }
        onDecided?.();
        router.refresh();
      });
      return;
    }
    // Forced revisions: a KEPT skill that was NOT recommended is a human-forced
    // addition — pin its exact revision (shipped behaviour, unchanged).
    const forcedRevisions: Record<string, string> = {};
    for (const r of kept) {
      if (!r.recommended) forcedRevisions[r.skillId] = r.skillRevisionId;
    }
    // THE ADJUSTED SET (cinatra#2841). A kept skill whose chip was settled
    // through ADJUST — the reader opened its panel and chose "Keep it in this
    // run" — is written `user_adjusted` rather than `recommended_confirmed`, so
    // the settled row reads back `Adjusted`. Without this the mark was
    // UNREACHABLE for the scored set, which is the only set the row offers: an
    // in-set adjust landed as `recommended_confirmed` and read back `Confirmed`.
    const adjustedSkillIds = kept
      .filter((r) => next[r.skillId]?.mark === "adjusted")
      .map((r) => r.skillId);
    startTransition(async () => {
      // The same guard as the skip branch above, for the same reason.
      let res: RunRecommendationDecisionResult;
      try {
        res = await submit.confirm({
          runId,
          agentPackageName,
          confirmedSkillIds: kept.map((r) => r.skillId),
          promptText,
          forcedRevisions: Object.keys(forcedRevisions).length ? forcedRevisions : undefined,
          adjustedSkillIds: adjustedSkillIds.length ? adjustedSkillIds : undefined,
          ...(holdRef ? { holdRef } : {}),
        });
      } catch {
        setError(RECOMMENDATION_ROW_REFUSAL);
        return;
      }
      if (!res.ok) {
        setError(res.error || "Could not confirm the skill selection.");
        return;
      }
      onDecided?.();
      router.refresh();
    });
  };

  /**
   * Record one chip's own decision; release once every chip has one.
   *
   * THE MARKS ACCUMULATE IN A REF, NOT IN THE RENDER'S OWN COPY (cinatra#2905
   * AC-2). This spread the `chips` value captured in the CURRENT render, so
   * presses that landed with no re-render between them each started from the
   * same base map: only the last mark survived, the all-decided predicate below
   * never became true, and the row never released at all — no write, the hold
   * still parked, nothing drawn. `chipsRef` carries the marks forward across a
   * whole batch, so the predicate is asked of the NEXT state every time.
   *
   * A ref rather than a functional `setChips` updater because the predicate
   * fires `release`: React may invoke a state updater more than once for the
   * same press, and a decision must be released exactly once.
   */
  const decideChip = (skillId: string, mark: RunRecommendationChipMark, keep: boolean) => {
    const next = { ...chipsRef.current, [skillId]: { mark, keep } };
    chipsRef.current = next;
    setChips(next);
    if (recs.length > 0 && recs.every((r) => next[r.skillId] !== undefined)) release(next);
  };

  const openAdjust = (skill: RecommendedSkillForChip) => {
    setDetail(skill);
    setSheetOpen(true);
  };

  const closeAdjust = () => {
    setSheetOpen(false);
    setDetail(null);
  };

  return (
    <div
      data-run-recommendation-chip-row=""
      data-conformance-id="run-chip-row"
      // The same card-root declaration the settled branch carries — see there.
      // A live hold is `held`; the settled row above is `decided`.
      data-lifecycle-card="recommendation_hold"
      data-lifecycle-card-state="held"
      data-lifecycle-card-host={lifecycleHost ?? undefined}
      {...chatThreadHoldMarker}
      data-variant={variant}
      data-can-decide={canDecide ? "true" : "false"}
      className="flex flex-col gap-2"
    >
      <div className="flex flex-wrap gap-2">
        {!loaded ? (
          <span className="text-xs text-muted-foreground">Loading recommendations…</span>
        ) : recs.length === 0 ? (
          <span className="text-xs text-muted-foreground">No candidate skills.</span>
        ) : (
          recs.map((skill) => {
            const chip = chips[skill.skillId];
            return (
              <span
                key={skill.skillId}
                data-recommendation-chip=""
                data-skill-id={skill.skillId}
                data-chip-mark={chip ? chip.mark : "undecided"}
                data-forced={!skill.recommended ? "true" : undefined}
                aria-disabled={canDecide ? undefined : "true"}
                className={`inline-flex items-center gap-2 rounded-chip border px-3 py-1 text-xs ${
                  chip ? MARK_CHIP_CLASS[chip.mark] : "border-line bg-surface-strong text-foreground"
                }`}
                title={
                  skill.recommended
                    ? `Recommended (rank ${skill.rank})`
                    : "Not recommended — adding forces this skill"
                }
              >
                {/* The RESOLVED display label (cinatra#2841) — the owning
                    extension's manifest `cinatra.displayName`, resolved once
                    server-side and carried on `RecommendedSkillForChip.name`.
                    Never re-derived here, and never the package id, which stays
                    on `data-skill-id` above. */}
                <span className="font-medium">{skill.name}</span>
                <span className="inline-flex gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-5 rounded-chip px-2 text-badge-xs font-medium"
                    data-action="confirm-skill -> confirmed"
                    data-skill-action="confirm"
                    data-skill-id={skill.skillId}
                    aria-pressed={chip?.mark === "confirmed"}
                    disabled={!canDecide || pending}
                    onClick={() => decideChip(skill.skillId, "confirmed", true)}
                  >
                    Confirm
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-5 rounded-chip px-2 text-badge-xs font-medium"
                    data-action="adjust-skill -> adjusted"
                    data-skill-action="adjust"
                    data-skill-id={skill.skillId}
                    aria-pressed={chip?.mark === "adjusted"}
                    disabled={!canDecide || pending}
                    onClick={() => openAdjust(skill)}
                  >
                    Adjust
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-5 rounded-chip px-2 text-badge-xs font-medium"
                    data-action="skip-skill -> skipped"
                    data-skill-action="skip"
                    data-skill-id={skill.skillId}
                    aria-pressed={chip?.mark === "skipped"}
                    disabled={!canDecide || pending}
                    onClick={() => decideChip(skill.skillId, "skipped", false)}
                  >
                    Skip
                  </Button>
                </span>
              </span>
            );
          })
        )}
      </div>

      {/* §V's read-only reading: the chips keep their three affordances on
          screen, disabled, and the reason sits under the row. */}
      {!canDecide ? (
        <p data-run-recommendation-restricted="" className="text-xs text-warning">
          Shaping this run needs run access on it.
        </p>
      ) : null}

      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {/* ADJUST opens THIS skill's panel: what it was scored on, and the one
          selection the run's store records for it. Pressing either control
          settles the chip as `adjusted` — the drawing's third mark. */}
      <Sheet
        open={sheetOpen}
        onOpenChange={(open) => {
          if (!open) closeAdjust();
          else setSheetOpen(true);
        }}
      >
        <SheetContent side="right" className="w-[480px] sm:max-w-[480px] overflow-y-auto">
          <SheetHeader>
            {/* The ADJUST panel titles the skill with the SAME resolved label
                its chip prints (cinatra#2841) — one label, one source. */}
            <SheetTitle className="text-foreground">{detail?.name ?? ""}</SheetTitle>
            <SheetDescription className="text-muted-foreground">
              {detail?.recommended
                ? `Recommended · rank ${detail?.rank} · score ${detail?.score?.toFixed?.(2) ?? detail?.score}`
                : "Not among the recommendations for this request."}
            </SheetDescription>
          </SheetHeader>
          {detail ? (
            <div className="mt-4 flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-muted-foreground">Scored on</span>
                <ul className="flex flex-col gap-1">
                  {(detail.scoredFeatures ?? []).map((f, i) => (
                    <li key={i} className="text-xs text-foreground">
                      <span className="text-muted-foreground">{f.kind}</span> · {f.detail}{" "}
                      <span className="text-muted-foreground">(+{f.contribution})</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  data-skill-action="adjust-keep"
                  data-skill-id={detail.skillId}
                  disabled={!canDecide || pending}
                  onClick={() => {
                    const id = detail.skillId;
                    closeAdjust();
                    decideChip(id, "adjusted", true);
                  }}
                >
                  Keep it in this run
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  data-skill-action="adjust-drop"
                  data-skill-id={detail.skillId}
                  disabled={!canDecide || pending}
                  onClick={() => {
                    const id = detail.skillId;
                    closeAdjust();
                    decideChip(id, "adjusted", false);
                  }}
                >
                  Leave it out
                </Button>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ===========================================================================
// COLOCATED ON PURPOSE (route-graph ratchet). The card below is the ONE
// renderer of `recommendation_hold`, and it lives in this module rather than
// its own because a separate file added a module to five ratcheted routes
// (/chat, /sign-in, /api/a2a, /api/mcp, /api/llm-bridge) whose ceilings may
// only ever shrink. Colocating costs nothing structurally: the card composes
// exactly the row above it and nothing else composes the card, so the two are
// one interaction's rendering in one place.
// ===========================================================================
// ---------------------------------------------------------------------------
// `RecommendationHoldCard` — THE renderer of `recommendation_hold`
// (cinatra#2568 AC-1 + AC-5, epic #2564 S4 riders).
// Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` §IV (the card states), §IX (where a card
// appears).
//
// WHAT THIS FILE FINISHES. S1 (#2565) declared `recommendation_hold` in the
// lifecycle registry with carriage `interrupt` — the one kind the run is
// genuinely BLOCKED on. S4 (#2568) put that interrupt on the wire: a typed
// discriminator, a reconnect-authoritative live-state snapshot, and confirm/skip
// routing that never touches `approveReviewTask`. What S4 deliberately left for
// LAST — "the 4s poll is retired LAST, after replay + routing exist" — is this:
// the interaction stops being a hand-rolled 4-second poll beside the panel and
// becomes a CARD, mounted the same way `ReviewGateCard` is, gated by the same
// host declaration, resolved by the same authoritative-refetch discipline.
//
// THE THREE RULES IT INHERITS FROM `lifecycle-card-runtime`, restated because
// this card resolves through a server ACTION rather than the `/resolve` route
// (the hold is an interrupt kind — it has no `DATA_PART` ref envelope to POST):
//
//  1. FAIL-CLOSED SURFACE GATING. A host opts IN via
//     `LifecycleCardSurfaceProvider`. No provider ⇒ no host ⇒ no DOM, and that
//     declaration is the ONLY gate: every declared host draws this card,
//     including the site widget (corrected 2026-08-11 — a signed-in widget
//     reader is the same person with the same rights as inside Cinatra, so the
//     "a widget visitor never shapes a run's skills" row is gone).
//
//  2. NOTHING WITHOUT AN AUTHORIZED RESOLVE. The RESOLVE is the authority, not
//     the wire: it runs the run-access door and intersects the candidate set
//     against the VIEWER (cinatra#2148). Until it answers, this renders nothing
//     — not a skeleton. The wire only ever says "something changed"; it never
//     says what this reader may see. Since cinatra#2790 the resolve has two
//     transports and ONE authority: a cookie host calls the server action, a
//     credential-declaring host posts to the broker endpoint with its own proof,
//     and both land in `resolveRecommendationHoldStateForActor`.
//
//  3. NO TIMER, AT ALL. The card re-resolves on exactly the events that can
//     change the answer: mount, a change in the typed hold interrupt on the wire
//     (announcement or its paired RESUME), window focus (the reader came back
//     after deciding elsewhere), and its own decision landing. A run that is
//     parked, decided, dispatched and parked AGAIN moves the wire ref, so the
//     re-park is picked up without a schedule. That is what makes AC-1's "the
//     poll code path is deleted" a structural property of this file rather than
//     a promise — and the suite reads this file to prove it.
//
// ONE COMPONENT, EVERY HOST. The chip-row drawing itself is UNCHANGED — this
// card composes the shipped `RunRecommendationChipRow` exactly as `ReviewGateCard`
// composes the shipped `ReviewDecisionBar`. No pixel is invented and no second
// chip-row implementation exists; what the card owns is WHETHER the row appears,
// WHICH state it is in, and WHEN that answer is re-read.
// ---------------------------------------------------------------------------
/**
 * The FAILURE-ONLY retry schedule (ms). Bounded, self-terminating, and armed
 * exclusively when a resolve threw — a successful resolve schedules nothing, so
 * the card's steady state is zero timers. Short enough that a transient 5xx
 * heals inside the window a human would notice, small enough that a genuinely
 * down backend is asked four times and then left alone until the reader or the
 * wire says something new.
 */
const RESOLVE_RETRY_DELAYS_MS = [400, 1_500, 4_000] as const;

/**
 * THE DEADLINE ON THE WHOLE READ (cinatra#2790, epic #2784 S9f).
 *
 * The retry budget above only advances when an attempt FINISHES — a request that
 * never settles never fails, so it never spends the budget. That was harmless
 * while nothing depended on the answer arriving; it stopped being harmless when
 * the conversation began WITHHOLDING the run progress card until this read says
 * whether the skills question is open. A hung endpoint would then hide the run
 * card for as long as the tab is open, with nothing on screen to say why.
 *
 * So the read carries a wall-clock deadline. When it passes with no answer, the
 * question is reported unreadable and every host that was waiting on it goes back
 * to what it drew before this rule existed. It is a floor, not a cancellation: a
 * late answer still lands and still replaces the unreadable reading, and the
 * retry budget keeps running underneath it.
 *
 * Longer than the retry budget it backstops (400 + 1500 + 4000 ms plus the
 * attempts themselves), so an endpoint that is merely slow is answered by a retry
 * rather than written off.
 */
const RESOLVE_DEADLINE_MS = 8_000;

/**
 * WHAT THIS RUN'S RECOMMENDATION IS, INCLUDING "NOT KNOWN YET".
 *
 *   `resolving`  — the authoritative read is in flight, or is being retried. The
 *                  answer may still be "held", so a host that must not draw a
 *                  run progress card over an open question WAITS here.
 *   `answered`   — `state` is the authority's own answer for this run.
 *   `unreadable` — the read cannot be completed: the failure budget is spent, or
 *                  the surface declares no lifecycle host to read on. A host
 *                  fails OPEN on this and draws what it drew before the rule
 *                  existed, because a dead read must not be able to empty every
 *                  conversation of its run cards.
 */
export type RunRecommendationHoldResolution = {
  phase: "resolving" | "answered" | "unreadable";
  state: RunRecommendationHoldState | null;
};

/**
 * MUST THE AGENTIC RUN PROGRESS CARD WAIT? (cinatra#2790, epic #2784 S9f.)
 *
 * The plan decides the turn's shape by THIS, not by the presence of a run:
 * "An agentic run progress card is not visible while the recommended skills can
 * be selected, because they are being chosen before the agent actually runs."
 *
 * So the card waits on a live hold AND on a question that has not been answered
 * yet. Waiting on the unanswered case is the whole point: mounting on "not yet"
 * and unmounting on the answer would make the forbidden card VISIBLE — briefly,
 * and every time — which is what the sentence rules out. The cost is that the run
 * progress card of an ordinary, never-held run appears one authoritative read
 * later than it used to.
 *
 * IT FAILS OPEN ON `unreadable`, and that is the balance: a read that cannot be
 * completed leaves the conversation drawing exactly what it drew before this rule
 * existed, rather than emptying every turn of its run card.
 */
export function runCardWaitsForRecommendation(
  resolution: RunRecommendationHoldResolution,
): boolean {
  if (resolution.phase === "resolving") return true;
  return resolution.phase === "answered" && resolution.state?.state === "held";
}

/**
 * WERE THIS RUN'S SKILLS DECIDED ON THE RECOMMENDATION CARD?
 *
 * The other half of the same ruling: "The agentic run progress card appears once
 * the skills are decided; no skill inside it can be selected." A run that was
 * never held answers `none` and is NOT decided — its own affordances are
 * untouched by this slice — and an unanswered or unreadable question is not a
 * decision either.
 */
export function recommendationWasDecided(
  resolution: RunRecommendationHoldResolution,
): boolean {
  if (resolution.phase !== "answered") return false;
  const state = resolution.state?.state;
  return state === "confirmed" || state === "skipped";
}

/** The reading a host starts with, before the card has said anything. */
export const RECOMMENDATION_UNRESOLVED: RunRecommendationHoldResolution = Object.freeze({
  phase: "resolving",
  state: null,
});

/** The reading of a run whose recommendation cannot be read at all. */
export const RECOMMENDATION_UNREADABLE: RunRecommendationHoldResolution = Object.freeze({
  phase: "unreadable",
  state: null,
});

/**
 * The BROKER READ of one run's hold state (cinatra#2790, epic #2784 S9f).
 *
 * `null` means the read did not complete — a transport failure, a refused
 * credential, or an answer that does not parse as a state. It is deliberately
 * distinguishable from `{ state: "none" }`, which is a real answer meaning "this
 * reader gets no row here": the first arms the card's bounded retry, the second
 * settles it silently. Collapsing the two would either hide a dead endpoint
 * behind an empty card or retry forever against an honest refusal.
 *
 * The answer is validated to a known `state` before it is believed, so a
 * mis-routed or truncated response can never paint a card.
 */
async function readHoldStateThroughBroker(
  runId: string,
  auth: LifecycleCardAuth,
): Promise<RunRecommendationHoldState | null> {
  try {
    const response = await fetch(LIFECYCLE_RECOMMENDATION_HOLD_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth.headers() },
      body: JSON.stringify({ runId }),
      credentials: auth.credentials,
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    const state = (payload as { state?: unknown } | null)?.state;
    if (
      state === "none" ||
      state === "held" ||
      state === "confirmed" ||
      state === "skipped"
    ) {
      return payload as RunRecommendationHoldState;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the authoritative hold state for one run.
 *
 * Returns `null` until the first resolve completes — the caller draws nothing
 * while it is null (rule 2 above). A transport failure leaves the last
 * authorized answer in place rather than inventing one; a REFUSAL is not a
 * failure, because the action answers `{ state: "none" }` for a reader who may
 * not see the run, which is indistinguishable from a run that was never held.
 *
 * `wireRef` is the typed hold interrupt's opaque ref (or `null` for "no hold is
 * live"). It is a CHANGE SIGNAL only: nothing is read out of it, and a forged
 * one buys nothing, because the resolve below re-authorizes from scratch.
 *
 * THE IDENTITY IS THE RUN; THE WIRE REF IS A REFRESH TRIGGER. The resolved
 * answer is filed under `runId` and read back only while that still matches, so
 * a wire change re-resolves WITHOUT blanking the card — the last authorized
 * answer stays on screen until the new one lands. That is deliberate and it is
 * the review card's shipped posture for a forced re-resolve of the same identity
 * (`useLifecycleCardResolve`'s `reloadToken`, which is likewise excluded from the
 * identity): a decision or a re-park settles the row without a frame of
 * blankness. Treating the ref as part of the identity would buy nothing — it is
 * the SAME run and the SAME reader either way — and would cost a blank frame on
 * every hold transition.
 *
 * A RE-PARK ALWAYS MOVES THE REF, by construction. The ref is AES-256-GCM over
 * `{runId, parkId}` under a fresh random IV (`encodeRecommendationHoldRef`), so
 * two mints never produce the same string even for the same park. There is no
 * "a new hold happens to reuse the old ref" case to defend against; the worst
 * the randomness costs is one extra authorized resolve when a reconnect
 * re-announces a hold that was already on screen.
 */
function useRecommendationHoldState(params: {
  runId: string;
  wireRef: string | null;
  reloadToken: number;
  /**
   * THE HOST'S CREDENTIAL, or `null` on a cookie surface (cinatra#2790).
   *
   * It selects the READ transport and nothing else. A cookie host keeps the
   * server action, which resolves the ambient session — correct there, and the
   * only thing available to a server action. A credential-declaring host posts
   * to the broker endpoint with its own proof and cookies OMITTED, so the
   * authority answering is the widget's own reader rather than whoever else is
   * signed in on that browser.
   *
   * Both transports answer the SAME `RunRecommendationHoldState`, resolved by
   * the SAME core, so nothing below this line knows which one ran.
   */
  auth: LifecycleCardAuth | null;
}): RunRecommendationHoldResolution {
  const { runId, wireRef, reloadToken, auth } = params;
  const [resolved, setResolved] = useState<{
    runId: string;
    state: RunRecommendationHoldState;
  } | null>(null);
  // THE RUN WHOSE READ GAVE UP — every attempt in the failure budget below was
  // spent without an answer. Filed under the run id, so a later run on the same
  // card starts asking again rather than inheriting a verdict about another run.
  const [unreadableRunId, setUnreadableRunId] = useState<string | null>(null);
  // Monotonic request id — mount, a wire change and a focus can overlap, and a
  // slow earlier answer must never overwrite a fresher one. Same guard shape as
  // `useLifecycleCardResolve`; the reason is identical (a superseded answer is
  // exactly the staleness the refetch exists to prevent).
  const latestRequestRef = useRef(0);

  /**
   * One resolve attempt. `true` means "this trigger is done" — either an answer
   * was filed, or a NEWER request has taken over the chain. `false` means the
   * attempt FAILED and nothing was filed, which is the only case the retry
   * schedule below acts on.
   */
  const resolve = useCallback(async (): Promise<boolean> => {
    const requestId = ++latestRequestRef.current;
    // The run id is CLOSURE-CAPTURED so an answer is filed under the run its
    // request was ISSUED for, never under whichever run the card shows by the
    // time it lands.
    const requestRunId = runId;
    try {
      const state = auth
        ? await readHoldStateThroughBroker(requestRunId, auth)
        : await getRunRecommendationHoldStateAction({ runId: requestRunId });
      // A broker read that could not be completed is a FAILURE, not a state: it
      // arms the bounded retry below rather than settling the card on silence.
      if (state === null) return false;
      // Superseded: a newer trigger owns the answer now. Not a failure — and it
      // must NOT arm a retry, or a burst of wire changes would fan out into a
      // pile of competing retry chains.
      if (requestId !== latestRequestRef.current) return true;
      setResolved({ runId: requestRunId, state });
      return true;
    } catch {
      // Transport/server/serialization failure — stay with the last authorized
      // answer (or with NO answer, which draws nothing). A failed resolve is
      // never turned into a state: an unresolvable card is silent, never
      // optimistic.
      return false;
    }
  }, [runId, auth]);

  useEffect(() => {
    if (!runId) return;
    const requestRunIdForBudget = runId;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // The backstop for a read that never finishes at all — see
    // `RESOLVE_DEADLINE_MS`. Armed once per trigger and cleared with it.
    const deadlineTimer = setTimeout(() => {
      if (!cancelled) setUnreadableRunId(requestRunIdForBudget);
    }, RESOLVE_DEADLINE_MS);
    let attempt = 0;
    const clearRetry = () => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    // A TRIGGER, ITS FAILURE BUDGET, AND NOTHING ELSE.
    //
    // Every trigger below gets ONE resolve. If that resolve FAILS, it gets a
    // small, bounded, self-terminating retry chain — because the failure is the
    // one case where the card is left asserting a state the server has already
    // moved past, with no further event guaranteed to arrive. Concretely: a
    // hold is created, its ref lands, the resolve 500s, the stream stays healthy
    // and emits nothing more, and the reader never leaves the tab — without the
    // budget the run sits parked behind a card that draws nothing, forever. The
    // mirror case (a RESUME whose resolve fails, leaving a decided row showing
    // as pending) is the same defect.
    //
    // THIS IS NOT THE POLL COMING BACK, and the difference is structural rather
    // than a matter of degree: a SUCCESSFUL resolve schedules nothing at all, so
    // the steady state of this card is zero timers. The retired interval ran
    // forever on the success path; this runs only while the card is failing, at
    // most `RESOLVE_RETRY_DELAYS_MS.length` times, and stops on the first
    // answer. It also cannot accumulate: a new trigger clears the pending retry
    // and starts its own budget, and a superseded request returns `true`.
    const run = async (): Promise<void> => {
      if (cancelled) return;
      clearRetry();
      const settled = await resolve();
      if (cancelled || settled) {
        if (settled) attempt = 0;
        return;
      }
      if (attempt >= RESOLVE_RETRY_DELAYS_MS.length) {
        // The budget is spent and nothing more is scheduled. Say so, rather than
        // leaving the caller waiting for an answer that will not arrive: a host
        // that withholds a card until this read lands must be able to stop
        // withholding it when the read is simply unavailable. A wake resets the
        // budget and asks again, and a successful answer replaces this reading.
        setUnreadableRunId(requestRunIdForBudget);
        return;
      }
      const delay = RESOLVE_RETRY_DELAYS_MS[attempt];
      attempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void run();
      }, delay);
    };

    void run();

    // THE WAKE CHANNEL. Beyond the retry budget, the three events that correlate
    // with "the last answer may be wrong, or was never obtained" re-resolve:
    //
    //   focus            — the reader came back after deciding somewhere else
    //                      (the page-vs-card race the epic cares about);
    //   visibilitychange — the same, for a tab restored without a window focus;
    //   online           — connectivity returned, which is a common cause of a
    //                      swallowed resolve.
    //
    // None fires on an idle, connected, focused tab, so they add no steady-state
    // traffic. A wake resets the failure budget, which is exactly right: the
    // reader coming back is new evidence that another attempt is worth making.
    const onWake = () => {
      if (document.visibilityState === "hidden") return;
      attempt = 0;
      void run();
    };
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      cancelled = true;
      clearTimeout(deadlineTimer);
      clearRetry();
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
    // `wireRef` is in the dependency list precisely so the typed interrupt (and
    // its paired RESUME, which nulls it) triggers a re-resolve. That is the
    // whole replacement for the retired 4-second interval.
  }, [runId, wireRef, reloadToken, resolve]);

  // Read the answer back only while it still belongs to the run on screen.
  //
  // THREE READINGS, NOT TWO. "No answer yet" and "no answer is coming" used to
  // be the same `null`, which is exactly the distinction a caller needs when the
  // ANSWER decides what it may draw: a host that treats "not yet" as "not held"
  // draws the run progress card for a frame and then takes it away, which is the
  // very thing the plan forbids. So the hook says which of the two it is, and
  // the caller waits on one and fails open on the other.
  //
  // ONE OBJECT PER ANSWER, not one per render. The reading is published to the
  // host through an effect keyed on it, and a fresh object every render would
  // publish on every render — which, with a host that files it in state, is a
  // loop rather than a notification.
  //
  // AN ANSWER OUTRANKS A LATER FAILURE, and that is deliberate rather than an
  // oversight of the ordering. Once this run's authority has said "held", a
  // refresh that fails changes nothing about the run: it is still parked, and
  // drawing its progress card on the strength of a failed request would show a
  // person a running run that is not running. The fail-open reading exists for
  // the case where NOTHING was ever learned about this run, which is the only
  // case where the pre-rule drawing is the honest one.
  const answered = resolved !== null && resolved.runId === runId ? resolved.state : null;
  const unreadable = unreadableRunId === runId;
  return useMemo<RunRecommendationHoldResolution>(
    () =>
      answered !== null
        ? { phase: "answered", state: answered }
        : unreadable
          ? RECOMMENDATION_UNREADABLE
          : RECOMMENDATION_UNRESOLVED,
    [answered, unreadable],
  );
}

/**
 * The resolved hold state, re-exported so a HOST can name it. The card publishes
 * it inside a resolution through `onStateChange`, and the two conversation
 * surfaces hold that — they reach the card by its own subpath and must not have
 * to know which module inside the agents package declares the shape.
 */
export type { RunRecommendationHoldState };


export function RecommendationHoldCard({
  runId,
  agentPackageName,
  wireRef,
  onStateChange,
}: {
  runId: string;
  /** Fallback package name for the DECIDED summary (the held state carries its own). */
  agentPackageName?: string;
  /**
   * THE RESOLVED STATE, PUBLISHED TO THE HOST THAT MOUNTED THIS CARD
   * (cinatra#2790, epic #2784 S9f).
   *
   * The turn around this card has to draw differently depending on the answer —
   * the run progress card waits while the row is open and arrives when it is
   * decided — and the authoritative answer is resolved HERE, once. Publishing it
   * is what keeps that ONE resolve the only one: a host that asked the same
   * action itself would be a second reader of the same authority, free to
   * disagree with this card by a round trip.
   *
   * "No answer yet" is published as such: the host needs to tell it apart from
   * "no hold", because it withholds the run progress card on the first and draws
   * it on the second. Nothing is invented — an unresolved read says it is
   * unresolved, and a read that gave up says that instead.
   */
  onStateChange?: (resolution: RunRecommendationHoldResolution) => void;
  /**
   * The typed `recommendation_hold` interrupt's ref off the run wire, or `null`
   * when no hold is live. A pure change signal — see `useRecommendationHoldState`.
   * Hosts with no stream pass `null` and still get mount/focus/decision resolves.
   */
  wireRef?: string | null;
}): ReactElement | null {
  // Fail-closed: no declared host ⇒ no card DOM at all. A declared host draws
  // it — the per-surface matrix that withheld this card from the widget is gone.
  const host = useLifecycleCardHost();
  // …and so is the credential-keyed exception that stood here (cinatra#2790,
  // epic #2784 S9f). Until this slice the card refused to draw under a host that
  // declared a credential, because it resolved and decided through COOKIE-BOUND
  // server actions: on a broker surface that is same-origin to the app, a drawn
  // card would have read, and acted, as whoever else was signed in on that
  // browser. Its own comment called that "a shortfall, not a design", and named
  // the condition for deleting it — "when the broker-aware entry lands, this
  // guard is what gets deleted". It has landed: the host's declaration now
  // selects the transport (`readHoldStateThroughBroker` for the read,
  // `brokerRecommendationSubmit` for the two decisions), the authority behind
  // both is built fresh from that host's own credential at the moment of the
  // call, and neither one can fall back to an ambient session.
  //
  // WHAT DID NOT CHANGE, and must not: the host DECLARATION is still the only
  // gate. A surface that has not opted in has no host, and no host is still no
  // DOM at all.
  const auth = useLifecycleCardAuth();
  const present = host !== null;

  // A decision taken IN the row is the one state change the wire cannot be
  // relied on to announce first (the RESUME is published after the action
  // succeeds, and a host may have no stream at all), so the row tells the card
  // directly and the card re-reads the authority.
  const [reloadToken, setReloadToken] = useState(0);
  const onDecided = useCallback(() => setReloadToken((n) => n + 1), []);

  // Hooks run unconditionally (rules of hooks); the resolve itself is cheap and
  // the ABSENT host is enforced on the render below, so a surface that has not
  // declared itself still draws nothing.
  const resolution = useRecommendationHoldState({
    runId: present ? runId : "",
    wireRef: wireRef ?? null,
    reloadToken,
    auth,
  });
  const state = resolution.state;

  // A surface with NO declared host never asks, so its reading is not "waiting"
  // — nothing is coming. Saying so is what stops a host that withholds on
  // `resolving` from withholding for ever on a surface this card never reads on.
  const published: RunRecommendationHoldResolution = present
    ? resolution
    : RECOMMENDATION_UNREADABLE;

  // Published on every change, and only on a change. `onStateChange` is in the
  // dependency list, so a caller passing a fresh closure every render is told
  // again rather than silently ignored; callers hold theirs stable (a state
  // setter) and see exactly one call per answer.
  useEffect(() => {
    onStateChange?.(published);
  }, [published, onStateChange]);

  // The row's decision transport, keyed by the SAME declaration the read is —
  // "a surface that proves itself one way to read and another way to decide is a
  // surface where the two can disagree". Memoized on the declaration so a
  // re-render does not hand the row a new submitter every frame.
  const submit = useMemo(
    () => (auth ? brokerRecommendationSubmit(auth) : SESSION_SUBMIT),
    [auth],
  );

  if (!present) return null;
  if (state === null || state.state === "none") return null;

  return (
    // THE CARD'S OWN IDENTITY ROOT lives on `RunRecommendationChipRow` itself.
    //
    // S9b (cinatra#2794) put kind/host/state on a `display: contents` wrapper
    // here, because the row it wrapped carried no declaration of its own. The §V
    // redraw (cinatra#2841) made THE ROW THE CARD and moved that declaration —
    // kind, host read from the same provider hook, and state — onto the row's
    // outermost element, in both its held and its decided reading. Keeping this
    // wrapper too would have published the identity on TWO nested elements and
    // broken the "ONE root" the contract measures, so the wrapper is gone and
    // the row's own root carries everything, including the chat transcript's
    // evidence marker. Every mount still gets host-correct values by
    // construction, whichever host declared the provider around it — the chat
    // transcript, the run page's own rail step (`run_card`, cinatra#3047), or the
    // review page's gate region.
    <RunRecommendationChipRow
      runId={runId}
      agentPackageName={
        state.state === "held" ? state.agentPackageName : (agentPackageName ?? "")
      }
      promptText={state.state === "held" ? state.promptText : undefined}
      initialRecommendations={state.state === "held" ? state.recommendations : undefined}
      holdRef={state.state === "held" ? state.holdRef : undefined}
      canDecide={state.state === "held" ? state.canDecide !== false : true}
      decision={
        state.state === "held"
          ? { kind: "pending" }
          : state.state === "confirmed"
            ? {
                kind: "confirmed",
                skillNames: state.skillNames,
                decided: state.decided,
                ...(state.candidates ? { candidates: state.candidates } : {}),
              }
            : {
                kind: "skipped",
                decided: state.decided,
                ...(state.candidates ? { candidates: state.candidates } : {}),
              }
      }
      variant="inline"
      submit={submit}
      onDecided={onDecided}
    />
  );
}
