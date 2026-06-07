// Relocation worker: durable outbox-driven saga.
//
// Reads pending rows from cinatra.path_relocations, claims one at a time
// using FOR UPDATE SKIP LOCKED, performs the filesystem move OUTSIDE any DB
// transaction, then updates the row to completed/failed.
//
// Crash safety: recoverPendingMoves() runs at boot and reconciles partial
// states using a state matrix (marker file presence × old/new path existence).

import "server-only";
import { Client, Pool, type PoolClient } from "pg";
import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { getSkillsDataRootPath } from "./skills-store";

const POLL_BACKSTOP_MS = 5 * 60 * 1000; // 5 minutes — backstop in case NOTIFY is missed
const NOTIFY_CHANNEL = "cinatra_path_relocations_pending";
const MARKER_FILE_NAME = ".cinatra-moving.json";
const MAX_ATTEMPTS = 5;

let workerStarted = false;
let listenClient: Client | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let pool: Pool | null = null;

function getCinatraSchema(): string {
  return process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
}

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.SUPABASE_DB_URL;
    if (!connectionString) {
      throw new Error("[relocate-worker] SUPABASE_DB_URL is required");
    }
    pool = new Pool({ connectionString, max: 4 });
    pool.on("error", (err) => {
      console.error("[relocate-worker] pool error:", err.message);
    });
  }
  return pool;
}

// ===========================================================================
// Path-safety guard — refuses to operate on paths outside `data/skills/`,
// preventing path-escape from bad DB data.
// ===========================================================================

function rootSkillsAbs(): string {
  return path.resolve(getSkillsDataRootPath());
}

function resolveRelocationAbsPath(stored: string): string {
  // Stored paths are RELATIVE TO the skills root (e.g. "personal/example" or
  // "organization/acme/~teams/growth"). Triggers in drizzle-store.ts compose
  // them without the "data/skills/" prefix so the worker can resolve them
  // against any concrete getSkillsDataRootPath() (dev / prod / worktree).
  // The path-escape guard asserts the resolved abs stays under the root.
  const root = rootSkillsAbs();
  const abs = path.resolve(root, stored);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(
      `[path-escape guard] resolved abs="${abs}" is not under skills root="${root}" (input="${stored}")`,
    );
  }
  return abs;
}

// ===========================================================================
// Worker bootstrap
// ===========================================================================

export async function startRelocationWorker(): Promise<void> {
  if (workerStarted) return;
  workerStarted = true;

  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    console.warn("[relocate-worker] SUPABASE_DB_URL missing — worker not started");
    workerStarted = false;
    return;
  }

  // The reconnect loop keeps transient DB/network disconnects from leaving
  // only the 5-min poll backstop firing.
  async function connectListen(): Promise<void> {
    listenClient = new Client({ connectionString });
    listenClient.on("error", (err) => {
      console.error("[relocate-worker] LISTEN client error:", err.message);
    });
    listenClient.on("end", () => {
      console.warn("[relocate-worker] LISTEN client ended; scheduling reconnect in 5s");
      listenClient = null;
      if (workerStarted) {
        setTimeout(() => {
          if (workerStarted) {
            void connectListen().catch((err) => {
              console.error("[relocate-worker] reconnect failed; will retry on next end/error:", err);
            });
          }
        }, 5_000).unref?.();
      }
    });
    listenClient.on("notification", (msg) => {
      if (msg.channel === NOTIFY_CHANNEL) {
        void drainQueue().catch((err) => {
          console.error("[relocate-worker] drainQueue notify error:", err);
        });
      }
    });
    await listenClient.connect();
    await listenClient.query(`LISTEN ${NOTIFY_CHANNEL}`);
    // Drain on (re)connect to catch any NOTIFYs that fired while we were
    // disconnected.
    void drainQueue().catch((err) => {
      console.error("[relocate-worker] reconnect drain error:", err);
    });
  }

  await connectListen();

  // Backstop poll — fires every 5 min in case a NOTIFY is missed (e.g. listen
  // client reconnect window, network hiccup).
  pollTimer = setInterval(() => {
    void drainQueue().catch((err) => {
      console.error("[relocate-worker] drainQueue backstop error:", err);
    });
  }, POLL_BACKSTOP_MS);
  pollTimer.unref?.();

  // Drain once on boot
  void drainQueue().catch((err) => {
    console.error("[relocate-worker] initial drainQueue error:", err);
  });

  console.log("[relocate-worker] started (LISTEN/NOTIFY + 5min backstop)");
}

export async function stopRelocationWorker(): Promise<void> {
  workerStarted = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (listenClient) {
    try { await listenClient.query(`UNLISTEN ${NOTIFY_CHANNEL}`); } catch {}
    try { await listenClient.end(); } catch {}
    listenClient = null;
  }
  if (pool) {
    try { await pool.end(); } catch {}
    pool = null;
  }
}

// ===========================================================================
// Queue draining
// ===========================================================================

export async function drainQueue(): Promise<number> {
  let processed = 0;
  // Each loop iteration claims and processes one row. Returns false when no
  // pending rows remain.
  for (;;) {
    const did = await processOneRelocation();
    if (!did) return processed;
    processed++;
  }
}

