// A work step is named by its work, never by an ordinal (cinatra#3226) — the
// ladder lives in one leaf, read here and by the spine projection.
import { stepRecordWorkName } from "./step-work-name";

// ---------------------------------------------------------------------------
// Run step-rail merge contract (cinatra#2066, C1; epic #2037).
//
// The canonical run view under /agents renders ONE run-detail contract for BOTH
// template classes (orchestrator-template runs AND single-agent/transcript runs)
// as a LEFT RAIL. The rail is a single ordered step list merged from the THREE
// step sources the run model exposes plus the run's review gates:
//
//   (1) TEMPLATE-DERIVED steps + captured SUBMISSIONS
//         — `buildRunStepperSteps(policy)` projects the approval policy into the
//           display step spine; the submission map (keyed by display index)
//           carries which of those gate steps were answered.
//   (2) TRANSCRIPT messages
//         — the agent_run_messages turn stream (single-agent runs have no policy
//           steps: the transcript IS their progression).
//   (3) stepResults JSON
//         — the persisted per-step output array on the run record.
//   (+) GATES (from C0's listReviewGatesForRun) — woven in as rail steps,
//       INCLUDING resolved ones as read-only history.
//   (+) LIFECYCLE POLICY DECISIONS (cinatra#2047 D-5, from
//       `readLifecycleDecisionsForRun`) — S0's "every fired/skipped decision
//       recorded on the run timeline". A FIRED decision renders AS its gate (no
//       second entry — the gate carries the richer rendering, including its
//       disposition and its deep link); a SKIPPED one gets its own entry carrying
//       the lattice reason, so a deliberately-skipped review is distinguishable
//       from no lifecycle machinery running.
//
// This module is PURE (no DB, no React) so the merge is fixture-pinned. The
// contract — ordering, deduplication, precedence — is defined here in code and
// asserted by run-step-rail.test.ts across all sources incl. overlaps.
//
// ── PRECEDENCE (identity + label authority; highest wins) ──────────────────
//   template  >  stepResult  >  message
//   A step's IDENTITY and LABEL come from the highest-precedence source present
//   at a position; lower sources ENRICH the same entry (add a source tag, drive
//   completion) but never override the label or fork a duplicate entry.
//   GATES are never deduped into a step — a gate is always its own entry so a
//   pending gate and a resolved gate (history) are each individually visible.
//   The one exception (cinatra#3035): a `wayflow-` gate raised at a template
//   step that marks its review stands IN that step's place as its entry, for
//   one marked step or for several (see ORDERING).
//
// ── DEDUP ──────────────────────────────────────────────────────────────────
//   Entries share an identity KEY; same key ⇒ one entry, sources unioned
//   (order-independent). Step keys are `step:<stepNumber>` (template) or
//   `stepResult:<i>` (surplus stepResult past the template length). A captured
//   submission at display index i enriches the template step at i — never a new
//   entry. Transcript milestones (only when they form the spine) key
//   `message:<id>`. Gate keys `gate:<reviewTaskId>` never collide with steps.
//   Lifecycle-decision keys `lifecycle:<eventId>` collide with nothing (the
//   produced-event id is globally unique).
//
// ── ORDERING ────────────────────────────────────────────────────────────────
//   Final sort is (ordinal ASC, key ASC) — a total order, so the rail is
//   deterministic. Template steps take ordinals 1..L by display index; surplus
//   stepResults continue L+1, L+2…; a transcript spine takes 1..M in `sequence`
//   order; gates ALWAYS trail the derived-step spine, ordered among themselves by
//   `createdAt` (they are run-keyed, not bound to a policy step number — trailing
//   placement matches the review surface's synthetic trailing "Review" step).
//   The one exception (cinatra#3035): a `wayflow-` gate of a marked step takes
//   that step's place (its label stays its own, "Review · <artifact>", as the
//   approved drawing labels each review entry), keeping createdAt order among
//   the gates there
//   (the first on the step's ordinal, each later one a fraction past it), each
//   followed by its verification, and the step's own entry is not drawn.
//   With ONE marked step that pauses once, every `wayflow-` gate stands there.
//   With TWO OR MORE, the gate row stores no step, so the gates are tied to their steps by
//   position, as the run reached them: the gates group by their base id (the
//   part before the first `#`; one pause opens one gate per artifact), the
//   groups are ordered by their earliest createdAt, and they pair in order
//   with the OPEN marked steps — the marked steps, in template order, whose
//   display index carries no submission (a marked pause answered as an
//   ordinary gate raised no gate). A marked step with no group keeps its own
//   entry; a group beyond the open marked steps trails the spine. Where the
//   position is not certain — a marked step that pauses more than once (a
//   policy `gateCount` above one), two groups created less than 2 ms apart, or
//   a gate time that is not a time, or a submission walk that stopped at or
//   before a marked step (`submissionsStoppedAtStep`: its submissions do not say
//   which marked steps are open) — no gate is placed, all trail the spine as
//   before and every marked step keeps its own entry; tying those would
//   need a `step_number` column on `artifact_review_gates` written at emission.
//   Within a family of equal createdAt, `#10` follows `#9` (member order).
//   Lifecycle-decision entries trail the gates, ordered among themselves by
//   decision time (then event id).
//   The active entry is the first pending gate in rail order, wherever it
//   stands, as on the live rail; with none, the first entry not yet settled.
// ---------------------------------------------------------------------------

