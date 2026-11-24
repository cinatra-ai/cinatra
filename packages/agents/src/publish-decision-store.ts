import "server-only";

// publish-decision-store (cinatra#4150): one stop in front of a declared publishing step.
// `decide` is the ONE way a row leaves `parked`: one conditional UPDATE in a transaction, so
// one of two concurrent answers wins, and a row it cannot read rolls the answer back. Every
// read error and every unreadable row THROWS: it never reads as "no open decision".
// A decision belongs to one ATTEMPT of its run: the park stamps the run's reset_generation on it (run_generation), and a
// retry's reset raises the run's generation in its compare-and-set (run-transition.ts). Every run-level read below judges
// only the CURRENT attempt's rows (run_generation = the run's reset_generation), so a closed decision of an earlier
// attempt never holds, labels or stops a later one.

import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { and, asc, desc, eq, getTableColumns, gt, inArray, lte, sql } from "drizzle-orm";

import { db } from "./db";
import { isPublishRowDeclaration, isPublishRowInput, PUBLISH_ROW_INPUT_MAX, type PublishRowDeclaration } from "./publish-decision-card";
import { agentRunPublishDecisions, agentRuns } from "./schema";

/** A decision of the run's current attempt: its run_generation equals the run's reset_generation, read in the same
 *  statement. A row with NO generation (written by code older than the column, e.g. an old node during a rolling deploy)
 *  is always current, so it always holds (fail closed); the reset that ends its attempt stamps it. False, never null,
 *  when the run row is gone. Exported so every reader of a run's decisions judges the attempt by this one predicate. */
export const CURRENT_ATTEMPT = sql<boolean>`coalesce(coalesce(${agentRunPublishDecisions.runGeneration}, (select attempt_run.reset_generation from ${agentRuns} attempt_run where attempt_run.id = ${agentRunPublishDecisions.runId})) = (select attempt_run.reset_generation from ${agentRuns} attempt_run where attempt_run.id = ${agentRunPublishDecisions.runId}), false)`;

export const PUBLISH_DECISION_STATUSES = ["parked", "released", "declined", "expired", "run_ended"] as const;
export type PublishDecisionStatus = (typeof PUBLISH_DECISION_STATUSES)[number];
export type PublishDecisionOutcome = Exclude<PublishDecisionStatus, "parked">;

/** How long a stop waits for a person before the expiry sweep ends it. */
export const PUBLISH_DECISION_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const PUBLISH_DECISION_MAX_DUE_PAGE = 1000;
// Caps. Text is stored as given, never trimmed: an id is matched by equality.
export const PUBLISH_DECISION_MAX_ID_LENGTH = 256;
export const PUBLISH_DECISION_MAX_NOTE_LENGTH = 2000;
export const PUBLISH_DECISION_MAX_SURFACED_BYTES = 64 * 1024;
/** The most rows one declaration may hold, and the longest label or input name in one. */
export const PUBLISH_DECISION_MAX_DECLARED_ROWS = 32;
export const PUBLISH_DECISION_MAX_DECLARED_TEXT = PUBLISH_ROW_INPUT_MAX;

/** One row the template declared for a publishing node: the pack's label over one of the node's inputs, in one of the
 *  shapes the compiler writes (a text row, a list row with its columns, or an artifacts row; publish-decision-card.ts). */
export type PublishDeclaredRow = PublishRowDeclaration;

export class PublishDecisionError extends Error {
  readonly code: "invalid-input" | "invalid-transition" | "malformed-row" | "not-found" | "conflict";
  constructor(code: PublishDecisionError["code"], message: string) {
    super(message);
    this.name = "PublishDecisionError";
    this.code = code;
  }
}

export interface PublishDecisionRow {
  id: string;
  orgId: string | null;
  runId: string;
  nodeId: string;
  gateTaskId: string;
  a2aContextId: string | null;
  status: PublishDecisionStatus;
  surfacedValues: Record<string, unknown>;
  /** The rows the template declared for this node at the park; null = not recorded (an older row). */
  declaredRows: PublishDeclaredRow[] | null;
  /** The run's reset generation at the park; -1 = an ended attempt; null = a row older than the column (read as 0). */
  runGeneration: number | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
  expiresAt: Date;
}

type StoredRow = typeof agentRunPublishDecisions.$inferSelect;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is PublishDecisionStatus {
  return (PUBLISH_DECISION_STATUSES as readonly unknown[]).includes(value);
}

