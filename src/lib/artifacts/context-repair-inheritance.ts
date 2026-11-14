import "server-only";

import {
  readLatestRunContextAnswer,
  readRunContextSelectionsForRun,
  type RunContextAnswer,
  type RunContextSelectionRow,
} from "./run-context-selections-store";
import { refTripleKey, type ContextCandidate } from "./context-route-support";

// ---------------------------------------------------------------------------
// cinatra#3080 — A REPAIR INHERITS EVERY ANSWERED HUMAN STEP FROM ITS OWN
// PRODUCING RUN, THE CONTEXT SELECTION INCLUDED.
//
// The drawing has no human step between the press and the work: "Regenerate
// runs the same producing step again from the words in the note field, files a
// new revision of the same artifact, and settles this gate superseded beneath a
// successor over that same artifact". The delivery already carried the
// producing run's plain input fields, so no SETUP screen stands there any more
// — but a producing template that resolves a context slot composes the
// context-selection child flow, and that flow opens its OWN interactive screen.
// A repair run walked into it and parked, so no revision was ever filed and the
// settled review never got its successor.
//
// A slot the producing run ALREADY ANSWERED, where that answer can be read
// back COMPLETELY, is not a question for the repair. The child flow is routed
// down its own autonomous branch with THAT answer as the selection — the
// branch the flow already has for a slot that needs no person.
//
// THE GATE IS NOT BYPASSED FOR ORDINARY RUNS. Inheritance is refused unless
// ALL of these hold, every one of them read server-side:
//   • the run is a `lifecycle_repair` run carrying a delivered repair request;
//   • it names a producing run of its own (`parent_run_id`, written by the
//     dispatch drain from the repair's own `producer_run_id`);
//   • that producing run's answer to THIS slot can be READ COMPLETELY (below);
//   • the slot admits the answer that reading yields, and every ref of it is
//     still inside the slot's allocation for THIS run.
// Any one of them missing and the ordinary interactive screen opens, exactly as
// it does today.
//
// WHERE THE WHOLE ANSWER IS READ. Finalize appends ONE `run_context_answers`
// row per finalize of a slot: the complete ordered ref set it wrote, an empty
// set included, in the same transaction as the audit rows and the pins. The
// latest answer is that slot's greatest `answer_seq` — the commit order
// finalize assigns under its answer lock, never a clock. That row IS the
// producing run's answer, so the repair inherits it as it stands:
//   • a correction [A] -> [A, B] records [A, B], and [A, B] is inherited;
//   • a correction that removes a ref records the reduced set;
//   • a cleared slot records [], and nothing is inherited as its answer;
//   • two finalizes in the same millisecond are still two places in order.
// The latest answer is read for (run, slot) under ANY package: a run resolves
// every slot under its template's ONE package, so an answer recorded under
// another package is never this package's answer — the screen opens instead
// of carrying it across.
//
// A RUN WITH NO RECORDED ANSWER — finalized before finalize recorded whole
// answers — is read from the per-ref audit rows exactly as before, and those
// rows are not an answer history. Finalize gives every ref its OWN
// content-addressed id and inserts it with ON CONFLICT (id) DO NOTHING; the
// table has no column that groups the refs of one finalize, and the
// append-only trigger forbids every delete. So the rows of a slot are the set
// of refs the run EVER selected there: a correction that adds a ref writes
// only that ref, and one that removes a ref, or clears the slot, writes
// nothing. For such a run, whenever it has ANY audited row for this slot,
// under any package, the screen opens. What the rows DO prove is the empty
// answer: they only ever grow, so a slot with no row at all is a slot for
// which no finalize of that run ever selected a ref.
//
// AN ANSWER OF NOTHING IS STILL AN ANSWER, AND THE REAL ROAD IS MADE OF THEM.
// For a run with no recorded answer, "answered with nothing" and "never
// reached" leave the same trace in the audit rows: none. Reading them apart
// from a SIBLING slot's rows only works for a template that HAS another slot.
// The evidence a single-slot template DOES leave is the repair's own delivered
// request: it is raised over a base revision THE PRODUCING RUN FILED, and the
// producing step that files it is downstream of every context slot the flow
// resolves. A run cannot have filed that revision without having answered this
// slot first — read from the delivery the dispatch drain wrote, never from
// anything a caller says. A delivered request that names no base target
// inherits nothing, and neither does a slot that REQUIRES items.
//
// PROVENANCE IS READ, NEVER ASSERTED. A recorded answer carries who gave it.
// An empty answer of a run with no recorded answer HAS no row, so it is read
// from the mode the producing run ran the slot in, server-read from the trusted
// slot: a person passing an empty INTERACTIVE screen is `user`, an AUTONOMOUS
// slot that resolved to nothing is `autonomous`.
//
// RESIDUAL, NAMED RATHER THAN HIDDEN. The base-revision reading proves the
// delivery names a revision, and the drain writes that revision from the
// repair row's own `base_representation_revision_id`; it does NOT re-prove
// that the run in `parent_run_id` is the run that FILED it. The durable
// linkage exists (`artifact_produced_outbox` is unique per artifact+revision
// and carries `producer_run_id`) and reading it here would close the gap, but
// that read is a NEW gate on the very decision that parked the measured
// repair, so it is not added blind: it is owed the same live press-to-
// successor measurement as the fix itself.
// ---------------------------------------------------------------------------

