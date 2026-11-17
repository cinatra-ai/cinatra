// ---------------------------------------------------------------------------
// The publish card's STATE SHAPE (cinatra#4150 part 7a-1a): the card and its three settled readings, and the pending,
// loading, restricted and no longer open readings.
//
// What the authorized read (publish-decision-card-core.ts) answers for one reader, and the parse a transport answer
// goes through. This module imports nothing, so the card can import it without reaching the store: only a server entry
// imports the core. Loading and no longer open are the card's own readings (a read in flight, a late answer refused),
// so they are not states of the read; restricted is a pending card whose reader may not decide.
// ---------------------------------------------------------------------------

/** One declared row of a publishing step (cinatra#4150 W4): a text row (the label over one surfaced value, the shape a
 * row without `kind` has always had) or a list row (a table of up to four columns over a surfaced list of records). The
 * compiler writes these; the card reads them. This module owns the shape so the card, the store and the compiler agree. */
export type PublishRowColumn = { label: string; field: string };
export type PublishTextRowDeclaration = { label: string; input: string };
export type PublishListRowDeclaration = { kind: "list"; label: string; input: string; columns: PublishRowColumn[] };
export type PublishRowDeclaration = PublishTextRowDeclaration | PublishListRowDeclaration;

/** The most rows a step may declare, the most columns a list row may declare, and the most records a list row draws. */
export const PUBLISH_ROWS_MAX = 4;
export const PUBLISH_ROW_COLUMNS_MAX = 4;
export const PUBLISH_LIST_ROW_ITEMS_MAX = 50;

/** One read-only row: the pack's own label over the value the stop surfaced. */
export type PublishDecisionCardTextRow = { label: string; value: string };
/** A list row: the column labels, the first records' cells (scalar cells only, one string per column), and how many
 * records the stop surfaced in all, so the card can say how many it does not draw. */
export type PublishDecisionCardListRow = { kind: "list"; label: string; columns: string[]; items: string[][]; total: number };
export type PublishDecisionCardRow = PublishDecisionCardTextRow | PublishDecisionCardListRow;

export const isListRowDeclaration = (row: PublishRowDeclaration): row is PublishListRowDeclaration =>
  (row as { kind?: unknown }).kind === "list";
export const isListCardRow = (row: PublishDecisionCardRow): row is PublishDecisionCardListRow =>
  (row as { kind?: unknown }).kind === "list";

type PublishDecisionCardCommon = {
  runId: string;
  /** The agent's display name. */
  agentName: string;
  rows: PublishDecisionCardRow[];
};

export type PublishDecisionCardState =
  | { state: "none" }
  | (PublishDecisionCardCommon & { state: "pending"; mayDecide: boolean })
  | (PublishDecisionCardCommon & { state: "approved"; deciderName: string | null })
  | (PublishDecisionCardCommon & { state: "declined"; deciderName: string | null; reason: string | null })
  | (PublishDecisionCardCommon & { state: "expired" });

/** Every refusal and every run with nothing to decide: the card draws no DOM at all. */
export const PUBLISH_DECISION_CARD_NONE: PublishDecisionCardState = Object.freeze({ state: "none" });

const scalarText = (raw: unknown): string | null =>
  typeof raw === "string" ? raw : typeof raw === "boolean" || (typeof raw === "number" && Number.isFinite(raw)) ? String(raw) : null;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * The declared rows over the surfaced values, in the declared order. A text row whose value is missing, empty or not a
 * plain value (an object, a list) is dropped: a row shows what a reader can judge, never a structure or an identifier.
 * A list row reads a surfaced list of records: each record gives one cell per column, the column's own field when it is
 * a plain value and an empty cell otherwise; an entry that is not a record is not drawn and not counted. A list with no
 * record is dropped. At most PUBLISH_LIST_ROW_ITEMS_MAX records are drawn; `total` counts them all.
 */
export function publishDecisionCardRows(
  declared: ReadonlyArray<PublishRowDeclaration>,
  surfaced: Record<string, unknown>,
): PublishDecisionCardRow[] {
  const rows: PublishDecisionCardRow[] = [];
  for (const row of declared) {
    const { label, input } = row;
    if (!own(surfaced, input)) continue;
    const raw = surfaced[input];
    if (isListRowDeclaration(row)) {
      if (!Array.isArray(raw)) continue;
      const records = raw.filter(isRecord);
      if (records.length === 0) continue;
      const items = records
        .slice(0, PUBLISH_LIST_ROW_ITEMS_MAX)
        .map((record) => row.columns.map(({ field }) => (own(record, field) ? (scalarText(record[field]) ?? "") : "")));
      rows.push({ kind: "list", label, columns: row.columns.map((c) => c.label), items, total: records.length });
      continue;
    }
    const value = scalarText(raw);
    if (value !== null && value.trim().length > 0) rows.push({ label, value });
  }
  return rows;
}

const isText = (value: unknown): value is string => typeof value === "string";
const isNameOrNull = (value: unknown): value is string | null => value === null || isText(value);
const isTextList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText);

/** A text row (no `kind`), or a list row this build can draw; any other kind is unreadable. */
function parseRow(row: unknown): PublishDecisionCardRow | null {
  if (!isRecord(row)) return null;
  if (own(row, "kind")) {
    if (row.kind !== "list") return null;
    const { label, columns, items, total } = row;
    if (!isText(label) || !isTextList(columns) || columns.length < 1 || columns.length > PUBLISH_ROW_COLUMNS_MAX) return null;
    if (!Array.isArray(items) || items.length < 1 || items.length > PUBLISH_LIST_ROW_ITEMS_MAX) return null;
    if (!items.every((cells) => isTextList(cells) && cells.length === columns.length)) return null;
    if (typeof total !== "number" || !Number.isInteger(total) || total < items.length) return null;
    return { kind: "list", label, columns: [...columns], items: (items as string[][]).map((c) => [...c]), total };
  }
  const { label, value } = row;
  return isText(label) && isText(value) ? { label, value } : null;
}

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
    const parsed = parseRow(row);
    if (parsed === null) return null;
    rows.push(parsed);
  }
  const common = { runId: d.runId, agentName: d.agentName, rows };
  switch (d.state) {
    case "pending":
      return typeof d.mayDecide === "boolean" ? { state: "pending", ...common, mayDecide: d.mayDecide } : null;
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
