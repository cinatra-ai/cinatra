import "server-only";

import {
  readRunContextSelectionsForRun,
  type ReadRunContextSelectionRow,
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
// A slot the producing run ALREADY ANSWERED is not a question for the repair.
// The answer is read back from the SAME append-only audit store the answer was
// written to (`run_context_selections`, keyed parent run + slot), and the child
// flow is routed down its own autonomous branch with THAT answer as the
// selection — the branch the flow already has for a slot that needs no person.
//
// THE GATE IS NOT BYPASSED FOR ORDINARY RUNS. Inheritance is refused unless
// ALL of these hold, every one of them read server-side:
//   • the run is a `lifecycle_repair` run carrying a delivered repair request;
//   • it names a producing run of its own (`parent_run_id`, written by the
//     dispatch drain from the repair's own `producer_run_id`);
//   • that producing run holds an audited selection for THIS slot;
//   • every ref it holds is STILL in the trusted candidate set resolved now.
// Any one of them missing and the ordinary interactive screen opens, exactly as
// it does today. A vanished ref is never quietly dropped: a repair that could
// only inherit PART of the answer inherits none of it, because a silently
// different context is a different piece of work, not a repair of this one.
//
// WHICH answer, and WHOSE. The audit store is APPEND-ONLY and says so itself:
// "corrections are a NEW row, never a mutation". A producing run whose person
// answered the slot and then answered it again therefore leaves BOTH answers
// standing, so the rows for a slot are grouped by their write moment and only
// the LATEST group is the answer the run holds — a union of every historical
// row would hand an `override` slot two refs and the finalize would refuse the
// repair outright. The rows are also scoped to the package the slot is being
// run under, so an earlier package identity cannot contaminate the answer. And
// the provenance travels with the answer: the audit row the repair writes says
// exactly what the producing run's row said about who chose, rather than
// asserting a person for a pick a resolver made.
//
// AN ANSWER OF NOTHING IS STILL AN ANSWER — as far as an append-only store of
// PICKS can show it. A slot that declares no `minItems` admits an empty
// selection, which writes no rows at all, so "answered with nothing" and
// "never reached" look identical in isolation. They can be told apart when the
// producing run answered some OTHER slot: that run demonstrably ran the
// context flow to its end, so a slot of its own that admits emptiness and
// holds no row was answered with nothing. When the producing run holds no
// audited row anywhere, the two remain indistinguishable and the screen opens
// — the fail-closed side, and a residual named here rather than hidden.
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
 * The answer a repair inherits: the trusted candidates resolved for THIS run,
 * plus the provenance the producing run's own audit rows recorded for them.
 *
 * `refs` may be empty — an answer of nothing is an answer (see the header).
 */
export type InheritedContextAnswer = {
  refs: ContextCandidate[];
  /** Verbatim from the producing run's rows: what the audit already says about
   *  who chose these refs. Never upgraded to `user` by the repair. */
  selectedBy: ReadRunContextSelectionRow["selectedBy"];
};

/** The rows of the LATEST answer for a slot: the append-only store keeps every
 *  correction, and one finalize batch commits in one transaction, so the rows
 *  sharing the greatest `selectedAt` are the answer the run holds now. */
function latestAnswerRows(
  rows: ReadRunContextSelectionRow[],
): ReadRunContextSelectionRow[] {
  if (rows.length === 0) return [];
  let latest = rows[0]!.selectedAt;
  for (const row of rows) if (row.selectedAt > latest) latest = row.selectedAt;
  return rows.filter((row) => row.selectedAt === latest);
}

/**
 * The producing run's answer to this slot, expressed as the trusted candidates
 * resolved for THIS run — or null when there is nothing to inherit.
 *
 * The refs returned are the candidates the resolver produced now, matched by
 * the audited triple; the stored row supplies the identity of the pick and
 * nothing else, so extension / sourceScope / ownerId always come from the
 * resolver rather than from history.
 */
export function resolveInheritedContextSelection(input: {
  run: RunForContextInheritance;
  slotId: string;
  /** The package the slot is being run under, server-derived — the audited
   *  rows are scoped to it so an earlier package identity cannot contaminate. */
  parentPackageName: string;
  candidates: ContextCandidate[];
  /** The trusted slot's `minItems`. A slot that admits an empty selection can
   *  have been answered with nothing, which writes no audit row. */
  slotMinItems: number;
}): InheritedContextAnswer | null {
  const { run, slotId, parentPackageName, candidates, slotMinItems } = input;
  if (!run.orgId) return null;
  const producingRunId = producingRunOfRepair(run);
  if (!producingRunId) return null;

  const auditedForRun = readRunContextSelectionsForRun({
    orgId: run.orgId,
    parentRunId: producingRunId,
  }).filter((row) => row.parentPackageName === parentPackageName);
  const answered = latestAnswerRows(
    auditedForRun.filter((row) => row.slotId === slotId),
  );

  if (answered.length === 0) {
    // An answer of nothing, but only where it can be READ as one: the slot
    // admits an empty selection AND the producing run demonstrably ran the
    // context flow (it answered some other slot). Otherwise: fail closed.
    const ranTheContextFlow = auditedForRun.length > 0;
    if (slotMinItems === 0 && ranTheContextFlow) {
      return { refs: [], selectedBy: "user" };
    }
    return null;
  }

  const byTriple = new Map<string, ContextCandidate>();
  for (const candidate of candidates) byTriple.set(refTripleKey(candidate), candidate);

  const inherited: ContextCandidate[] = [];
  const seen = new Set<string>();
  for (const row of answered) {
    const key = refTripleKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    const match = byTriple.get(key);
    // Part of the answer is not an answer — open the screen instead.
    if (!match) return null;
    inherited.push(match);
  }
  return { refs: inherited, selectedBy: answered[0]!.selectedBy };
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