/** The `source_type` the dispatch drain mints a repair run under. */
export const LIFECYCLE_REPAIR_SOURCE_TYPE = "lifecycle_repair";

/** The run fields inheritance is decided from — all server-read. */
export type RunForContextInheritance = {
  id: string;
  orgId: string | null;
  sourceType?: string | null;
  parentRunId?: string | null;
  inputParams?: Record<string, unknown> | null;
};

/**
 * The producing run a repair run inherits from, or null when the run is not a
 * repair run / names no producing run of its own.
 *
 * Both marks are required. `source_type` alone would admit any row a future
 * writer stamps; the delivered request is what the dispatch drain actually
 * writes for a repair it dispatched, and `parent_run_id` is the producing run
 * IT recorded — never a caller-supplied id.
 */
export function producingRunOfRepair(run: RunForContextInheritance): string | null {
  if (run.sourceType !== LIFECYCLE_REPAIR_SOURCE_TYPE) return null;
  const delivered = (run.inputParams ?? {})["lifecycleRepairRequest"];
  if (!delivered || typeof delivered !== "object" || Array.isArray(delivered)) return null;
  if ((delivered as { kind?: unknown }).kind !== "lifecycle_repair_request") return null;
  const producing = run.parentRunId;
  return typeof producing === "string" && producing.length > 0 ? producing : null;
}

/**
 * The base revision the delivered repair request was raised over, or null when
 * the run is not a repair / its delivery names none.
 *
 * This is the PRODUCING RUN'S OWN OUTPUT: the drain writes `baseTarget` from
 * the repair row's `base_representation_revision_id`, which is the revision the
 * gate under repair pinned, and that gate pins what the producing run filed.
 * The producing step that files it runs downstream of the context subflow, so
 * the presence of this value is a server-read proof that the producing run ran
 * its flow PAST the context slot — the one such proof a single-context-slot
 * template leaves behind.
 */
export function deliveredRepairBaseRevisionId(
  run: RunForContextInheritance,
): string | null {
  if (!producingRunOfRepair(run)) return null;
  const delivered = (run.inputParams ?? {})["lifecycleRepairRequest"] as
    | { baseTarget?: { representationRevisionId?: unknown } }
    | undefined;
  const revision = delivered?.baseTarget?.representationRevisionId;
  return typeof revision === "string" && revision.length > 0 ? revision : null;
}

/**
 * The answer a repair inherits, and who gave it on the producing run.
 *
 * `refs` are the slot's allocated candidates for THIS run, matched by the
 * recorded triples in the recorded order; empty for an answer of nothing.
 */
export type InheritedContextAnswer = {
  refs: ContextCandidate[];
  /** Who gave the answer on the producing run, read from the road that run
   *  ran the slot on. Never upgraded to `user` by the repair. */
  selectedBy: RunContextSelectionRow["selectedBy"];
};

/**
 * The producing run's answer to this slot, or null when it cannot be read
 * completely — then the screen opens.
 *
 * The latest RECORDED answer decides wherever one exists; a run with none (it
 * was finalized before finalize recorded whole answers) inherits only the
 * empty answer its audit rows can prove (see the header).
 */
