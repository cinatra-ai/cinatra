// Cross-file advisory lock that serializes the handful of test critical
// sections which read or MUTATE the shared on-disk `extensions/` tree.
//
// Why this exists (cinatra#418 fallout): the wholesale `pnpm test:root` run
// executes ~400 test files in one process with vitest's parallel `threads`
// pool. Two of those files touch the SAME real `extensions/` tree:
//
//   - scripts/extensions/__tests__/inventory.test.mjs calls `buildInventory()`,
//     which scans every extension's source files and asserts the empirical
//     host-internal import surface is EMPTY (`distinctHostInternalImports`).
//   - scripts/audit/__tests__/extension-import-ban.test.mjs WRITES a scratch
//     fixture file (`__pinned-empty-flip-fixture__.ts` with a `@/lib/...`
//     import) INTO `extensions/cinatra-ai/gmail-connector/src/`, runs the gate
//     subprocess, then removes it — to prove the import-ban gate detects a real
//     `@/` host edge.
//
// When the inventory scan runs DURING the window the scratch fixture exists, it
// observes the leaked import and the empty-surface assertion fails. Adding two
// new root test files shifted vitest's file scheduling enough to make that
// collision deterministic. This is a pre-existing test-isolation defect, not a
// scanner bug — the fix is to serialize the critical sections around the shared
// tree, NOT to weaken either gate's assertion or to disable file parallelism
// for the whole 400-file suite.
//
// DESIGN — deliberately minimal for provable safety. The lock is a
// dependency-free, cross-process advisory mutex built on the atomicity of
// `mkdirSync` (an exclusive create that throws EEXIST if the directory already
// exists). It is held across an in-process `buildInventory()` AND across a
// spawned `node scripts/audit/extension-import-ban.mjs` gate subprocess, so a
// filesystem lock (not a vitest worker construct) is required.
//
// There is NO stale-reclaim / break protocol on purpose. Reclaim logic is the
// only thing that can ever delete a lock the deleting process does not own, and
// every reclaim scheme over `mkdir` has subtle multi-step races. Here ONLY the
// acquiring process removes its own lock (in `release()`), so a live lock can
// never be deleted by anyone else — SAFETY is unconditional.
//
// The cost is liveness under a HARD crash: if a vitest worker is SIGKILLed
// while holding the lock, the dir is never removed and the next waiter blocks
// until ACQUIRE_TIMEOUT_MS, then throws. That is acceptable: a SIGKILLed worker
// has ALREADY failed the test run, so a bounded, loud lock timeout is a
// strictly louder symptom of an already-failed run, not a new failure mode. In
// normal operation `release()` always runs (try/finally) and there is no wedge.

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Repo-scoped lock name so concurrent checkouts (e.g. multiple CI runners on
// the same host, or local worktrees) don't cross-contend on a shared global.
const REPO_ROOT = join(__dirname, "..", "..", "..");
const REPO_TAG = REPO_ROOT.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const LOCK_DIR = join(tmpdir(), `cinatra-extension-inventory-${REPO_TAG}.lock`);

// Generous ceiling: a single `buildInventory()` scan of ~80 extensions plus a
// gate subprocess is ~1-2s, and the lock serializes only a handful of such
// sections, so contention waits are short. The bound exists purely so a
// SIGKILLed holder surfaces as a loud, finite failure rather than a hang.
const ACQUIRE_TIMEOUT_MS = 120_000;
const POLL_MS = 25;

// Synchronous sleep without a busy-spin: a short blocking wait via Atomics on a
// throwaway shared buffer. Keeps the lock usable from synchronous test bodies
// (the import-ban gate tests are sync and spawn a subprocess). Blocking this
// thread is correct: a contending vitest worker has nothing else to do but wait
// for the shared tree.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquire() {
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR); // atomic exclusive create — the whole mutex
      return;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      if (Date.now() > deadline) {
        throw new Error(
          `[extension-inventory-lock] timed out after ${ACQUIRE_TIMEOUT_MS}ms ` +
            `acquiring ${LOCK_DIR}. A test worker holding it was likely killed ` +
            `mid-run; this lock has no stale-break by design (see header).`,
        );
      }
      sleepSync(POLL_MS);
    }
  }
}

// ONLY the owning process releases, and only its own held lock — so no live
// lock is ever removed by another process.
function release() {
  rmSync(LOCK_DIR, { recursive: true, force: true });
}

/** Run a synchronous fn while holding the shared extensions-tree lock. */
export function withExtensionInventoryLockSync(fn) {
  acquire();
  try {
    return fn();
  } finally {
    release();
  }
}

/** Run an async fn while holding the shared extensions-tree lock. */
export async function withExtensionInventoryLock(fn) {
  acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
