import "server-only";

// publish-decision-store (cinatra#4150): one stop in front of a declared publishing step.
// `decide` is the ONE way a row leaves `parked`: one conditional UPDATE in a transaction, so
// one of two concurrent answers wins, and a row it cannot read rolls the answer back. Every
// read error and every unreadable row THROWS: it never reads as "no open decision".

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";

import { db } from "./db";
import { agentRunPublishDecisions } from "./schema";

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

/** Refuses every value JSON would drop, change or fail on, so the stored text reads back as the same object. */
function requireJson(value: unknown, depth: number, open: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  const refuse = (why: string) => new PublishDecisionError("invalid-input", `surfacedValues ${why}`);
  if (typeof value !== "object") throw refuse("must hold only strings, finite numbers, booleans, null, arrays and plain objects");
  if (open.has(value)) throw refuse("must not contain itself");
  if (depth > PUBLISH_DECISION_MAX_SURFACED_DEPTH) throw refuse(`must nest at most ${PUBLISH_DECISION_MAX_SURFACED_DEPTH} levels`);
  const array = Array.isArray(value);
  const proto: unknown = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value).length - (array ? 1 : 0); // an array's own "length"
  if ((!array && proto !== Object.prototype && proto !== null) || "toJSON" in value || keys !== Object.keys(value).length
    || (array && keys !== (value as unknown[]).length)) {
    throw refuse("must hold only plain objects and dense arrays, with no toJSON, symbol or hidden keys");
  }
  open.add(value);
  for (const item of Object.values(value)) requireJson(item, depth + 1, open);
  open.delete(value);
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
  if (isPlainObject(input.surfacedValues)) requireJson(input.surfacedValues, 1, new Set());
  const surfaced = isPlainObject(input.surfacedValues) ? JSON.stringify(input.surfacedValues) : null;
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
      id: randomUUID(),
      orgId,
      runId,
      nodeId,
      gateTaskId,
      a2aContextId,
      status: "parked",
      surfacedValues: surfaced,
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
    .where(
      and(
        eq(agentRunPublishDecisions.runId, runId),
        eq(agentRunPublishDecisions.nodeId, nodeId),
        eq(agentRunPublishDecisions.gateTaskId, gateTaskId),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new PublishDecisionError("conflict", "the stop conflicted and has no row");
  }
  return { inserted: false, decision: deserialize(existing) };
}

export interface DecideInput {
  from: "parked";
  to: PublishDecisionOutcome;
  /** The deciding person for `released` and `declined`; null for the two outcomes no person decides. */
  actor: string | null;
  /** Only a decline carries a note. */
  note?: string | null;
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

export async function decide(id: string, input: DecideInput): Promise<DecideResult> {
  const decisionId = requireText(id, "id");
  const { actor, note } = requireTransition(input);

  return db.transaction(async (tx): Promise<DecideResult> => {
    const [won] = await tx
      .update(agentRunPublishDecisions)
      .set({ status: input.to, decidedBy: actor, decidedAt: sql`now()`, decisionNote: note })
      .where(and(eq(agentRunPublishDecisions.id, decisionId), eq(agentRunPublishDecisions.status, "parked")))
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

/** Open decisions past their expiry, oldest first. `now` is injectable for the sweep's tests. */
export async function listDueParked(limit: number, now?: Date): Promise<PublishDecisionRow[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > PUBLISH_DECISION_MAX_DUE_PAGE) {
    throw new PublishDecisionError("invalid-input", `limit must be from 1 to ${PUBLISH_DECISION_MAX_DUE_PAGE}`);
  }
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
      ),
    )
    .orderBy(asc(agentRunPublishDecisions.expiresAt), asc(agentRunPublishDecisions.id))
    .limit(limit);
  return rows.map(deserialize);
}