/** A stored row this module cannot read is an error, never a quiet default. Errors name no id or value. */
function deserialize(row: StoredRow): PublishDecisionRow {
  if (!isStatus(row.status)) throw new PublishDecisionError("malformed-row", "a stored decision has an unknown status");
  let surfacedValues: unknown = null;
  try {
    surfacedValues = JSON.parse(row.surfacedValues);
  } catch { /* reported below, with every other shape this module cannot read */ }
  if (!isPlainObject(surfacedValues)) {
    throw new PublishDecisionError("malformed-row", "a stored decision has unreadable surfaced values");
  }
  let declaredRows: PublishDeclaredRow[] | null = null;
  if (row.declaredRows !== null && row.declaredRows !== undefined) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(row.declaredRows);
    } catch { /* reported below */ }
    declaredRows = declaredRowsOf(parsed);
    if (declaredRows === null) throw new PublishDecisionError("malformed-row", "a stored decision has unreadable declared rows");
  }
  return { ...row, status: row.status, surfacedValues, declaredRows, runGeneration: row.runGeneration ?? null };
}

/** A declaration as plain rows in a shape the compiler writes (isPublishRowDeclaration: a text, list or artifacts row),
 *  each label and input within the caps; null for any other shape. A row is copied field by field, so the stored text
 *  holds only the fields its shape names. */
function declaredRowsOf(value: unknown): PublishDeclaredRow[] | null {
  if (!Array.isArray(value) || value.length > PUBLISH_DECISION_MAX_DECLARED_ROWS) return null;
  const rows: PublishDeclaredRow[] = [];
  for (const row of value as unknown[]) {
    if (!isPlainObject(row) || !isPublishRowDeclaration(row)) return null;
    const { label, input } = row;
    if (label.length === 0 || label.length > PUBLISH_DECISION_MAX_DECLARED_TEXT || !isPublishRowInput(input)) return null;
    if (row.kind === "list") {
      rows.push({ kind: "list", label, input, columns: row.columns.map(({ label: l, field }) => ({ label: l, field })) });
    } else if (row.kind === "artifacts") {
      rows.push({ kind: "artifacts", label, input });
    } else {
      rows.push({ label, input });
    }
  }
  return rows;
}

export const PUBLISH_DECISION_MAX_SURFACED_DEPTH = 64;

const OWN_REFUSALS = new WeakSet<object>(); // the refusals plainJson raises; the catch below passes only these
/** Copies surfaced values as plain data, each own property read once through its descriptor (no getter runs), and refuses
 *  every value JSON would drop, change or fail on, -0 and proxies included, so the stored text reads back as the same object. */
function plainJson(value: unknown, depth: number, open: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
  const refuse = (why: string) => { const error = new PublishDecisionError("invalid-input", `surfacedValues ${why}`); OWN_REFUSALS.add(error); return error; };
  if (typeof value !== "object") throw refuse("must hold only strings, finite numbers other than -0, booleans, null, arrays and plain objects");
  if (types.isProxy(value)) throw refuse("must not hold a proxy");
  if (open.has(value)) throw refuse("must not contain itself");
  if (depth > PUBLISH_DECISION_MAX_SURFACED_DEPTH) throw refuse(`must nest at most ${PUBLISH_DECISION_MAX_SURFACED_DEPTH} levels`);
  const array = Array.isArray(value);
  const proto: unknown = Object.getPrototypeOf(value); // checked before the `in` test below, so no trap in a prototype runs
  if (array ? proto !== Array.prototype || Object.getPrototypeOf(Array.prototype) !== Object.prototype : proto !== Object.prototype && proto !== null) throw refuse("must hold only plain objects and arrays");
  const keys = Reflect.ownKeys(value).filter((key) => !(array && key === "length")); // an array's own "length"
  const props = keys.map((key) => Reflect.getOwnPropertyDescriptor(value, key));
  if ("toJSON" in value || (array && keys.length !== (value as unknown[]).length)
    || keys.some((key, i) => typeof key !== "string" || (array && key !== String(i)) || !props[i]?.enumerable || !("value" in props[i]!))) {
    throw refuse("must hold only plain objects and dense arrays of data properties, with no toJSON, getter, symbol or hidden keys");
  }
  open.add(value);
  const copy: object = array ? [] : {};
  keys.forEach((key, i) => Object.defineProperty(copy, key, { value: plainJson(props[i]!.value, depth + 1, open), enumerable: true, writable: true, configurable: true }));
  open.delete(value);
  return copy;
}