/** Which of the merge sources contributed to a rail entry. */
export type RailSource =
  | "template"
  | "submission"
  | "message"
  | "stepResult"
  | "gate"
  | "verification"
  | "lifecycleDecision";

/** A rail entry's lifecycle state, derived purely from the merged evidence.
 * `skipped` is a TERMINAL, non-blocking state: the lifecycle policy deliberately
 * did not fire this checkpoint (cinatra#2047 D-5). It is not "upcoming" (nothing
 * more will happen) and not "completed" (no work was done). */
export type RailStatus = "completed" | "pending" | "resolved" | "upcoming" | "skipped";

/** One merged rail entry. */
export interface RunStepRailEntry {
  /** Stable identity — dedup key AND React key. */
  key: string;
  /** Sort position (see ORDERING). */
  ordinal: number;
  kind: "step" | "gate" | "verification" | "lifecycleDecision";
  label: string;
  status: RailStatus;
  /** The union of contributing sources (sorted, stable). */
  sources: RailSource[];
  /**
   * `false` iff this row opens NOTHING and must not be drawn as one that does
   * (cinatra#3002).
   *
   * A run executed on the agent runtime leaves one step result, and the rail
   * drew it as a checked, numbered "Step N" inside a stepper trigger — a row
   * that reads as openable and has no target: only gate / verification /
   * lifecycle rows carry one. The row stays (it IS a thing that happened) and
   * loses the affordance. Absent on every other row, whose rendering is
   * unchanged.
   */
  openable?: boolean;
  /**
   * Present only on a gate entry that stands in a declared step's place, and on
   * that gate's verification: that step's policy step number (cinatra#3035).
   */
  onStep?: number;
  /** Present iff kind==="gate": the linkage the rail entry deep-links into the
   * relocated review surface with, plus the read-only-history discriminator. */
  gate?: {
    gateId: string;
    reviewTaskId: string;
    disposition: string | null;
    /** resolved ⇒ read-only history; a completed gate submission replays inert. */
    resolved: boolean;
    /** §I.3: exactly one pending gate is the run rail's current review. */
    current?: boolean;
  };
  /** Present iff kind==="verification" (S4, cinatra#2042): the linkage the rail
   * entry deep-links into the review surface's VERIFICATION view with, plus the
   * verdict the "Audit" badge shows. */
  verification?: {
    gateId: string;
    reviewTaskId: string;
    /** verified | drifted | unmet — drives the rail badge. */
    outcome: string;
  };
  /** Present iff kind==="lifecycleDecision" (cinatra#2047 D-5): a lifecycle POLICY
   * decision that did NOT open a gate. A fired decision needs no entry of its own —
   * it IS the gate entry above. */
  lifecycleDecision?: {
    eventId: string;
    artifactId: string;
    /** fired | skipped | pending | not_classifiable — a `fired` decision only
     * reaches the rail as its own entry when its gate is missing from this run's
     * gate set. */
    outcome: "fired" | "skipped" | "pending" | "not_classifiable";
    /** Which lattice layer decided: org-bound | core-default | manifest |
     * elevation | fail-closed. Drives the rail badge. */
    decidedBy: string | null;
    /** The lattice verdict (skip | forbidden | …). */
    latticeOutcome: string | null;
    /** The human-readable "why" the timeline shows. */
    reason: string;
  };
}

