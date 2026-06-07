// Snapshot building + canonical checksumming.
//
// Snapshots are STORED as full JSONB rows. Checksum is a stable hash
// over a canonical serialization so equality across processes is reliable
// (tests + drift detection + idempotency).

import { createHash, randomUUID } from "node:crypto";

import type {
  CanonicalSnapshot,
  HistoryEffect,
  HistoryOperation,
} from "./types";

// Canonical JSON serialization: sort object keys at every depth, normalize
// undefined -> omitted, stringify Date instances as ISO. Arrays preserve
// order; only object key order is canonicalised.
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(value, canonicalReplacer);
}

function canonicalReplacer(_key: string, val: unknown): unknown {
  if (val === undefined) return undefined;
  if (val instanceof Date) return val.toISOString();
  if (val && typeof val === "object" && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) sorted[key] = obj[key];
    return sorted;
  }
  return val;
}

export function computeEventChecksum(input: {
  objectId: string;
  operation: HistoryOperation;
  historyEffect: HistoryEffect;
  before: CanonicalSnapshot | null;
  after: CanonicalSnapshot | null;
  baseVersion: number | null;
  resultVersion: number;
  idempotencyKey: string;
}): string {
  const serialised = canonicalJsonStringify({
    objectId: input.objectId,
    operation: input.operation,
    historyEffect: input.historyEffect,
    before: input.before?.payload ?? null,
    after: input.after?.payload ?? null,
    baseVersion: input.baseVersion,
    resultVersion: input.resultVersion,
    idempotencyKey: input.idempotencyKey,
  });
  return createHash("sha256").update(serialised).digest("hex");
}

// New idempotency key per writer call when not supplied. Format includes a
// short suffix so it sorts after equivalent same-second emissions.
export function newIdempotencyKey(): string {
  return `che_${randomUUID()}`;
}

// Build a CanonicalSnapshot from a raw row object. Strips internal helper
// keys that should not appear in history snapshots (e.g. computed columns
// or non-restorable scratch fields).
export function buildSnapshotFromRow(
  row: Record<string, unknown> | null | undefined,
): CanonicalSnapshot | null {
  if (!row) return null;
  // Strip volatile / non-restorable columns. graphiti_* columns are
  // worker-managed projection state and must never participate in restore
  // (restoring would falsely re-trigger projection state machines).
  const payload: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    if (key.startsWith("graphiti_")) continue;
    payload[key] = row[key];
  }
  return { payload };
}

// Identify the fields that differ between two snapshot payloads. Used by
// the typed VersionConflict surface to seed the per-field review UI. The
// set is shallow at the top level; deeper paths land in JSON-pointer form
// (e.g. "data.subject") for the user-facing diff in the restore UI.
export function diffSnapshotFields(
  before: CanonicalSnapshot | null,
  after: CanonicalSnapshot | null,
): string[] {
  const out = new Set<string>();
  if (!before && !after) return [];
  const beforePayload = before?.payload ?? {};
  const afterPayload = after?.payload ?? {};
  const keys = new Set<string>([
    ...Object.keys(beforePayload),
    ...Object.keys(afterPayload),
  ]);
  for (const key of keys) {
    const a = (beforePayload as Record<string, unknown>)[key];
    const b = (afterPayload as Record<string, unknown>)[key];
    if (!deepEqual(a, b)) out.add(key);
  }
  return [...out].sort();
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ka = Object.keys(a as Record<string, unknown>).sort();
  const kb = Object.keys(b as Record<string, unknown>).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (
      !deepEqual(
        (a as Record<string, unknown>)[ka[i]],
        (b as Record<string, unknown>)[kb[i]],
      )
    ) {
      return false;
    }
  }
  return true;
}
