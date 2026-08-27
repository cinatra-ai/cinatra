/**
 * The local sync ledger: what the last successful sync run pushed.
 *
 * The ledger is BOOKKEEPING, never the authority. It never suppresses a write:
 * the remote preflight decides whether a row is current, because only the
 * preflight knows the present. What the ledger adds is memory of the PAST —
 * it is the only place that remembers a concept was ONCE synced, which is how
 * a run can report an orphan (a ledger entry whose file is gone) without ever
 * asking the server to delete anything, and how a run can say out loud that a
 * row drifted since the last sync (`ledger-stale`).
 *
 * A missing, stale or corrupt ledger therefore costs nothing but those two
 * reports: classification is unchanged. So the ledger can be deleted,
 * gitignored, or never committed, and sync still classifies correctly.
 *
 * The file lives at the bundle ROOT and is not a `.md` file, so the bundle
 * walk never reads it as a concept and it can never become memory content.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";

import { atomicWriteMemoryFile } from "./fs-safe.ts";
import type { MemorySyncLedger } from "./types.ts";

/** Filename of the per-bundle ledger, at the bundle root. */
export const MEMORY_SYNC_LEDGER_FILENAME = "sync-ledger.json";

/** An empty ledger for `bundleId`. */
export function emptyMemorySyncLedger(bundleId: string): MemorySyncLedger {
  return { ledgerFormat: 1, bundleId, entries: {} };
}

/**
 * Load the ledger at `root`.
 *
 * Every failure mode — absent, unreadable, unparseable, wrong format version,
 * or recorded against a DIFFERENT `bundleId` — returns an empty ledger. A
 * ledger that does not describe this bundle must not be believed; falling back
 * to "know nothing" costs a preflight comparison and cannot mis-skip a write.
 */
export function loadMemorySyncLedger(
  root: string,
  bundleId: string,
): MemorySyncLedger {
  let source: string;
  try {
    source = readFileSync(path.join(root, MEMORY_SYNC_LEDGER_FILENAME), "utf8");
  } catch {
    return emptyMemorySyncLedger(bundleId);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(source);
  } catch {
    return emptyMemorySyncLedger(bundleId);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return emptyMemorySyncLedger(bundleId);
  }
  const d = doc as Record<string, unknown>;
  if (d["ledgerFormat"] !== 1 || d["bundleId"] !== bundleId) {
    return emptyMemorySyncLedger(bundleId);
  }
  const rawEntries = d["entries"];
  if (rawEntries === null || typeof rawEntries !== "object" || Array.isArray(rawEntries)) {
    return emptyMemorySyncLedger(bundleId);
  }
  const entries: MemorySyncLedger["entries"] = {};
  for (const [key, value] of Object.entries(rawEntries as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry["sha256"] !== "string" || typeof entry["objectId"] !== "string") {
      continue;
    }
    entries[key] = { sha256: entry["sha256"], objectId: entry["objectId"] };
  }
  return { ledgerFormat: 1, bundleId, entries };
}

/** Serialize a ledger to canonical JSON (sorted keys, trailing newline). */
export function serializeMemorySyncLedger(ledger: MemorySyncLedger): string {
  const entries: MemorySyncLedger["entries"] = {};
  for (const key of Object.keys(ledger.entries).sort()) {
    const entry = ledger.entries[key];
    if (entry) entries[key] = { sha256: entry.sha256, objectId: entry.objectId };
  }
  return `${JSON.stringify(
    { ledgerFormat: ledger.ledgerFormat, bundleId: ledger.bundleId, entries },
    null,
    2,
  )}\n`;
}

/**
 * Write the ledger back to the bundle root through the containment-checked
 * atomic writer — the same one every other write in this package uses, so a
 * symlinked bundle root cannot redirect it outside the bundle.
 */
export function writeMemorySyncLedger(
  root: string,
  ledger: MemorySyncLedger,
): void {
  atomicWriteMemoryFile(
    path.join(root, MEMORY_SYNC_LEDGER_FILENAME),
    serializeMemorySyncLedger(ledger),
    root,
  );
}