/** The template-derived spine step (the shape `buildRunStepperSteps` returns,
 * narrowed to what the rail reads). */
export interface RailTemplateStep {
  /** 1-based display index (the submission map is keyed on this). */
  index: number;
  /** The policy step number the live resolver keys on. */
  stepNumber: number;
  label: string;
  /** True when the approval policy marks this step as the one that opens its
   *  review (`artifactReviewTargetsInput`, cinatra#3035). */
  marksReview?: boolean;
  /** The policy step's `gateCount`: how many times the step pauses (1 when
   *  absent). Read only for the marked steps (cinatra#3035). */
  gateCount?: number;
}

/** A captured-submission marker for a display step index. */
export interface RailSubmissionMarker {
  stepIndex: number;
  /** Whether real submitted values were captured (a completed gate step). */
  answered: boolean;
}

/** A transcript message, narrowed to what the rail reads. */
export interface RailMessage {
  id: string;
  sequence: number;
  role: "user" | "assistant" | "tool" | "system";
  messageType: "text" | "tool_call" | "tool_result" | "final";
  /** Optional display text for the milestone label. */
  text?: string | null;
}

/** A review gate, narrowed to what the rail reads (from C0's ReviewGateRow). */
export interface RailGate {
  gateId: string;
  reviewTaskId: string;
  status: "pending" | "resolved";
  disposition: string | null;
  /** The actual title of the gate's one pinned artifact, authorized for this
   * reader. Absent on historical inputs and when the target cannot be named. */
  artifactName?: string | null;
  /** Creation time — the gate-ordering key. ISO string or epoch ms. */
  createdAt: string | number | Date;
}

/** A post-change verification record, narrowed to what the rail reads (S4,
 * cinatra#2042). Bound to a gate; deep-links to that gate's verification view. */
export interface RailVerification {
  gateId: string;
  /** The gate's review task id — the deep-link handle. */
  reviewTaskId: string;
  outcome: string;
}

/** A lifecycle POLICY decision for one produced artifact, narrowed to what the
 * rail reads (cinatra#2047 D-5; from `readLifecycleDecisionsForRun`). */
export interface RailLifecycleDecision {
  eventId: string;
  artifactId: string;
  outcome: "fired" | "skipped" | "pending" | "not_classifiable";
  /** The gate a FIRED decision opened (used to suppress a duplicate entry when
   * that gate is already on the rail). */
  gateId: string | null;
  decidedBy: string | null;
  latticeOutcome: string | null;
  reason: string;
  /** Decision time — the ordering key among decisions. ISO string or epoch ms. */
  createdAt: string | number | Date;
}

export interface BuildRunStepRailInput {
  templateSteps?: readonly RailTemplateStep[];
  submissions?: readonly RailSubmissionMarker[];
  /** The policy step number where the submission walk stopped because it could
   *  not prove whose answer came next (cinatra#3035). From that step on a
   *  marked step without a submission may have been answered, so no gate is
   *  tied to a marked step by position. Absent when the walk was not stopped. */
  submissionsStoppedAtStep?: number;
  messages?: readonly RailMessage[];
  stepResults?: readonly unknown[] | null;
  gates?: readonly RailGate[];
  /** Verification records (S4) — woven in RIGHT AFTER the gate each annotates. */
  verifications?: readonly RailVerification[];
  /** Lifecycle policy decisions (cinatra#2047 D-5) — every fired/skipped decision
   * the run's produced-event outbox recorded. A FIRED decision whose gate is
   * already on the rail contributes NO entry (the gate IS its rendering); a
   * SKIPPED / PENDING one — and a fired one whose gate is missing — becomes its
   * own entry carrying the lattice reason. */
  lifecycleDecisions?: readonly RailLifecycleDecision[];
}

export interface RunStepRail {
  entries: RunStepRailEntry[];
  /** The ordinal of the "you are here" anchor: the first pending gate, else the
   * first not-yet-resolved entry (cinatra#3035); null when every entry is
   * completed/resolved. */
  activeOrdinal: number | null;
}

/** A milestone message is a model TURN — an assistant text/final turn. Tool
 * calls/results and user/system lines fold into the right-pane detail, not the
 * rail spine (they would otherwise flood the rail with non-step noise). */