interface PathRelocationRow {
  id: string;
  subject_kind: string;
  subject_id: string;
  old_slug: string;
  new_slug: string;
  old_path: string;
  new_path: string;
  attempts: number;
}

async function processOneRelocation(): Promise<boolean> {
  const schema = getCinatraSchema();
  const p = getPool();
  const client = await p.connect();
  let claimed: PathRelocationRow | null = null;

  try {
    await client.query("BEGIN");
    // SKIP LOCKED — concurrent workers won't double-process the same row.
    const r = await client.query<PathRelocationRow>(
      `UPDATE "${schema}"."path_relocations"
          SET status='in_progress', started_at=now(), attempts=attempts+1
        WHERE id = (
          SELECT id FROM "${schema}"."path_relocations"
           WHERE status='pending'
           ORDER BY enqueued_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
       RETURNING id, subject_kind, subject_id, old_slug, new_slug, old_path, new_path, attempts`,
    );
    claimed = r.rows[0] ?? null;
    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    client.release();
    throw err;
  }

  if (!claimed) {
    client.release();
    return false;
  }

  // FS work — no DB lock held.
  try {
    const oldAbs = resolveRelocationAbsPath(claimed.old_path);
    const newAbs = resolveRelocationAbsPath(claimed.new_path);

    if (!existsSync(oldAbs)) {
      // Nothing to move (first-ever rename before any skill installed on disk).
      await markCompleted(client, schema, claimed.id, null);
      console.log(`[relocation] ${claimed.id} (${claimed.subject_kind}): no-op, source absent`);
      return true;
    }
    if (existsSync(newAbs)) {
      await markFailed(client, schema, claimed.id, `target exists: ${newAbs}`);
      console.error(`[relocation] ${claimed.id}: target exists at ${newAbs}`);
      return true;
    }
    await mkdir(path.dirname(newAbs), { recursive: true });

    const markerPath = path.join(oldAbs, MARKER_FILE_NAME);
    await writeFile(
      markerPath,
      JSON.stringify({
        relocation_id: claimed.id,
        subject_kind: claimed.subject_kind,
        subject_id: claimed.subject_id,
        old_slug: claimed.old_slug,
        new_slug: claimed.new_slug,
        started_at: new Date().toISOString(),
      }),
      "utf-8",
    );
    await updateMarkerPath(client, schema, claimed.id, markerPath);

    try {
      await rename(oldAbs, newAbs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EXDEV") {
        // Cross-mount fallback: recursive copy → verify → delete original
        await cp(oldAbs, newAbs, { recursive: true, preserveTimestamps: true });
        const oldChildren = (await readdir(oldAbs)).sort();
        const newChildren = (await readdir(newAbs)).sort();
        if (oldChildren.length !== newChildren.length) {
          throw new Error(
            `EXDEV verify failed: old has ${oldChildren.length} children, new has ${newChildren.length}`,
          );
        }
        await rm(oldAbs, { recursive: true });
      } else {
        throw err;
      }
    }

    // Marker is now at <newAbs>/.cinatra-moving.json — remove it
    const markerAtNew = path.join(newAbs, MARKER_FILE_NAME);
    await rm(markerAtNew, { force: true });

    await markCompleted(client, schema, claimed.id, null);
    console.log(`[relocation] ${claimed.id} (${claimed.subject_kind}): completed ${claimed.old_slug} → ${claimed.new_slug}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // SQL trigger increments attempts BEFORE returning, so claimed.attempts
    // already reflects this attempt. Compare directly to MAX_ATTEMPTS.
    const exhausted = claimed.attempts >= MAX_ATTEMPTS;
    if (exhausted) {
      await markFailed(client, schema, claimed.id, msg);
      console.error(`[relocation] ${claimed.id} FAILED after ${claimed.attempts} attempts: ${msg}`);
    } else {
      // Roll back to pending so it retries on the next NOTIFY/poll.
      await client
        .query(
          `UPDATE "${schema}"."path_relocations" SET status='pending', last_error=$2, started_at=NULL WHERE id=$1`,
          [claimed.id, msg],
        )
        .catch(() => {});
      console.warn(`[relocation] ${claimed.id} retry-queued (${claimed.attempts}/${MAX_ATTEMPTS}): ${msg}`);
    }
  } finally {
    client.release();
  }
  return true;
}

async function markCompleted(client: PoolClient, schema: string, id: string, markerPath: string | null) {
  await client.query(
    `UPDATE "${schema}"."path_relocations"
        SET status='completed', completed_at=now(), last_error=NULL, marker_path=$2
      WHERE id=$1`,
    [id, markerPath],
  );
}

async function markFailed(client: PoolClient, schema: string, id: string, reason: string) {
  await client.query(
    `UPDATE "${schema}"."path_relocations"
        SET status='failed', completed_at=now(), last_error=$2
      WHERE id=$1`,
    [id, reason],
  );
}

async function updateMarkerPath(client: PoolClient, schema: string, id: string, markerPath: string) {
  await client.query(
    `UPDATE "${schema}"."path_relocations" SET marker_path=$2 WHERE id=$1`,
    [id, markerPath],
  );
}

// Re-export for tests and explicit callers
export { resolveRelocationAbsPath };
