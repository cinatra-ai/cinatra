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
//       second entry); a SKIPPED one gets its own entry carrying the lattice
//       reason, so a deliberately-skipped review is distinguishable from no
//       lifecycle machinery running.
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
//   Lifecycle-decision entries trail the gates, ordered among themselves by
//   decision time (then event id).
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
  /** Present iff kind==="gate": the linkage the rail entry deep-links into the
   * relocated review surface with, plus the read-only-history discriminator. */
  gate?: {
    gateId: string;
    reviewTaskId: string;
    disposition: string | null;
    /** resolved ⇒ read-only history; a completed gate submission replays inert. */
    resolved: boolean;
  };
  /** Present iff kind==="verification" (S4, cinatra#2042): the linkage the rail
   * entry deep-links into the review surface's VERIFICATION view with, plus the
   * verdict the "Core analysis" badge shows. */
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
    /** fired | skipped | pending — a `fired` decision only reaches the rail as its
     * own entry when its gate is missing from this run's gate set. */
    outcome: "fired" | "skipped" | "pending";
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
  outcome: "fired" | "skipped" | "pending";
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
  /** The ordinal of the first not-yet-resolved entry (the "you are here" anchor);
   * null when every entry is completed/resolved. */
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
        if (sub.answered) e.status = "completed";
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
      const key = `stepResult:${i}`;
      const ordinal = templateMaxOrdinal + 1 + surplusRank;
      surplusRank += 1;
      upsert(
        key,
        () => ({
          key,
          ordinal,
          kind: "step",
          label: `Step ${i + 1}`,
          status: hasResult ? "completed" : "upcoming",
        }),
        "stepResult",
      );
    }
  });

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
  const sortedGates = [...gates].sort((a, b) => {
    const t = gateTime(a.createdAt) - gateTime(b.createdAt);
    return t !== 0 ? t : a.reviewTaskId.localeCompare(b.reviewTaskId);
  });
  // Gates strictly trail the spine: base off the TRUE max ordinal already
  // assigned (template indices, surplus stepResults, or transcript turns), never
  // a count — a deduped or non-contiguous spine can't push a gate up into it.
  let maxOrdinal = 0;
  for (const { entry } of byKey.values()) maxOrdinal = Math.max(maxOrdinal, entry.ordinal);
  sortedGates.forEach((g, i) => {
    const key = `gate:${g.reviewTaskId}`;
    upsert(
      key,
      () => ({
        key,
        ordinal: maxOrdinal + 1 + i,
        kind: "gate",
        label: "Review",
        status: g.status === "resolved" ? "resolved" : "pending",
        gate: {
          gateId: g.gateId,
          reviewTaskId: g.reviewTaskId,
          disposition: g.disposition,
          resolved: g.status === "resolved",
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
        };
      },
    );
  });

  // (+) VERIFICATIONS (S4, cinatra#2042) — a post-change verification record is
  //     woven in RIGHT AFTER the gate it annotates: it shares the gate's ordinal
  //     and keys `verification:<reviewTaskId>` (which sorts after `gate:<…>` at the
  //     same ordinal), so the "Core analysis" entry sits directly beneath its
  //     Review entry. A verification is a produced, read-only record ⇒ completed.
  //     A verification whose gate is not on the rail falls back to trailing.
  const verifications = input.verifications ?? [];
  for (const v of verifications) {
    const gateEntry = byKey.get(`gate:${v.reviewTaskId}`);
    let maxOrd = 0;
    for (const { entry } of byKey.values()) maxOrd = Math.max(maxOrd, entry.ordinal);
    const ordinal = gateEntry ? gateEntry.entry.ordinal : maxOrd + 1;
    const key = `verification:${v.reviewTaskId}`;
    upsert(
      key,
      () => ({
        key,
        ordinal,
        kind: "verification",
        label: "Core analysis",
        status: "completed",
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
              : "Review gate (missing)",
        // A skipped decision is TERMINAL — it must never become the "you are here"
        // anchor; a pending one legitimately is.
        status: (d.outcome === "pending" ? "pending" : "skipped") as RailStatus,
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

  // `skipped` is TERMINAL (the policy decided not to fire) — like completed and
  // resolved it can never be the "you are here" anchor.
  const active = entries.find(
    (e) => e.status !== "completed" && e.status !== "resolved" && e.status !== "skipped",
  );
  return { entries, activeOrdinal: active ? active.ordinal : null };
}