function isMilestoneMessage(m: RailMessage): boolean {
  return m.role === "assistant" && (m.messageType === "text" || m.messageType === "final");
}

function truncateLabel(text: string | null | undefined, fallback: string): string {
  const t = (text ?? "").trim();
  if (!t) return fallback;
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

function gateTime(v: string | number | Date): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? 0 : parsed;
}

// A gate's creation time as a number, or null when it is not a time. The time
// is read in milliseconds from a microsecond column, and the parse can lose one
// more millisecond, so two gate times are ordered only when they lie at least
// REVIEW_ORDER_MARGIN_MS apart (cinatra#3035; the submission walk in
// run-actions.ts reads its times the same way).
const REVIEW_ORDER_MARGIN_MS = 2;
function readGateTime(v: string | number | Date): number | null {
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// One pause opens one gate per artifact as `<id>`, `<id>#2`, `<id>#3`, ... in
// one transaction, so the family's rows share a creation time. Among equal times
// the family keeps its own order, `#10` after `#9` (cinatra#3035): the base id,
// then the member number (the base is 1), then the id.
function splitGateFamily(reviewTaskId: string): { base: string; member: number } {
  const cut = reviewTaskId.indexOf("#");
  if (cut === -1) return { base: reviewTaskId, member: 1 };
  const member = Number(reviewTaskId.slice(cut + 1));
  return {
    base: reviewTaskId.slice(0, cut),
    member: Number.isInteger(member) && member > 0 ? member : Number.MAX_SAFE_INTEGER,
  };
}

function compareReviewGates(a: { createdAt: string | number | Date; reviewTaskId: string }, b: { createdAt: string | number | Date; reviewTaskId: string }): number {
  const time = gateTime(a.createdAt) - gateTime(b.createdAt);
  if (time !== 0) return time;
  const fa = splitGateFamily(a.reviewTaskId);
  const fb = splitGateFamily(b.reviewTaskId);
  if (fa.base !== fb.base) return fa.base.localeCompare(fb.base);
  if (fa.member !== fb.member) return fa.member - fb.member;
  return a.reviewTaskId.localeCompare(b.reviewTaskId);
}

/** Approved app-artifact-review §I.3: the first pending gate in rail order. */
export function electCurrentReviewGate<T extends { status: string; createdAt: string | number | Date; reviewTaskId: string }>(gates: readonly T[]): T | undefined {
  let current: T | undefined;
  for (const gate of gates) {
    if (gate.status !== "pending") continue;
    if (!current || compareReviewGates(gate, current) < 0) current = gate;
  }
  return current;
}

/**
 * Merge the three step sources + the run's gates into ONE ordered rail per the
 * contract documented at the top of this file. Pure and deterministic.
 */
export function buildRunStepRail(input: BuildRunStepRailInput): RunStepRail {
  const templateSteps = input.templateSteps ?? [];
  const submissions = input.submissions ?? [];
  const messages = input.messages ?? [];
  const stepResults = input.stepResults ?? [];
  const gates = input.gates ?? [];

  // key → { entry, sources set } accumulator so dedup is order-independent.
  const byKey = new Map<string, { entry: RunStepRailEntry; sources: Set<RailSource> }>();

  const upsert = (
    key: string,
    seed: () => Omit<RunStepRailEntry, "sources">,
    source: RailSource,
    mutate?: (e: RunStepRailEntry) => void,
  ) => {
    let slot = byKey.get(key);
    if (!slot) {
      slot = { entry: { ...seed(), sources: [] }, sources: new Set() };
      byKey.set(key, slot);
    }
    slot.sources.add(source);
    mutate?.(slot.entry);
    return slot.entry;
  };

  // (1) TEMPLATE spine — canonical identity + label at ordinals 1..L by index.
  const submissionByIndex = new Map<number, RailSubmissionMarker>();
  for (const s of submissions) submissionByIndex.set(s.stepIndex, s);
  const templateLen = templateSteps.length;
  // The greatest template ordinal actually assigned — surplus stepResults trail
  // it, so a NON-CONTIGUOUS `index` set can never collide with a surplus entry.
  let templateMaxOrdinal = 0;
  for (const step of templateSteps) {
    templateMaxOrdinal = Math.max(templateMaxOrdinal, step.index);
    upsert(
      `step:${step.stepNumber}`,
      () => ({
        key: `step:${step.stepNumber}`,
        ordinal: step.index,
        kind: "step",
        label: step.label,
        status: "upcoming",
      }),
      "template",
    );
    // captured submission at this display index ⇒ enrich + complete.
    const sub = submissionByIndex.get(step.index);
    if (sub) {
      upsert(`step:${step.stepNumber}`, () => ({} as never), "submission", (e) => {
        // A marked review step holds a submission only when it paused as an
        // ordinary gate and was answered (cinatra#3035): it is passed, also
        // when the answer stored no values (a bare approval).
        if (sub.answered || step.marksReview === true) e.status = "completed";
      });
    }
  }

  // (3) stepResults — align by 1-based position to the template spine; enrich.
  //     Surplus results past the spine become their own trailing entries, ranked
  //     sequentially AFTER the greatest template ordinal (collision-proof even if
  //     the template indices are non-contiguous).
  let surplusRank = 0;
  stepResults.forEach((result, i) => {
    const hasResult = result !== null && result !== undefined;
    if (i < templateLen) {
      const step = templateSteps[i];
      upsert(`step:${step.stepNumber}`, () => ({} as never), "stepResult", (e) => {
        if (hasResult) e.status = "completed";
      });
    } else {
      // NAMED BY ITS WORK, OR NOT DRAWN (cinatra#3226). The ratified drawing's
      // rail names every entry by the work done — "A work step shows what it
      // did" — never by its position; this entry used to be labelled `Step N`.
      // The ladder (`step-work-name.ts`): the record's own name, then its
      // description, then the name of the work it produced. A record that
      // names nothing is not a step the rail can show at a glance, so it takes
      // no entry rather than a number.
      const workName = stepRecordWorkName(result);
      if (workName === null) return;
      const key = `stepResult:${i}`;
      const ordinal = templateMaxOrdinal + 1 + surplusRank;
      surplusRank += 1;
      upsert(
        key,
        () => ({
          key,
          ordinal,
          kind: "step",
          label: workName,
          status: hasResult ? "completed" : "upcoming",
          // Nothing to open: a step result has no target on any surface
          // (cinatra#3002).
          openable: false,
        }),
        "stepResult",
      );
    }
  });

  // THE READINGS THIS RAIL DOES NOT DRAW, AND WHO OWNS THEM (cinatra#3002 fix
  // leg 2, named so the next reader does not re-derive them here):
  //   * the run's own DONE record — the ratified drawing's "a finished run says
  //     what it made", whose last rail entry opens a page listing one row per
  //     artifact the run wrote or used. It is a whole page and a whole entry
  //     kind, not a label change, and it is NOT this issue's item: #3002 is the
  //     completed run's produced TEXT reaching the run page.
  //   * the current-position marker on the rail — cinatra#3149.
  //   * the settled SCHEDULE entry standing first — cinatra#3174 / cinatra#3193.
  //   * a step drawn with a raw declared field name where a readable step name
  //     belongs: that label comes from the run's INPUT-step projection
  //     (`run-input-steps.ts`, cinatra#3068), which renders the agent's own
  //     declared input title verbatim. The surplus step-result entry below is
  //     labelled `Step N` and never carries a declared key.
  // (2) TRANSCRIPT — only forms the spine when NO template steps AND no
  //     stepResults exist (a single-agent / leaf transcript run). Otherwise the
  //     transcript is the right-pane detail, not the rail.
  const transcriptFormsSpine = templateLen === 0 && stepResults.length === 0;
  if (transcriptFormsSpine) {
    // `sequence` is unique per run (agent_run_messages_run_id_sequence_uniq);
    // the id tie-breaker keeps the projection input-order-independent even for a
    // hand-built fixture that violates that invariant.
    const milestones = messages
      .filter(isMilestoneMessage)
      .sort((a, b) => (a.sequence !== b.sequence ? a.sequence - b.sequence : a.id.localeCompare(b.id)));
    milestones.forEach((m, i) => {
      const key = `message:${m.id}`;
      upsert(
        key,
        () => ({
          key,
          ordinal: i + 1,
          kind: "step",
          label: truncateLabel(m.text, `Response ${i + 1}`),
          // A persisted transcript turn already happened ⇒ completed.
          status: "completed",
        }),
        "message",
      );
    });
  }

  // (+) GATES — always their own trailing entries in createdAt order. A resolved
  //     gate is read-only history; a pending gate is the active decision. A gate
  //     is unique per (run, reviewTaskId) (artifact_review_gates_run_task_uniq),
  //     so `gate:<reviewTaskId>` is a stable, non-colliding key within a run.
  const sortedGates = [...gates].sort(compareReviewGates);
  const currentReviewTaskId = electCurrentReviewGate(gates)?.reviewTaskId;
  // Gates strictly trail the spine: base off the TRUE max ordinal already
  // assigned (template indices, surplus stepResults, or transcript turns), never
  // a count — a deduped or non-contiguous spine can't push a gate up into it.
  let maxOrdinal = 0;
  for (const { entry } of byKey.values()) maxOrdinal = Math.max(maxOrdinal, entry.ordinal);
  // A DECLARED STEP AND ITS REVIEW ARE ONE ENTRY (cinatra#3035). Only the
  // marked branch writes a gate named `wayflow-…`, so such a gate was raised at
  // a step the template marks. When exactly one template step marks its review
  // and pauses once, every such gate stands there. When two or more do, the
  // gates are tied to their steps by position (see ORDERING): one group per marked pause, paired
  // in order with the marked steps that raised a gate.
  const markedSteps = templateSteps.filter((step) => step.marksReview === true);
  const standsInByGate = new Map<string, RailTemplateStep>();
  const wayflowGates = sortedGates.filter((g) => g.reviewTaskId.startsWith("wayflow-"));
  // THE PLACE IS READ ONLY WHERE IT IS CERTAIN. A marked step that pauses more
  // than once can raise several groups, or a group and an ordinary pause that
  // is still to be answered there, so no gate is tied to a step and every gate
  // trails the spine as it does on main; the step keeps its own entry.
  const pausesOnce = markedSteps.every((step) => (step.gateCount ?? 1) <= 1);
  if (markedSteps.length === 1 && pausesOnce) {
    for (const g of wayflowGates) standsInByGate.set(g.reviewTaskId, markedSteps[0]);
  } else if (markedSteps.length > 1 && pausesOnce) {
    // A marked step that holds a submission at its display index paused as an
    // ordinary gate and raised no gate. The submission walk gives a marked step
    // an answer only when no gate group of it came first, so the entry's
    // presence is the reading, whatever values it stored (a bare approval
    // stores none).
    const openMarkedSteps = markedSteps
      .filter((step) => !submissionByIndex.has(step.index))
      .sort((a, b) => a.index - b.index);
    // The part of a gate's id before the first `#` — the same cut as
    // `baseReviewTaskId` (src/lib/artifacts/artifact-review-target.ts): one
    // pause opens one gate per artifact as `<id>`, `<id>#2`, …
    const baseOf = (reviewTaskId: string) => splitGateFamily(reviewTaskId).base;
    const earliestByBase = new Map<string, number>();
    let timesRead = true;
    for (const g of wayflowGates) {
      const base = baseOf(g.reviewTaskId);
      const t = readGateTime(g.createdAt);
      if (t === null) {
        timesRead = false;
        continue;
      }
      const seen = earliestByBase.get(base);
      if (seen === undefined || t < seen) earliestByBase.set(base, t);
    }
    const groups = [...earliestByBase.entries()].sort((a, b) => a[1] - b[1]);
    // Groups are tied to steps by their reach order, so a gate time that is not
    // a time, or two groups less than the margin apart, leaves the order
    // unproven: no group is tied to a step and every gate trails the spine.
    // The open marked steps are read from the submissions, so they are known
    // only up to where the walk stopped: a marked step at or after that step
    // may have fallen back and been answered (cinatra#3035).
    const stoppedAt = input.submissionsStoppedAtStep;
    const stopIndex =
      stoppedAt === undefined
        ? null
        : (templateSteps.find((step) => step.stepNumber === stoppedAt)?.index ?? Number.NEGATIVE_INFINITY);
    const submissionsKnown = stopIndex === null || markedSteps.every((step) => step.index < stopIndex);
    const reachOrderKnown =
      submissionsKnown &&
      timesRead &&
      groups.every((group, i) => i === 0 || group[1] - groups[i - 1][1] >= REVIEW_ORDER_MARGIN_MS);
    if (reachOrderKnown) {
      const stepByBase = new Map<string, RailTemplateStep>();
      groups.forEach(([base], i) => {
        if (i < openMarkedSteps.length) stepByBase.set(base, openMarkedSteps[i]);
      });
      for (const g of wayflowGates) {
        const step = stepByBase.get(baseOf(g.reviewTaskId));
        if (step !== undefined) standsInByGate.set(g.reviewTaskId, step);
      }
    }
  }
  // The gates standing in each step, in createdAt order. Each takes its own
  // ordinal inside the step's place — the first the step's own, each later one a
  // fraction past it — so every entry keeps an ordinal of its own and the one
  // the run is parked on is the one `activeOrdinal` names.
  const foldedKeysByStep = new Map<number, string[]>();
  for (const g of sortedGates) {
    const step = standsInByGate.get(g.reviewTaskId);
    if (step === undefined) continue;
    const keys = foldedKeysByStep.get(step.stepNumber) ?? [];
    const key = `gate:${g.reviewTaskId}`;
    if (!keys.includes(key)) keys.push(key);
    foldedKeysByStep.set(step.stepNumber, keys);
  }
  let trailingRank = 0;
  sortedGates.forEach((g) => {
    const key = `gate:${g.reviewTaskId}`;
    const standsIn = standsInByGate.get(g.reviewTaskId) ?? null;
    const foldedKeys = standsIn !== null ? (foldedKeysByStep.get(standsIn.stepNumber) ?? []) : [];
    const ordinal =
      standsIn !== null
        ? standsIn.index + foldedKeys.indexOf(key) / foldedKeys.length
        : maxOrdinal + 1 + trailingRank++;
    upsert(
      key,
      () => ({
        key,
        ordinal,
        kind: "gate",
        label: g.artifactName?.trim() ? `Review · ${g.artifactName.trim()}` : "Review",
        status: g.status === "resolved" ? "resolved" : "pending",
        ...(standsIn !== null ? { onStep: standsIn.stepNumber } : {}),
        gate: {
          gateId: g.gateId,
          reviewTaskId: g.reviewTaskId,
          disposition: g.disposition,
          resolved: g.status === "resolved",
          current: g.reviewTaskId === currentReviewTaskId,
        },
      }),
      "gate",
      (e) => {
        // A gate that re-appears (idempotent) keeps its resolved/pending truth.
        e.status = g.status === "resolved" ? "resolved" : "pending";
        e.gate = {
          gateId: g.gateId,
          reviewTaskId: g.reviewTaskId,
          disposition: g.disposition,
          resolved: g.status === "resolved",
          current: g.reviewTaskId === currentReviewTaskId,
        };
      },
    );
  });
  // The gate IS the marked step's entry once one stands there.
  for (const stepNumber of foldedKeysByStep.keys()) byKey.delete(`step:${stepNumber}`);

  // (+) VERIFICATIONS (S4, cinatra#2042) — a post-change verification record is
  //     woven in RIGHT AFTER the gate it annotates: it shares the gate's ordinal
  //     and keys `verification:<reviewTaskId>` (which sorts after `gate:<…>` at the
  //     same ordinal), so the "Audit" entry sits directly beneath its
  //     Review entry. A verification is a produced, read-only record ⇒ completed.
  //     A verification whose gate is not on the rail falls back to trailing.
  const verifications = input.verifications ?? [];
  for (const v of verifications) {
    const gateEntry = byKey.get(`gate:${v.reviewTaskId}`);
    let maxOrd = 0;
    for (const { entry } of byKey.values()) maxOrd = Math.max(maxOrd, entry.ordinal);
    const ordinal = gateEntry ? gateEntry.entry.ordinal : maxOrd + 1;
    const key = `verification:${v.reviewTaskId}`;
    // A folded gate's verification stays with it, in its step's place.
    const onStep = gateEntry?.entry.onStep;
    upsert(
      key,
      () => ({
        key,
        ordinal,
        kind: "verification",
        label: "Audit",
        status: "completed",
        ...(onStep !== undefined ? { onStep } : {}),
        verification: { gateId: v.gateId, reviewTaskId: v.reviewTaskId, outcome: v.outcome },
      }),
      "verification",
      (e) => {
        e.verification = { gateId: v.gateId, reviewTaskId: v.reviewTaskId, outcome: v.outcome };
      },
    );
  }

  // (+) LIFECYCLE POLICY DECISIONS (cinatra#2047 D-5) — the run timeline's record
  //     of EVERY fired/skipped lifecycle decision. A FIRED decision whose gate is
  //     already an entry contributes nothing (that gate IS its rendering, complete
  //     with its disposition); everything else — a SKIPPED decision (org-forbidden
  //     / default-skip / manifest-skip), a decision still awaiting orchestration,
  //     and a fired decision whose gate is absent from this run's gate set — gets
  //     its own trailing entry carrying the lattice reason. Keys
  //     `lifecycle:<eventId>` (the event id is globally unique and disjoint from
  //     every step/gate/verification key), ordered by decision time.
  const decisions = input.lifecycleDecisions ?? [];
  if (decisions.length > 0) {
    const gateIdsOnRail = new Set<string>();
    for (const { entry } of byKey.values()) {
      if (entry.gate) gateIdsOnRail.add(entry.gate.gateId);
    }
    const projected = decisions
      .filter((d) => !(d.outcome === "fired" && d.gateId != null && gateIdsOnRail.has(d.gateId)))
      .sort((a, b) => {
        const t = gateTime(a.createdAt) - gateTime(b.createdAt);
        return t !== 0 ? t : a.eventId.localeCompare(b.eventId);
      });
    let maxOrd = 0;
    for (const { entry } of byKey.values()) maxOrd = Math.max(maxOrd, entry.ordinal);
    projected.forEach((d, i) => {
      const key = `lifecycle:${d.eventId}`;
      const seed = () => ({
        key,
        ordinal: maxOrd + 1 + i,
        kind: "lifecycleDecision" as const,
        label:
          d.outcome === "skipped"
            ? "Review skipped"
            : d.outcome === "pending"
              ? "Review pending policy"
              : d.outcome === "not_classifiable"
                ? "Review not classifiable"
                : "Review gate (missing)",
        // A skipped / not-classifiable decision is TERMINAL — neither may become
        // the "you are here" anchor. A PENDING decision legitimately is, and so is
        // a FIRED decision whose gate is missing: that is an incoherent state an
        // operator has to look at, never a quiet terminal one (Codex convergence).
        status: (d.outcome === "pending" || d.outcome === "fired"
          ? "pending"
          : "skipped") as RailStatus,
        lifecycleDecision: {
          eventId: d.eventId,
          artifactId: d.artifactId,
          outcome: d.outcome,
          decidedBy: d.decidedBy,
          latticeOutcome: d.latticeOutcome,
          reason: d.reason,
        },
      });
      upsert(key, seed, "lifecycleDecision", (e) => {
        // Idempotent re-appearance keeps the latest truth.
        const s = seed();
        e.label = s.label;
        e.status = s.status;
        e.lifecycleDecision = s.lifecycleDecision;
      });
    });
  }

  // Finalize: attach sorted source unions, then total-order sort.
  const entries: RunStepRailEntry[] = [];
  for (const { entry, sources } of byKey.values()) {
    entry.sources = [...sources].sort();
    entries.push(entry);
  }
  entries.sort((a, b) => (a.ordinal !== b.ordinal ? a.ordinal - b.ordinal : a.key.localeCompare(b.key)));

  return { entries, activeOrdinal: electRailActiveOrdinal(entries) };
}

/**
 * THE ENTRY THE RUN STANDS ON, AS BOTH RAILS ELECT IT (cinatra#3035).
 *
 * A pending review gate is where the run waits, wherever it stands: the first
 * one in rail order, in a step's place or trailing the spine. The live rail
 * elects the same row (`electRunRailActiveStep`: the parked gate wins, in a
 * step's place first), so the run-frame rail and the stepper column highlight
 * one row, the same one. With no pending gate it is the first entry not yet
 * settled. `skipped` is TERMINAL (the policy decided not to fire) — like
 * completed and resolved it can never be the "you are here" anchor.
 */
function electRailActiveOrdinal(entries: readonly RunStepRailEntry[]): number | null {
  const parkedGate = entries.find((e) => e.kind === "gate" && e.status === "pending");
  const active =
    parkedGate ??
    entries.find((e) => e.status !== "completed" && e.status !== "resolved" && e.status !== "skipped");
  return active ? active.ordinal : null;
}
