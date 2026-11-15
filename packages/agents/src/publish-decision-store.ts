import "server-only";

// publish-decision-store (cinatra#4150): one stop in front of a declared publishing step.
// `decide` is the ONE way a row leaves `parked`: one conditional UPDATE in a transaction, so
// one of two concurrent answers wins, and a row it cannot read rolls the answer back. Every
// read error and every unreadable row THROWS: it never reads as "no open decision".

import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { and, asc, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";

import { db } from "./db";
import { agentRunPublishDecisions, agentRuns } from "./schema";

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
  return { ...row, status: row.status, surfacedValues };
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
  ttlMs?: number;
}

export interface InsertParkedDecisionResult {
  /** False when this stop already had a row, whatever its status; `decision` is that row, unchanged. */
  inserted: boolean;
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
  const ttlMs = input.ttlMs ?? PUBLISH_DECISION_DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new PublishDecisionError("invalid-input", "ttlMs must be a positive finite number");
  }

  const [row] = await db
    .insert(agentRunPublishDecisions)
    .values({
      id: randomUUID(), orgId, runId, nodeId, gateTaskId, a2aContextId, status: "parked", surfacedValues: surfaced,
      expiresAt: sql`now() + (${ttlMs} || ' milliseconds')::interval`,
    })
    .onConflictDoNothing({
      target: [agentRunPublishDecisions.runId, agentRunPublishDecisions.nodeId, agentRunPublishDecisions.gateTaskId],
    })
    .returning();
  if (row) return { inserted: true, decision: deserialize(row) };

  const [existing] = await db
    .select()
    .from(agentRunPublishDecisions)
    .where(and(eq(agentRunPublishDecisions.runId, runId), eq(agentRunPublishDecisions.nodeId, nodeId),
      eq(agentRunPublishDecisions.gateTaskId, gateTaskId)))
    .limit(1);
  if (!existing) throw new PublishDecisionError("conflict", "the stop conflicted and has no row");
  return { inserted: false, decision: deserialize(existing) };
}

export interface DecideInput {
  from: "parked";
  to: PublishDecisionOutcome;
  /** The deciding person for `released` and `declined`; null for the two outcomes no person decides. */
  actor: string | null;
  /** Only a decline carries a note. */
  note?: string | null;
  /** Wins only while no newer decision of the same run exists, checked in the same UPDATE (the expiry's rule). */
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
        input.newestOnly ? NO_NEWER_DECISION : undefined))
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

/** The newest decision of this step of this run, whatever its status. */
export async function readDecisionForRunNode(runId: string, nodeId: string): Promise<PublishDecisionRow | null> {
  const [row] = await db
    .select()
    .from(agentRunPublishDecisions)
    .where(
      and(
        eq(agentRunPublishDecisions.runId, requireText(runId, "runId")),
        eq(agentRunPublishDecisions.nodeId, requireText(nodeId, "nodeId")),
      ),
    )
    .orderBy(desc(agentRunPublishDecisions.createdAt), desc(agentRunPublishDecisions.id))
    .limit(1);
  return row ? deserialize(row) : null;
}

/** The newest decision of this run still waiting for an answer. */
export async function readOpenDecisionForRun(runId: string): Promise<PublishDecisionRow | null> {
  const [row] = await db
    .select()
    .from(agentRunPublishDecisions)
    .where(
      and(
        eq(agentRunPublishDecisions.runId, requireText(runId, "runId")),
        eq(agentRunPublishDecisions.status, "parked"),
      ),
    )
    .orderBy(desc(agentRunPublishDecisions.createdAt), desc(agentRunPublishDecisions.id))
    .limit(1);
  return row ? deserialize(row) : null;
}

/** The newest decision of this run, whatever its status: the one a resume of the run must read. */
export async function readLatestDecisionForRun(runId: string): Promise<PublishDecisionRow | null> {
  const [row] = await db
    .select()
    .from(agentRunPublishDecisions)
    .where(eq(agentRunPublishDecisions.runId, requireText(runId, "runId")))
    .orderBy(desc(agentRunPublishDecisions.createdAt), desc(agentRunPublishDecisions.id))
    .limit(1);
  return row ? deserialize(row) : null;
}

/** Stops left unmade: the NEWEST decision of each run, when it is declined or expired and its run is still held
 *  (pending_approval, or running when a hold wrote its row but not its move). One page in id order after `afterId`. */
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
      NO_NEWER_DECISION, after === undefined ? undefined : gt(d.id, after)))
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
