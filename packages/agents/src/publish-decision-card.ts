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
 * row without `kind` has always had), a list row (a table of up to four columns over a surfaced list of records), or an
 * artifacts row (C1b: the surfaced artifact revisions, drawn through the review-target island). The compiler writes
 * these; the card reads them. This module owns the shape so the card, the store and the compiler agree.
 * Every member is readonly (the compiler freezes its output), and a text member carries NO kind, so a value with any other
 * kind is no member of the union. */
export type PublishRowColumn = { readonly label: string; readonly field: string };
export type PublishTextRowDeclaration = { readonly label: string; readonly input: string; readonly kind?: never };
export type PublishListRowDeclaration = {
  readonly kind: "list";
  readonly label: string;
  readonly input: string;
  readonly columns: readonly PublishRowColumn[];
};
/** An artifacts row: the input holds a list of `{artifactId, representationRevisionId}` (the shape a review gate pins). */
export type PublishArtifactsRowDeclaration = { readonly kind: "artifacts"; readonly label: string; readonly input: string };
export type PublishRowDeclaration = PublishTextRowDeclaration | PublishListRowDeclaration | PublishArtifactsRowDeclaration;
/** The rows of every declared node, by node id: what the compiler writes and the store reads back. */
export type PublishRowsMap = Readonly<Record<string, readonly PublishRowDeclaration[]>>;

/** The most rows a step may declare, the most columns a list row may declare, and the most records a list row draws. */
export const PUBLISH_ROWS_MAX = 4;
export const PUBLISH_ROW_COLUMNS_MAX = 4;
export const PUBLISH_LIST_ROW_ITEMS_MAX = 50;
export const PUBLISH_ROW_LABEL_MAX = 60;
export const PUBLISH_ROW_FIELD_MAX = 64;

const ONE_LINE = /[\p{Cc}\u2028\u2029]/u;
/** A row or column label: one line of 1 to 60 characters with no leading or trailing space. */
export const isPublishRowLabel = (label: unknown): label is string =>
  typeof label === "string" && label.trim() !== "" && label === label.trim() && label.length <= PUBLISH_ROW_LABEL_MAX &&
  !ONE_LINE.test(label);
/** A column field: one line of 1 to 64 characters with no leading or trailing space. */
export const isPublishRowField = (field: unknown): field is string =>
  typeof field === "string" && field.length >= 1 && field.length <= PUBLISH_ROW_FIELD_MAX && field === field.trim() &&
  !ONE_LINE.test(field);

/** One read-only row: the pack's own label over the value the stop surfaced. */
export type PublishDecisionCardTextRow = { label: string; value: string; kind?: never };
/** A list row: the column labels, the first records' cells (scalar cells only, one string per column), and how many
 * records the stop surfaced in all, so the card can say how many it does not draw. */
export type PublishDecisionCardListRow = { kind: "list"; label: string; columns: string[]; items: string[][]; total: number };
/** An artifacts row (C1b): the island ref that addresses this row (null when the surfaced value is not a target list or
 * the ref cannot be minted: the card then says the items could not be shown), and the server-minted island address for a
 * host that proves itself with its own credential (null on a cookie host). Neither carries a target id: the island
 * reads the targets from the decision itself. */
export type PublishDecisionCardArtifactsRow = { kind: "artifacts"; label: string; ref: string | null; islandSrc: string | null };
export type PublishDecisionCardRow = PublishDecisionCardTextRow | PublishDecisionCardListRow | PublishDecisionCardArtifactsRow;

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** The row's kind from its OWN property only (an inherited `kind` is not read): "text" for a row with no own kind, "list",
 * "artifacts", or null for any other value, which no reader draws. */
export function publishRowKind(row: object): "text" | "list" | "artifacts" | null {
  if (!own(row, "kind")) return "text";
  const kind = (row as { kind?: unknown }).kind;
  return kind === "list" || kind === "artifacts" ? kind : null;
}

/** The declared rows of a decision's node, read by OWN key only: a node id that names an Object.prototype member reads
 * as no declaration. The card and the island read a decision's rows through this one function. */
export function declaredPublishRowsFor(
  byNode: PublishRowsMap | null | undefined,
  nodeId: string,
): readonly PublishRowDeclaration[] {
  const map = byNode ?? {};
  return own(map, nodeId) ? (map[nodeId] ?? []) : [];
}

/** One stored row in a shape the compiler writes (oas-compiler.ts collectPublishRows): a text row (exactly a string label
 * and a string input, the reading it has always had), an artifacts row (exactly kind, label and input, under the label
 * rule) or a list row (exactly kind, label, input and 1 to 4 columns of a label and a field, no field shown twice). The
 * template column reader and the decision store read rows through this one check. */
