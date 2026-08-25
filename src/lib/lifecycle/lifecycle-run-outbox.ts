// ---------------------------------------------------------------------------
// THE RUN OUTBOX'S WRITER — the card lands in the run's own turn
// (cinatra#2930, epic #2926 W3).
//
// The producer half is `@cinatra-ai/agents/lifecycle-part-outbox`: a leaf port
// the coordinator feeds when a moment opens. THIS is the half that writes,
// because the run's own turn lives in the app's assistant-turn store, which the
// agents package deliberately cannot reach.
//
// WHAT IT DOES, in the plan's own words: "In a conversation the platform itself
// writes the card into the run's own turn, from an outbox the coordinator feeds
// when a moment opens — a durable part with its provenance and its place in the
// turn, so it is there after a reload and whether or not the assistant's model
// says anything."
//
// SO THREE THINGS ARE WRITTEN, and each one is a named field the reload
// projection already consumes:
//   · the part      → `content.dataParts`         — `{ viewType, schemaVersion, ref }`
//   · its place     → `content.dataPartSlots`     — the `agent_run` call this
//                     run was dispatched at, so the restored card lands inside
//                     its producing step exactly where the live render draws it
//   · its provenance→ `content.dataPartProvenance` — `platform_injected`
//
// IT GOES THROUGH THE ONE RECOGNIZER. The part is built as a reserved envelope
// and put through `recognizeLifecycleViewEnvelope` under the platform tuple,
// rather than assembled by hand. A second construction path is a second set of
// bounds, and the bounds are the reason a forged card cannot exist: whatever
// this module writes has passed the same length, shape and producer checks a
// tool result passes.
//
// IDEMPOTENT BY THE CARD'S IDENTITY. A moment can be stated more than once — a
// re-park, a retry, a compare-and-set that re-reads and writes the same value —
// and a person must not collect a column of identical cards. A part with the
// same viewType AND the same ref is already there, so nothing is written.
//
// NEVER THROWS, AND NEVER BLOCKS A RUN. Every unreadable, unresolvable or
// unwritable case returns quietly. The run's own row already states the moment;
// the outbox is what carries it into the conversation the person is in, not
// where the fact lives.
//
// TWO RESIDUALS, NAMED RATHER THAN PAPERED OVER (a convergence review, findings 1
// and 6):
//
//   · NOT DURABLE YET. This drains in the coordinator's own call, so a moment
//     that opens BEFORE the launching turn has persisted its dispatch pointer
//     finds no turn and the card is not injected — it arrives only if a "show
//     me" tool asks for it. The run's own row still states the moment, so the
//     run page and the wait notification are unaffected. Making the outbox a
//     durable row with a drain job is a schema change and is deliberately not
//     folded into this wave; it is the follow-up this note exists to name.
//   · THE LOOKUP IS A CONTENT SCAN. `content @> …` is not covered by an index on
//     `assistant_turns`. That is not introduced here — the wait notification has
//     read the same way for every input wait since cinatra#2729 — but this adds
//     a second caller to it, and an expression/GIN index (or an indexed run
//     pointer) is owed before the read is on a hot path.
// ---------------------------------------------------------------------------

import "server-only";

import type {
  LifecycleMomentOpened,
  LifecyclePartOutbox,
} from "@cinatra-ai/agents/lifecycle-part-outbox";
import {
  LIFECYCLE_PLATFORM_PRODUCER_ACT,
  LIFECYCLE_PLATFORM_PRODUCER_LABEL,
  buildLifecycleViewEnvelope,
  recognizeLifecycleViewEnvelope,
  type LifecycleViewType,
} from "@/lib/assistant-runtime/lifecycle-view-envelope";
import {
  RESERVED_LEGACY_MIRROR_TURN_ID_PREFIX,
  findAssistantTurnForAgentRun,
  updateAssistantTurn,
  type AssistantTurn,
} from "@/lib/assistant-thread-store";

/**
 * The card kinds this writer can put in a turn.
 *
 * A kind whose representation is an INTERRUPT is deliberately absent: the run
 * wire mints no resolve envelope for it, so there is no ref to write and no
 * registry entry to draw it from. Those two kinds are mounted from the run's
 * own state at the `agent_run` part the dispatch already wrote durably — which
 * is the same anchor this writer slots an injected view at, so both deliveries
 * put a card in the same place for the same run.
 */
const INJECTABLE_VIEW_TYPES: ReadonlyArray<LifecycleViewType> = [
  "artifact_review_gate",
  "verification_summary",
  "trigger_schedule_proposal",
];

