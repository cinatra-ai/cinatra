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
//
// ── ORDERING ────────────────────────────────────────────────────────────────
//   Final sort is (ordinal ASC, key ASC) — a total order, so the rail is
//   deterministic. Template steps take ordinals 1..L by display index; surplus
//   stepResults continue L+1, L+2…; a transcript spine takes 1..M in `sequence`
//   order; gates ALWAYS trail the derived-step spine, ordered among themselves by
//   `createdAt` (they are run-keyed, not bound to a policy step number — trailing
//   placement matches the review surface's synthetic trailing "Review" step).
// ---------------------------------------------------------------------------

/** Which of the four merge sources contributed to a rail entry. */
export type RailSource = "template" | "submission" | "message" | "stepResult" | "gate";

/** A rail entry's lifecycle state, derived purely from the merged evidence. */
export type RailStatus = "completed" | "pending" | "resolved" | "upcoming";

/** One merged rail entry. */
export interface RunStepRailEntry {
  /** Stable identity — dedup key AND React key. */
  key: string;
  /** Sort position (see ORDERING). */
  ordinal: number;
  kind: "step" | "gate";
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

export interface BuildRunStepRailInput {
  templateSteps?: readonly RailTemplateStep[];
  submissions?: readonly RailSubmissionMarker[];
  messages?: readonly RailMessage[];
  stepResults?: readonly unknown[] | null;
  gates?: readonly RailGate[];
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

  // Finalize: attach sorted source unions, then total-order sort.
  const entries: RunStepRailEntry[] = [];
  for (const { entry, sources } of byKey.values()) {
    entry.sources = [...sources].sort();
    entries.push(entry);
  }
  entries.sort((a, b) => (a.ordinal !== b.ordinal ? a.ordinal - b.ordinal : a.key.localeCompare(b.key)));

  const active = entries.find((e) => e.status !== "completed" && e.status !== "resolved");
  return { entries, activeOrdinal: active ? active.ordinal : null };
}
