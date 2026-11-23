// ---------------------------------------------------------------------------
// The publish card's STATE SHAPE (cinatra#4150 part 7a-1a): the card and its three settled readings, and the pending,
// loading, restricted and no longer open readings.
//
// What the authorized read (publish-decision-card-core.ts) answers for one reader, and the parse a transport answer
// goes through. This module imports nothing, so the card can import it without reaching the store: only a server entry
// imports the core. Loading and no longer open are the card's own readings (a read in flight, a late answer refused),
// so they are not states of the read; restricted is a pending card whose reader may not decide.
// ---------------------------------------------------------------------------

/** One read-only row: the pack's own label over the value the stop surfaced. */
export type PublishDecisionCardRow = { label: string; value: string };

type PublishDecisionCardCommon = {
  runId: string;
  /** The agent's display name. */
  agentName: string;
  rows: PublishDecisionCardRow[];
};

export type PublishDecisionCardState =
  | { state: "none" }
  /** `decisionId`: the decision row this card shows. An answer names it, so it lands only on that row while it is still the
   *  run's open decision of its current attempt, never on a newer gate the card has not drawn. */
  | (PublishDecisionCardCommon & { state: "pending"; decisionId: string; mayDecide: boolean })
  | (PublishDecisionCardCommon & { state: "approved"; deciderName: string | null })
  | (PublishDecisionCardCommon & { state: "declined"; deciderName: string | null; reason: string | null })
  | (PublishDecisionCardCommon & { state: "expired" });

/** The longest note a decline records: the decision store's own cap, which the card's note field and the widget's decide
 *  route also apply. */
export const PUBLISH_DECISION_MAX_NOTE_LENGTH = 2000;

/** The card's two answers (cinatra#4758): Allow and Do not allow. */
export type PublishDecisionCardAnswer = "approve" | "decline";

/** What a decide door answers: the answer was recorded, the request was no longer open (already answered, expired,
 *  or the run moved on), or the answer did not land (a refusal or a fault; nothing to report beyond that). */
export type PublishDecisionDecideOutcome = "decided" | "not_open" | "failed";

/** Parse a transport's decide answer, or "failed" for anything else. */
export function parsePublishDecisionDecideOutcome(data: unknown): PublishDecisionDecideOutcome {
  const outcome = (data as { outcome?: unknown } | null)?.outcome;
  return outcome === "decided" || outcome === "not_open" ? outcome : "failed";
}

/** Every refusal and every run with nothing to decide: the card draws no DOM at all. */
export const PUBLISH_DECISION_CARD_NONE: PublishDecisionCardState = Object.freeze({ state: "none" });

/**
 * The declared rows over the surfaced values, in the declared order. A value that is missing, empty or not a plain
 * value (an object, a list) is dropped: a row shows what a reader can judge, never a structure or an identifier.
 */
export function publishDecisionCardRows(
  declared: ReadonlyArray<{ label: string; input: string }>,
  surfaced: Record<string, unknown>,
): PublishDecisionCardRow[] {
  const rows: PublishDecisionCardRow[] = [];
  for (const { label, input } of declared) {
    if (!Object.prototype.hasOwnProperty.call(surfaced, input)) continue;
    const raw = surfaced[input];
    const value =
      typeof raw === "string" ? raw : typeof raw === "boolean" || (typeof raw === "number" && Number.isFinite(raw)) ? String(raw) : null;
    if (value !== null && value.trim().length > 0) rows.push({ label, value });
  }
  return rows;
}

const isText = (value: unknown): value is string => typeof value === "string";
const isNameOrNull = (value: unknown): value is string | null => value === null || isText(value);

/**
 * Parse a transport answer back into the state, or `null` for anything this build cannot read. `null` is a FAILURE,
 * never a state. Fields a state does not carry are dropped.
 */
export function parsePublishDecisionCardState(data: unknown): PublishDecisionCardState | null {
  if (data === null || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.state === "none") return PUBLISH_DECISION_CARD_NONE;
  if (!isText(d.runId) || d.runId.length === 0 || !isText(d.agentName) || !Array.isArray(d.rows)) return null;
  const rows: PublishDecisionCardRow[] = [];
  for (const row of d.rows as unknown[]) {
    if (row === null || typeof row !== "object") return null;
    const { label, value } = row as Record<string, unknown>;
    if (!isText(label) || !isText(value)) return null;
    rows.push({ label, value });
  }
  const common = { runId: d.runId, agentName: d.agentName, rows };
  switch (d.state) {
    case "pending":
      return typeof d.mayDecide === "boolean" && isText(d.decisionId) && d.decisionId.length > 0
        ? { state: "pending", ...common, decisionId: d.decisionId, mayDecide: d.mayDecide }
        : null;
    case "approved":
      return isNameOrNull(d.deciderName) ? { state: "approved", ...common, deciderName: d.deciderName } : null;
    case "declined":
      return isNameOrNull(d.deciderName) && isNameOrNull(d.reason)
        ? { state: "declined", ...common, deciderName: d.deciderName, reason: d.reason }
        : null;
    case "expired":
      return { state: "expired", ...common };
    default:
      return null;
  }
}
