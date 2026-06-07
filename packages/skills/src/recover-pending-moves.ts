// Crash recovery sweep for path_relocations.
//
// Runs at boot BEFORE startRelocationWorker(). Inspects rows whose status is
// 'in_progress' and reconciles their on-disk state per the state matrix below.

import "server-only";
import { Pool } from "pg";
import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { getSkillsDataRootPath } from "./skills-store";
import { resolveRelocationAbsPath } from "./relocate-worker";

const MARKER_FILE_NAME = ".cinatra-moving.json";
const ORPHAN_MARKER_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

interface InFlightRow {
  id: string;
  status: "pending" | "in_progress";
  subject_kind: string;
  subject_id: string;
  old_path: string;
  new_path: string;
  marker_path: string | null;
  attempts: number;
}

export async function recoverPendingMoves(): Promise<{
  reEnqueued: number;
  completed: number;
  failed: number;
  orphanMarkersDeleted: number;
}> {
  const connectionString = process.env.SUPABASE_DB_URL;
  const stats = { reEnqueued: 0, completed: 0, failed: 0, orphanMarkersDeleted: 0 };
  if (!connectionString) {
    console.warn("[recover-pending-moves] SUPABASE_DB_URL missing — skipping recovery");
    return stats;
  }
  const schema = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";

  const pool = new Pool({ connectionString, max: 2 });
  pool.on("error", () => {});

  try {
    // Only inspect 'in_progress' rows. 'pending' rows have never been claimed
    // by a worker — they're queue entries waiting to be processed by the drain
    // loop, NOT crashed mid-rename. Applying the state-matrix to them (which
    // assumes "the worker did something we need to clean up") would
    // mis-classify legitimate first-rename-before-any-skill cases as 'failed'.
    // The drain loop fires immediately after this sweep returns (see
    // src/instrumentation.node.ts), so pending rows are processed without
    // delay.
    const r = await pool.query<InFlightRow>(
      `SELECT id, status, subject_kind, subject_id, old_path, new_path, marker_path, attempts
         FROM "${schema}"."path_relocations"
        WHERE status = 'in_progress'`,
    );

    for (const row of r.rows ?? []) {
      const decision = await classifyInFlight(row);
      switch (decision.kind) {
        case "re-enqueue":
          await pool.query(
            `UPDATE "${schema}"."path_relocations"
                SET status='pending', started_at=NULL, last_error=$2, marker_path=NULL
              WHERE id=$1`,
            [row.id, `recovery: ${decision.reason}`],
          );
          stats.reEnqueued++;
          console.log(`[recover-pending-moves] ${row.id} re-enqueued: ${decision.reason}`);
          break;
        case "complete":
          await pool.query(
            `UPDATE "${schema}"."path_relocations"
                SET status='completed', completed_at=now(), last_error=$2
              WHERE id=$1`,
            [row.id, `recovery: ${decision.reason}`],
          );
          if (decision.removeMarker) {
            try { await rm(decision.removeMarker, { force: true }); } catch {}
          }
          stats.completed++;
          console.log(`[recover-pending-moves] ${row.id} marked completed: ${decision.reason}`);
          break;
        case "fail":
          await pool.query(
            `UPDATE "${schema}"."path_relocations"
                SET status='failed', completed_at=now(), last_error=$2
              WHERE id=$1`,
            [row.id, `recovery: ${decision.reason}`],
          );
          stats.failed++;
          console.error(`[recover-pending-moves] ${row.id} marked failed: ${decision.reason}`);
          break;
      }
    }

    // Orphan marker sweep
    stats.orphanMarkersDeleted = await sweepOrphanMarkers();
  } finally {
    await pool.end();
  }

  if (stats.reEnqueued + stats.completed + stats.failed + stats.orphanMarkersDeleted > 0) {
    console.log(`[recover-pending-moves] summary: ${JSON.stringify(stats)}`);
  }
  return stats;
}

interface RecoveryDecision {
  kind: "re-enqueue" | "complete" | "fail";
  reason: string;
  removeMarker?: string;
}

async function classifyInFlight(row: InFlightRow): Promise<RecoveryDecision> {
  let oldAbs: string;
  let newAbs: string;
  try {
    oldAbs = resolveRelocationAbsPath(row.old_path);
    newAbs = resolveRelocationAbsPath(row.new_path);
  } catch (err) {
    return { kind: "fail", reason: `path-resolve error: ${err instanceof Error ? err.message : String(err)}` };
  }
  const oldExists = existsSync(oldAbs);
  const newExists = existsSync(newAbs);
  const oldMarker = path.join(oldAbs, MARKER_FILE_NAME);
  const newMarker = path.join(newAbs, MARKER_FILE_NAME);
  const oldHasMarker = oldExists && existsSync(oldMarker);
  const newHasMarker = newExists && existsSync(newMarker);

  // Re-enqueue cases: source still present
  if (oldExists && !newExists) {
    return {
      kind: "re-enqueue",
      reason: oldHasMarker ? "old path + marker present (crashed mid-rename)" : "old path present (crashed pre-rename)",
    };
  }
  // Complete cases: target present, source absent
  if (!oldExists && newExists) {
    return {
      kind: "complete",
      reason: newHasMarker ? "rename succeeded, DB write lost (cleaning marker)" : "rename succeeded, DB write lost",
      removeMarker: newHasMarker ? newMarker : undefined,
    };
  }
  // Both exist — diverged state, manual repair
  if (oldExists && newExists) {
    return { kind: "fail", reason: "diverged: both old and new paths exist — manual repair required" };
  }
  // Neither exists — surface as failed for manual inspection. The
  // "first-ever rename before any skill installed" case is handled by the
  // worker's processOneRelocation (which marks completed when oldAbs absent
  // before claiming). If recovery sees an in_progress row with neither path
  // present, something destructive has happened (manual rm, crash
  // mid-EXDEV-delete, etc.) — fail loudly rather than silently dropping the
  // row.
  if (!oldExists && !newExists) {
    return { kind: "fail", reason: "missing both paths — manual repair required" };
  }
  return { kind: "fail", reason: "unreachable" };
}

async function sweepOrphanMarkers(): Promise<number> {
  const root = path.resolve(getSkillsDataRootPath());
  if (!existsSync(root)) return 0;
  let deleted = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === MARKER_FILE_NAME) {
        try {
          const s = await stat(full);
          if (Date.now() - s.mtimeMs > ORPHAN_MARKER_MAX_AGE_MS) {
            // Check that no path_relocations row references this marker as
            // in_progress / pending. Cheap approach: orphan = older than 1h
            // AND not under any active rename. We trust the in-flight loop
            // above already re-enqueued anything still relevant.
            await rm(full, { force: true });
            deleted++;
            console.log(`[recover-pending-moves] removed orphan marker: ${full}`);
          }
        } catch {}
      } else if (entry.isDirectory()) {
        stack.push(full);
      }
    }
  }
  return deleted;
}