export function resolveInheritedContextSelection(input: {
  run: RunForContextInheritance;
  slotId: string;
  /** The package the slot is being run under, server-derived. A recorded
   *  answer is inherited only when it was recorded under THIS package; the
   *  audit rows of a run with no recorded answer are read under every package
   *  (see the header). */
  parentPackageName: string;
  /** The slot's ALLOCATED refs, as both routes hand them. A recorded answer is
   *  inherited only when every one of its refs is among them; the refs
   *  returned are these candidates, matched by triple. */
  candidates: ContextCandidate[];
  /** The trusted slot's `minItems`. A slot that admits an empty selection can
   *  have been answered with nothing. */
  slotMinItems: number;
  /** The slot's OWN declared mode, server-read from the trusted slot exactly
   *  as `slotMinItems` is — the provenance of an empty answer that no
   *  recorded row carries (see the header). */
  declaredSelectionMode: "interactive" | "autonomous";
}): InheritedContextAnswer | null {
  const { run, slotId, parentPackageName, candidates, slotMinItems, declaredSelectionMode } =
    input;
  if (!run.orgId) return null;
  const producingRunId = producingRunOfRepair(run);
  if (!producingRunId) return null;

  // THE RECORDED ANSWER: the producing run's latest whole answer to this slot.
  const recorded = readLatestRunContextAnswer({
    orgId: run.orgId,
    parentRunId: producingRunId,
    slotId,
  });
  if (recorded) {
    return inheritRecordedAnswer(recorded, { parentPackageName, candidates, slotMinItems });
  }

  // NO RECORDED ANSWER: the audit rows, read as they always were.
  const audited = readRunContextSelectionsForRun({
    orgId: run.orgId,
    parentRunId: producingRunId,
  });

  // ANY row for this slot, under ANY package: the run picked a context here,
  // and its rows cannot say which of its picks it still holds. Fail closed.
  if (audited.some((row) => row.slotId === slotId)) return null;

  // No row for this slot anywhere: every answer the run gave here was empty —
  // but only where the slot admits that, and only where the producing run
  // demonstrably ran the context flow past this slot: it answered some OTHER
  // slot under this package, or the repair delivered to this run is raised
  // over a base revision that producing run FILED. Otherwise: fail closed.
  if (slotMinItems !== 0) return null;
  const ranTheContextFlow =
    audited.some((row) => row.parentPackageName === parentPackageName) ||
    deliveredRepairBaseRevisionId(run) !== null;
  if (!ranTheContextFlow) return null;

  // No row to copy provenance from: the road the producing run ran the slot
  // on is who gave the empty answer.
  return {
    refs: [],
    selectedBy: declaredSelectionMode === "interactive" ? "user" : "autonomous",
  };
}

/** A recorded answer, inherited whole or not at all. */
function inheritRecordedAnswer(
  recorded: RunContextAnswer,
  input: { parentPackageName: string; candidates: ContextCandidate[]; slotMinItems: number },
): InheritedContextAnswer | null {
  // Recorded under another package: never carried across packages.
  if (recorded.parentPackageName !== input.parentPackageName) return null;
  // A stored value that is no list of refs proves nothing.
  if (recorded.refs === null) return null;
  // The slot must admit the answer as it stands — an empty one included.
  if (recorded.refs.length < input.slotMinItems) return null;

  const byTriple = new Map<string, ContextCandidate>();
  for (const candidate of input.candidates) byTriple.set(refTripleKey(candidate), candidate);

  const refs: ContextCandidate[] = [];
  const seen = new Set<string>();
  for (const ref of recorded.refs) {
    const key = refTripleKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const match = byTriple.get(key);
    // Part of the answer is not the answer: a ref no longer allocated to the
    // slot opens the screen rather than shrinking what the person chose.
    if (!match) return null;
    refs.push(match);
  }
  return { refs, selectedBy: recorded.selectedBy };
}

/**
 * The selection mode this run actually runs the slot in.
 *
 * `autonomous` for a repair inheriting its producing run's answered screen —
 * the child flow's own no-person branch — and the slot's own declared mode for
 * every other run. Both context routes derive it through THIS function from
 * server-read facts, never from the request body, so the resolve response and
 * the finalize check can never disagree about which road the flow took.
 */
export function effectiveSelectionMode(
  declared: "interactive" | "autonomous",
  inherited: InheritedContextAnswer | null,
): "interactive" | "autonomous" {
  return inherited ? "autonomous" : declared;
}