function requireText(value: unknown, name: string, max = PUBLISH_DECISION_MAX_ID_LENGTH): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new PublishDecisionError("invalid-input", `${name} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

const optionalText = (value: unknown, name: string): string | null => (value === null ? null : requireText(value, name));

export interface InsertParkedDecisionInput {
  orgId: string | null;
  runId: string;
  nodeId: string;
  gateTaskId: string;
  a2aContextId: string | null;
  surfacedValues: Record<string, unknown>;
  /** The rows the dispatched plan declares for this node, kept with the decision; null or absent = not recorded. */
  declaredRows?: ReadonlyArray<PublishDeclaredRow> | null;
  ttlMs?: number;
}

export interface InsertParkedDecisionResult {
  /** False when this stop already had a row, whatever its status; `decision` is that row, unchanged. */
  inserted: boolean;
  /** The row belongs to the run's current attempt: a new row stamped while the run was held at a gate (running or
   *  pending_approval), or an existing row of the current generation. */
  current: boolean;
  decision: PublishDecisionRow;
}

export async function insertParkedDecision(input: InsertParkedDecisionInput): Promise<InsertParkedDecisionResult> {
  const runId = requireText(input.runId, "runId");
  const nodeId = requireText(input.nodeId, "nodeId");
  const gateTaskId = requireText(input.gateTaskId, "gateTaskId");
  const orgId = optionalText(input.orgId, "orgId");
  const a2aContextId = optionalText(input.a2aContextId, "a2aContextId");
  const top: unknown = input.surfacedValues;
  let surfaced: string | null = null;
  try { // only the refusals plainJson raises pass; any other failure becomes the typed error, with no value text
    if (typeof top === "object" && top !== null && (types.isProxy(top) || !Array.isArray(top))) surfaced = JSON.stringify(plainJson(top, 1, new Set()));
  } catch (error) {
    throw OWN_REFUSALS.has(error as object) ? error : new PublishDecisionError("invalid-input", "surfacedValues could not be read as plain data");
  }
  if (surfaced === null || Buffer.byteLength(surfaced, "utf8") > PUBLISH_DECISION_MAX_SURFACED_BYTES) {
    throw new PublishDecisionError("invalid-input", `surfacedValues must be an object of at most ${PUBLISH_DECISION_MAX_SURFACED_BYTES} bytes of JSON`);
  }
  let declared: string | null = null;
  if (input.declaredRows !== undefined && input.declaredRows !== null) {
    const rows = declaredRowsOf(input.declaredRows);
    if (rows === null) {
      throw new PublishDecisionError("invalid-input", `declaredRows must be at most ${PUBLISH_DECISION_MAX_DECLARED_ROWS} rows of a label and an input of at most ${PUBLISH_DECISION_MAX_DECLARED_TEXT} characters`);
    }
    declared = JSON.stringify(rows);
  }
  const ttlMs = input.ttlMs ?? PUBLISH_DECISION_DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new PublishDecisionError("invalid-input", "ttlMs must be a positive finite number");
  }

  const [row] = await db
    .insert(agentRunPublishDecisions)
    .values({
      id: randomUUID(), orgId, runId, nodeId, gateTaskId, a2aContextId, status: "parked", surfacedValues: surfaced,
      declaredRows: declared,
      // The run's generation, read in this statement, only while the run is held at a gate; else -1 (an ended attempt).
      runGeneration: sql`coalesce((select live_run.reset_generation from ${agentRuns} live_run where live_run.id = ${runId} and live_run.status in ('running', 'pending_approval')), -1)`,
      expiresAt: sql`now() + (${ttlMs} || ' milliseconds')::interval`,
    })
    .onConflictDoNothing({
      target: [agentRunPublishDecisions.runId, agentRunPublishDecisions.nodeId, agentRunPublishDecisions.gateTaskId],
    })
    .returning();
  if (row) return { inserted: true, current: row.runGeneration !== null && row.runGeneration >= 0, decision: deserialize(row) };

  const [existing] = await db
    .select({ ...getTableColumns(agentRunPublishDecisions), current: CURRENT_ATTEMPT })
    .from(agentRunPublishDecisions)
    .where(and(eq(agentRunPublishDecisions.runId, runId), eq(agentRunPublishDecisions.nodeId, nodeId),
      eq(agentRunPublishDecisions.gateTaskId, gateTaskId)))
    .limit(1);
  if (!existing) throw new PublishDecisionError("conflict", "the stop conflicted and has no row");
  const { current, ...stored } = existing;
  return { inserted: false, current: current === true, decision: deserialize(stored) };
}

export interface DecideInput {
  from: "parked";
  to: PublishDecisionOutcome;
  /** The deciding person for `released` and `declined`; null for the two outcomes no person decides. */
  actor: string | null;
  /** Only a decline carries a note. */
  note?: string | null;
  /** Wins only while no newer decision of the same run exists and the row belongs to the run's current attempt, checked in
   *  the same UPDATE (the expiry's rule): a decision of an ended attempt never stops the attempt a retry started. */
  newestOnly?: boolean;
}

export type DecideResult =
  | { outcome: "won"; decision: PublishDecisionRow }
  | { outcome: "lost"; currentStatus: PublishDecisionStatus };

/** Refuses every combination the record does not admit, before any write. */
function requireTransition(input: DecideInput): { actor: string | null; note: string | null } {
  if (input.from !== "parked") {
    throw new PublishDecisionError("invalid-transition", "a decision leaves only the parked status");
  }
  const note = input.note == null ? null : requireText(input.note, "note", PUBLISH_DECISION_MAX_NOTE_LENGTH);
  switch (input.to) {
    case "released":
    case "declined": {
      const actor = requireText(input.actor, "actor");
      if (input.to === "released" && note !== null) {
        throw new PublishDecisionError("invalid-transition", "only a decline carries a note");
      }
      return { actor, note };
    }
    case "expired":
    case "run_ended":
      if (input.actor !== null || note !== null) {
        throw new PublishDecisionError("invalid-transition", `${input.to} names no person and carries no note`);
      }
      return { actor: null, note: null };
    default:
      throw new PublishDecisionError("invalid-transition", "unknown decision outcome");
  }
}

/** No newer decision (by created_at, then id) of the same run follows this row. */
const NO_NEWER_DECISION = sql`not exists (select 1 from ${agentRunPublishDecisions} newer where newer.run_id = ${agentRunPublishDecisions.runId} and (newer.created_at, newer.id) > (${agentRunPublishDecisions.createdAt}, ${agentRunPublishDecisions.id}))`;

export async function decide(id: string, input: DecideInput): Promise<DecideResult> {
  const decisionId = requireText(id, "id");
  const { actor, note } = requireTransition(input);

  return db.transaction(async (tx): Promise<DecideResult> => {
    const [won] = await tx
      .update(agentRunPublishDecisions)
      .set({ status: input.to, decidedBy: actor, decidedAt: sql`now()`, decisionNote: note })
      .where(and(eq(agentRunPublishDecisions.id, decisionId), eq(agentRunPublishDecisions.status, "parked"),
        ...(input.newestOnly ? [NO_NEWER_DECISION, CURRENT_ATTEMPT] : [])))
      .returning();
    if (won) return { outcome: "won", decision: deserialize(won) };

    const [current] = await tx
      .select()
      .from(agentRunPublishDecisions)
      .where(eq(agentRunPublishDecisions.id, decisionId))
      .limit(1);
    if (!current) throw new PublishDecisionError("not-found", "no decision has this id");
    return { outcome: "lost", currentStatus: deserialize(current).status };
  });
}

/**
 * The publish rows of the plan the run's current attempt was dispatched with (agent_runs.dispatch_publish_rows), for one
 * node: the node's rows, [] when the plan declares none for it (an own key only), or null when the dispatch recorded no
 * map or the map cannot be read. A read error propagates.
 */
export async function readDispatchedPublishRows(runId: string, nodeId: string): Promise<PublishDeclaredRow[] | null> {
  const [run] = await db
    .select({ rows: agentRuns.dispatchPublishRows })
    .from(agentRuns)
    .where(eq(agentRuns.id, requireText(runId, "runId")))
    .limit(1);
  if (!run || typeof run.rows !== "string") return null;
  let map: unknown = null;
  try {
    map = JSON.parse(run.rows);
  } catch { /* unreadable: not recorded */ }
  if (!isPlainObject(map)) return null;
  const node = requireText(nodeId, "nodeId");
  return Object.prototype.hasOwnProperty.call(map, node) ? declaredRowsOf(map[node]) : [];
}

/** The newest decision of this step in the run's current attempt, whatever its status. */
export async function readDecisionForRunNode(runId: string, nodeId: string): Promise<PublishDecisionRow | null> {
  const [row] = await db
    .select()
    .from(agentRunPublishDecisions)
    .where(
      and(
        eq(agentRunPublishDecisions.runId, requireText(runId, "runId")),
        eq(agentRunPublishDecisions.nodeId, requireText(nodeId, "nodeId")),
        CURRENT_ATTEMPT,
      ),
    )
    .orderBy(desc(agentRunPublishDecisions.createdAt), desc(agentRunPublishDecisions.id))
    .limit(1);
  return row ? deserialize(row) : null;
}

/** The newest decision of the run's current attempt still waiting for an answer. */
export async function readOpenDecisionForRun(runId: string): Promise<PublishDecisionRow | null> {
  const [row] = await db
    .select()
    .from(agentRunPublishDecisions)
    .where(
      and(
        eq(agentRunPublishDecisions.runId, requireText(runId, "runId")),
        eq(agentRunPublishDecisions.status, "parked"),
        CURRENT_ATTEMPT,
      ),
    )
    .orderBy(desc(agentRunPublishDecisions.createdAt), desc(agentRunPublishDecisions.id))
    .limit(1);
  return row ? deserialize(row) : null;
}

/** The newest decision of the run's current attempt, whatever its status: the one a resume of the run must read.
 *  `orEarlierAttempt`: when the current attempt has none, the newest decision of an earlier attempt instead (`current`
 *  false), in the same read, so a caller also learns whether the run ever met a publish gate. */
export async function readLatestDecisionForRun(runId: string, opts?: { orEarlierAttempt?: boolean }): Promise<(PublishDecisionRow & { current: boolean }) | null> {
  const d = agentRunPublishDecisions;
  const anyAttempt = opts?.orEarlierAttempt === true;
  const [row] = await db
    .select({ ...getTableColumns(d), current: CURRENT_ATTEMPT })
    .from(d)
    .where(and(eq(d.runId, requireText(runId, "runId")), anyAttempt ? undefined : CURRENT_ATTEMPT))
    .orderBy(...(anyAttempt ? [sql`(${CURRENT_ATTEMPT}) desc`] : []), desc(d.createdAt), desc(d.id))
    .limit(1);
  if (!row) return null;
  const { current, ...stored } = row;
  return { ...deserialize(stored), current: current === true };
}

/** Stops left unmade: the NEWEST decision of each run, when it is declined or expired, of the run's current attempt, and
 *  its run is still held (pending_approval, or running when a hold wrote its row but not its move). One page in id order
 *  after `afterId`. A settled decision of an earlier attempt never stops the attempt a retry started. */
export async function listSettledWithWaitingRun(limit: number, afterId?: string): Promise<PublishDecisionRow[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > PUBLISH_DECISION_MAX_DUE_PAGE) {
    throw new PublishDecisionError("invalid-input", `limit must be from 1 to ${PUBLISH_DECISION_MAX_DUE_PAGE}`);
  }
  const after = afterId === undefined ? undefined : requireText(afterId, "afterId");
  const d = agentRunPublishDecisions;
  const rows = await db
    .select({ decision: d })
    .from(d)
    .innerJoin(agentRuns, eq(agentRuns.id, d.runId))
    .where(and(inArray(d.status, ["declined", "expired"]), inArray(agentRuns.status, ["pending_approval", "running"]),
      CURRENT_ATTEMPT, NO_NEWER_DECISION, after === undefined ? undefined : gt(d.id, after)))
    .orderBy(asc(d.id))
    .limit(limit);
  return rows.map((row) => deserialize(row.decision));
}

/** Open decisions past their expiry, oldest first; one page after the row `afterId` when given. `now` is injectable for
 *  the sweep's tests. */
export async function listDueParked(limit: number, now?: Date, afterId?: string): Promise<PublishDecisionRow[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > PUBLISH_DECISION_MAX_DUE_PAGE) {
    throw new PublishDecisionError("invalid-input", `limit must be from 1 to ${PUBLISH_DECISION_MAX_DUE_PAGE}`);
  }
  const after = afterId === undefined ? undefined : requireText(afterId, "afterId");
  if (now !== undefined && !(now instanceof Date && Number.isFinite(now.getTime()))) {
    throw new PublishDecisionError("invalid-input", "now must be a valid date");
  }
  const rows = await db
    .select()
    .from(agentRunPublishDecisions)
    .where(
      and(
        eq(agentRunPublishDecisions.status, "parked"),
        lte(agentRunPublishDecisions.expiresAt, now ?? sql`now()`),
        after === undefined ? undefined : sql`(${agentRunPublishDecisions.expiresAt}, ${agentRunPublishDecisions.id}) > (select last_row.expires_at, last_row.id from ${agentRunPublishDecisions} last_row where last_row.id = ${after})`,
      ),
    )
    .orderBy(asc(agentRunPublishDecisions.expiresAt), asc(agentRunPublishDecisions.id))
    .limit(limit);
  return rows.map(deserialize);
}