function isInjectableViewType(kind: string): kind is LifecycleViewType {
  return (INJECTABLE_VIEW_TYPES as readonly string[]).includes(kind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * PURE. THE RESTORED-TURN SLOT: which `tool_call` in this turn dispatched the
 * run?
 *
 * The durable trace records a `tool_call` part and, beside it, an `agent_run`
 * DATA_PART naming the run that call produced. So the slot is found through the
 * pointer the sink already writes rather than by matching a tool name — the
 * same association the reload projection makes when it folds a card onto its
 * producing step.
 *
 * `null` when the turn names no such call, and a `null` slot is a legitimate
 * answer, not a failure: the projection folds an unslotted view in at turn
 * level, which is where a card with no producing step belongs.
 */
export function restoredTurnSlotForRun(
  content: Record<string, unknown> | null,
  runId: string,
): string | null {
  if (!isRecord(content)) return null;
  const dataParts = Array.isArray(content.dataParts) ? content.dataParts : [];
  for (const raw of dataParts) {
    if (!isRecord(raw)) continue;
    if (raw.kind !== "agent_run") continue;
    if (raw.runId !== runId) continue;
    const slot = raw.toolCallId;
    if (typeof slot === "string" && slot.length > 0) return slot;
  }
  return null;
}

/**
 * PURE. Is this card already in the turn?
 *
 * Identity is the viewType AND the ref together: the ref is the moment's
 * server-checked reference, so the same kind at a DIFFERENT moment is a
 * different card and is written, while the same moment stated twice is not.
 */
export function turnAlreadyCarriesCard(
  content: Record<string, unknown> | null,
  viewType: string,
  ref: string,
): boolean {
  if (!isRecord(content)) return false;
  const dataParts = Array.isArray(content.dataParts) ? content.dataParts : [];
  return dataParts.some(
    (raw) => isRecord(raw) && raw.viewType === viewType && raw.ref === ref,
  );
}

/**
 * PURE. The turn's content with the injected part appended, or `null` when
 * nothing should be written.
 *
 * THE THREE ARRAYS ARE KEPT IN STEP, and that is the whole delicacy of this
 * function. `dataPartSlots` and `dataPartProvenance` are positionally aligned
 * with `dataParts`; the reload projection IGNORES a slot array whose length
 * disagrees, and reads every card at turn level instead. So a turn written
 * before those fields existed is BACKFILLED to the length it needs rather than
 * appended to — otherwise this one injection would silently unplace every card
 * already in the turn.
 */
export function contentWithInjectedPart(
  content: Record<string, unknown> | null,
  part: { viewType: string; schemaVersion: number; ref: string },
  slot: string | null,
): Record<string, unknown> | null {
  if (!isRecord(content)) return null;
  if (turnAlreadyCarriesCard(content, part.viewType, part.ref)) return null;
  const dataParts = Array.isArray(content.dataParts)
    ? [...(content.dataParts as unknown[])]
    : [];
  const rawSlots = Array.isArray(content.dataPartSlots)
    ? [...(content.dataPartSlots as unknown[])]
    : [];
  const rawProvenance = Array.isArray(content.dataPartProvenance)
    ? [...(content.dataPartProvenance as unknown[])]
    : [];
  // ALIGN TO THE PRE-INJECTION LENGTH, IN BOTH DIRECTIONS (a convergence review,
  // finding 3). The reload projection IGNORES a slot array whose length
  // disagrees and reads every card at turn level — so an array that is too SHORT
  // (a turn written before the field existed) and one that is too LONG (a writer
  // this reader does not understand) do the same damage: appending to either
  // preserves the mismatch and unplaces every card already in the turn, not just
  // the one being added. Backfilling alone fixed only half of that.
  while (rawSlots.length < dataParts.length) rawSlots.push(null);
  while (rawProvenance.length < dataParts.length) rawProvenance.push(null);
  rawSlots.length = dataParts.length;
  rawProvenance.length = dataParts.length;
  dataParts.push({
    viewType: part.viewType,
    schemaVersion: part.schemaVersion,
    ref: part.ref,
  });
  rawSlots.push(slot);
  rawProvenance.push("platform_injected");
  return {
    ...content,
    dataParts,
    dataPartSlots: rawSlots,
    dataPartProvenance: rawProvenance,
  };
}

/**
 * PURE. Build the injected part through the ONE recognizer, under the platform
 * tuple. `null` for a kind that cannot be injected, a ref that does not fit the
 * envelope bounds, or anything the recognizer refuses.
 */
export function buildInjectedLifecyclePart(entry: {
  cardKind: string;
  cardRef: string | null;
}): { viewType: string; schemaVersion: number; ref: string } | null {
  const { cardKind, cardRef } = entry;
  if (!isInjectableViewType(cardKind)) return null;
  if (typeof cardRef !== "string" || cardRef.length === 0) return null;
  const envelope = buildLifecycleViewEnvelope({ viewType: cardKind, ref: cardRef });
  if (envelope === null) return null;
  const recognized = recognizeLifecycleViewEnvelope({
    serverLabel: LIFECYCLE_PLATFORM_PRODUCER_LABEL,
    toolName: LIFECYCLE_PLATFORM_PRODUCER_ACT,
    result: envelope,
    // THE ONE CALLER THAT MAY (a convergence review, finding 4). This module is server
    // code the model cannot reach; the sink, which handles model-influenced tool
    // results, never passes this, so no tool result can be recognized as an
    // injection however it is labelled.
    admitPlatformProducer: true,
  });
  if (recognized === null) return null;
  // A platform build that came back as anything else is a producer bind that
  // stopped agreeing with itself — refuse rather than write a card whose
  // recorded delivery would be untrue.
  if (recognized.provenance !== "platform_injected") return null;
  return {
    viewType: recognized.viewType,
    schemaVersion: recognized.schemaVersion,
    ref: recognized.ref,
  };
}

/**
 * PURE. The whole decision, given the turn: what to write, or nothing.
 *
 * Separated from the store calls so the injection can be exercised end-to-end
 * without a database, and so the two store calls this module makes stay a
 * READ and a WRITE with no logic between them.
 */
export function injectionForTurn(
  entry: Pick<LifecycleMomentOpened, "runId" | "cardKind" | "cardRef">,
  turn: Pick<AssistantTurn, "id" | "content">,
): { turnId: string; content: Record<string, unknown> } | null {
  const part = buildInjectedLifecyclePart(entry);
  if (part === null) return null;
  const content = isRecord(turn.content) ? turn.content : null;
  if (content === null) return null;
  // NEVER INTO THE MIRROR (a convergence review, finding 5). `assistant_turns` also
  // holds the projection of the client's own transcript, under a reserved id
  // namespace. That row is a COPY of the conversation, written from the browser;
  // a card belongs in the record the server wrote, and writing into the copy
  // would put it somewhere the reload does not read it from and somewhere a
  // client save can overwrite.
  if (turn.id.startsWith(RESERVED_LEGACY_MIRROR_TURN_ID_PREFIX)) return null;
  // …AND ONLY INTO A TURN THAT CARRIES THIS RUN'S OWN DISPATCH (finding 5). The
  // lookup matches on content, so "which turn is this" and "is this really the
  // turn that started the run" have to be two checks rather than one: the
  // durable `agent_run` pointer the SINK wrote is the server's own record of the
  // dispatch, and requiring it means a transcript that merely mentions a run id
  // can never attract another conversation's card. It is also the slot the card
  // is restored at, so the check and the placement are the same fact.
  const slot = restoredTurnSlotForRun(content, entry.runId);
  if (slot === null) return null;
  const next = contentWithInjectedPart(content, part, slot);
  if (next === null) return null;
  return { turnId: turn.id, content: next };
}

/**
 * The wired writer. Best-effort throughout — see the module note.
 */
export const lifecycleRunOutbox: LifecyclePartOutbox = {
  async onMomentOpened(entry: LifecycleMomentOpened): Promise<void> {
    try {
      const turn = findAssistantTurnForAgentRun(entry.runId);
      // Not playing out in a conversation — a schedule firing, another agent, an
      // outside system. The ordinary case, and nothing is owed.
      if (!turn) return;
      const injection = injectionForTurn(entry, turn);
      if (!injection) return;
      // COMPARE AND SET (a convergence review, finding 2). The write replaces the whole
      // content object, so it is pinned to the object that was read: a terminal
      // stream persistence or another moment's card landing in between makes
      // this write a no-op rather than an overwrite. Not writing loses a card
      // that can be stated again; overwriting loses a turn that cannot.
      updateAssistantTurn(injection.turnId, {
        content: injection.content,
        ifContentEquals: turn.content as Record<string, unknown>,
      });
    } catch (err) {
      // The run id is request-influenced, so it is a discrete ARGUMENT and never
      // interpolated into the format string (CodeQL js/tainted-format-string).
      console.warn(
        "[lifecycle-run-outbox] could not inject the",
        entry.moment,
        "card into the turn of run",
        entry.runId,
        "—",
        err instanceof Error ? err.message : String(err),
      );
    }
  },
};