export function isPublishRowDeclaration(row: unknown): row is PublishRowDeclaration {
  const isObject = (o: unknown): o is Record<string, unknown> => !!o && typeof o === "object" && !Array.isArray(o);
  const keysAre = (o: object, keys: string) => Object.keys(o).sort().join(",") === keys;
  const isColumns = (columns: unknown) =>
    Array.isArray(columns) && columns.length >= 1 && columns.length <= PUBLISH_ROW_COLUMNS_MAX &&
    columns.every((c: unknown) => isObject(c) && keysAre(c, "field,label") && isPublishRowLabel(c.label) && isPublishRowField(c.field)) &&
    new Set(columns.map((c: { field: string }) => c.field)).size === columns.length;
  if (!isObject(row) || typeof row.input !== "string" || typeof row.label !== "string") return false;
  if (keysAre(row, "input,label")) return true;
  if (keysAre(row, "input,kind,label")) return row.kind === "artifacts" && isPublishRowLabel(row.label);
  return keysAre(row, "columns,input,kind,label") && row.kind === "list" && isPublishRowLabel(row.label) && isColumns(row.columns);
}

/** How a server reader draws an artifacts row from its surfaced value, or null to drop it. */
export type DrawPublishArtifactsRow = (
  row: PublishArtifactsRowDeclaration,
  surfaced: unknown,
) => PublishDecisionCardArtifactsRow | null;

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
/**
 * The declared rows over the surfaced values, in the declared order. A text row whose value is missing, empty or not a
 * plain value (an object, a list) is dropped: a row shows what a reader can judge, never a structure or an identifier.
 * A list row reads a surfaced list of records: each record gives one cell per column, the column's own field when it is
 * a plain value and an empty cell otherwise; an entry that is not a record is not drawn and not counted. A list with no
 * record is dropped. At most PUBLISH_LIST_ROW_ITEMS_MAX records are drawn; `total` counts them all. An artifacts row is
 * drawn only by the caller's `drawArtifacts` (the server reader, which mints the row's island ref); without one it is
 * dropped, never drawn as text.
 */
export function publishDecisionCardRows(
  declared: ReadonlyArray<PublishRowDeclaration>,
  surfaced: Record<string, unknown>,
  drawArtifacts?: DrawPublishArtifactsRow,
): PublishDecisionCardRow[] {
  const rows: PublishDecisionCardRow[] = [];
  for (const row of declared) {
    const kind = publishRowKind(row);
    // A kind this build cannot draw is never drawn as text (the stored reader refuses it first).
    if (kind === null) continue;
    const { label, input } = row;
    if (!own(surfaced, input)) continue;
    const raw = surfaced[input];
    if (kind === "artifacts") {
      const drawn = drawArtifacts ? drawArtifacts(row as PublishArtifactsRowDeclaration, raw) : null;
      if (drawn) rows.push(drawn);
      continue;
    }
    if (kind === "list") {
      const list = row as PublishListRowDeclaration;
      if (!Array.isArray(raw)) continue;
      const records = raw.filter(isRecord);
      if (records.length === 0) continue;
      const items = records
        .slice(0, PUBLISH_LIST_ROW_ITEMS_MAX)
        .map((record) => list.columns.map(({ field }) => (own(record, field) ? (scalarText(record[field]) ?? "") : "")));
      rows.push({ kind: "list", label, columns: list.columns.map((c) => c.label), items, total: records.length });
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
/** An island ref on the transport: one base64url word inside the ref codec's 512-character bound. */
const ISLAND_REF = /^[A-Za-z0-9_-]{1,512}$/;
export const PUBLISH_ARTIFACTS_ISLAND_SRC_MAX = 2048;

const ARTIFACTS_ROW_KEYS = ["islandSrc", "kind", "label", "ref"] as const;
/** True only when `o`'s own keys (string, symbol, enumerable or not) are exactly `keys`, each one own. */
const hasExactlyOwnKeys = (o: object, keys: readonly string[]): boolean =>
  Reflect.ownKeys(o).length === keys.length && keys.every((k) => own(o, k));

/** A text row (no `kind`), or a list or artifacts row this build can draw; any other kind is unreadable. */
function parseRow(row: unknown): PublishDecisionCardRow | null {
  if (!isRecord(row)) return null;
  const kind = publishRowKind(row);
  if (kind === null) return null;
  if (kind === "artifacts") {
    // Exactly the four own keys, as the compiler and the stored reader hold their shapes: an extra field (a target
    // list, a value, a symbol, a hidden one) or an inherited one is not an answer this build understands. Compared
    // key by key, never as joined text (a key may itself hold a comma), and each value is read as an own property.
    if (!hasExactlyOwnKeys(row, ARTIFACTS_ROW_KEYS)) return null;
    const label = row.label;
    const ref = row.ref;
    const islandSrc = row.islandSrc;
    if (!isPublishRowLabel(label)) return null;
    if (ref !== null && !(isText(ref) && ISLAND_REF.test(ref))) return null;
    if (islandSrc !== null && !(isText(islandSrc) && islandSrc.length > 0 && islandSrc.length <= PUBLISH_ARTIFACTS_ISLAND_SRC_MAX)) {
      return null;
    }
    // An address with no ref to bind it to is not an answer this build understands.
    if (ref === null && islandSrc !== null) return null;
    return { kind: "artifacts", label, ref, islandSrc };
  }
  if (kind === "list") {
    const { label, columns, items, total } = row;
    // The compiler's label rule holds on the transport too: a row label and each column label.
    if (!isPublishRowLabel(label) || !isTextList(columns) || columns.length < 1 || columns.length > PUBLISH_ROW_COLUMNS_MAX) return null;
    if (!columns.every(isPublishRowLabel)) return null;
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
  if (d.rows.length > PUBLISH_ROWS_MAX) return null;
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
