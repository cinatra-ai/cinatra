// ---------------------------------------------------------------------------
// Pure logic + a best-effort file lock for the per-branch clone-on-demand
// system. A "clone" is a full deep-fork dev environment (separate Postgres
// database `cinatra_clone_<slug>`, dedicated ports). Clones are created
// DORMANT and started on demand by later slices — so they reserve a port
// band while NOTHING is listening. `findFreePort()` (which only sees live
// sockets) cannot allocate clone ports; this registry is the source of
// truth instead.
//
// Registry file: ~/.cinatra/clones.json
//   { "version": 1, "clones": { "<slug>": { index, nextjsPort, wayflowPort,
//     dbName, worktreePath, state, createdAt } } }
//
// Public surface (also re-exported as `__test` for hermetic vitest):
//   - constants: CLONE_NEXTJS_PORT_BASE, CLONE_WAYFLOW_PORT_BASE,
//     CLONE_MAX_INDEX, SEED_DB_NAME
//   - slug/name/port: cloneSlugFromBranch, cloneDbName, portsForIndex,
//     isProtectedDbName, isValidSlug
//   - registry I/O: defaultRegistryPath, readRegistry, requireUsableRegistry,
//     writeRegistry
//   - lock: withRegistryLock
//   - slot ops (pure): allocateSlot, markSlotReady, releaseSlot, getClone,
//     listClones
//
// Registry safety invariants:
//   - readRegistry distinguishes missing/ok/malformed; mutating callers
//        go through requireUsableRegistry which REFUSES malformed (the bad
//        file is left in place for manual repair, never auto-reset).
//   - withRegistryLock serialises read→allocate→write so two concurrent
//        `setup clone` runs cannot both grab index 0.
//   - allocateSlot throws if a slug already maps to a DIFFERENT worktree
//        (idempotent only when the worktreePath matches).
// ---------------------------------------------------------------------------

import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  linkSync,
  statSync,
  fstatSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// --- constants -------------------------------------------------------------

export const CLONE_NEXTJS_PORT_BASE = 3100;
export const CLONE_WAYFLOW_PORT_BASE = 3200;
export const CLONE_MAX_INDEX = 19; // indices 0..19 → 20 clone slots
export const SEED_DB_NAME = "cinatra_seed";

const REGISTRY_VERSION = 1;
const LOCK_STALE_MS = 60_000; // steal a lock whose file mtime is older than this
const LOCK_RETRY_MS = 100;
const LOCK_TIMEOUT_MS = 10_000;

// --- slug / name / port ----------------------------------------------------

/**
 * Derive a clone slug from a git branch name. Mirrors `sanitizeBranchSlug` in
 * index.mjs but ALSO strips a leading `worktree-` segment so worktree branches
 * collapse to their clone-specific slug.
 * Returns "" when nothing usable remains.
 */
export function cloneSlugFromBranch(branch) {
  let candidate = String(branch ?? "").trim();
  if (!candidate) return "";
  if (candidate.startsWith("cinatra-ai-")) {
    candidate = candidate.slice("cinatra-ai-".length);
  } else if (candidate.startsWith("worktree-")) {
    candidate = candidate.slice("worktree-".length);
  }
  return candidate
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

/** A slug is valid iff it matches the same shape `cinatra setup branch` enforces. */
export function isValidSlug(slug) {
  return typeof slug === "string" && /^[a-z0-9][a-z0-9-]{0,29}$/.test(slug);
}

/** Postgres database name for a clone. Dashes → underscores (pg identifier rules). */
export function cloneDbName(slug) {
  if (!isValidSlug(slug)) {
    throw new Error(`Invalid clone slug "${slug}". Must match /^[a-z0-9][a-z0-9-]{0,29}$/.`);
  }
  return `cinatra_clone_${slug.replace(/-/g, "_")}`;
}

// A clone database name is EXACTLY `cinatra_clone_` + a slug transformed by
// `cloneDbName` (dashes → underscores). `isValidSlug` constrains slugs to
// /^[a-z0-9][a-z0-9-]{0,29}$/, so the transformed suffix is
// /^[a-z0-9][a-z0-9_]{0,29}$/. The destructive-prune guard must match this
// EXACT shape — `^cinatra_clone_[a-z0-9_]+$` was too loose (it accepted
// `cinatra_clone__`, `cinatra_clone__prod`, an over-long suffix, etc.), and
// this is the last line of defense before `DROP DATABASE`.
const CLONE_DB_NAME_RE = /^cinatra_clone_[a-z0-9][a-z0-9_]{0,29}$/;

/**
 * Hard guard for the destructive `clone prune` path. Returns true for any
 * database name that must NEVER be dropped: the maintenance/app DBs, the
 * seed template, the pg system templates, and — critically — ANY name that
 * is not shaped EXACTLY like a `cloneDbName(slug)` output. So a typo, a
 * corrupted registry entry, or a resolution bug fails closed.
 */
export function isProtectedDbName(name) {
  if (typeof name !== "string" || name.length === 0) return true;
  const reserved = new Set([
    "postgres",
    "cinatra",
    SEED_DB_NAME,
    "template0",
    "template1",
  ]);
  if (reserved.has(name)) return true;
  // Anything not shaped EXACTLY like a clone DB is protected (fail closed).
  return !CLONE_DB_NAME_RE.test(name);
}

/** { nextjsPort, wayflowPort } for a clone index. Throws outside 0..CLONE_MAX_INDEX. */
export function portsForIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index > CLONE_MAX_INDEX) {
    throw new Error(`Clone index ${index} out of range (0..${CLONE_MAX_INDEX}).`);
  }
  return {
    nextjsPort: CLONE_NEXTJS_PORT_BASE + index,
    wayflowPort: CLONE_WAYFLOW_PORT_BASE + index,
  };
}

// --- registry file I/O -----------------------------------------------------

export function defaultRegistryPath() {
  return path.join(os.homedir(), ".cinatra", "clones.json");
}

function emptyRegistry() {
  return { version: REGISTRY_VERSION, clones: {} };
}

const CLONE_STATES = new Set(["provisioning", "ready"]);

// Structural validation of one clone slot. A registry entry that does not
// match this shape is treated as registry corruption — `readRegistry`
// classifies the whole file `malformed` so `requireUsableRegistry` refuses to
// mutate. A shallow `clones`-is-an-object check can let malformed slot values
// through, after which `allocateSlot` builds `usedIndexes` from raw values and
// risks duplicate port allocation or runtime crashes.
function isValidCloneSlot(slug, slot) {
  if (!isValidSlug(slug)) return false;
  if (!slot || typeof slot !== "object" || Array.isArray(slot)) return false;
  const { index, nextjsPort, wayflowPort, dbName, worktreePath, state, createdAt } = slot;
  if (!Number.isInteger(index) || index < 0 || index > CLONE_MAX_INDEX) return false;
  if (nextjsPort !== CLONE_NEXTJS_PORT_BASE + index) return false;
  if (wayflowPort !== CLONE_WAYFLOW_PORT_BASE + index) return false;
  if (dbName !== cloneDbName(slug)) return false;
  if (typeof worktreePath !== "string" || worktreePath.length === 0) return false;
  if (!CLONE_STATES.has(state)) return false;
  if (typeof createdAt !== "string" || createdAt.length === 0) return false;
  return true;
}

// Validate every clone entry AND cross-entry index uniqueness.
function areRegistryEntriesValid(clones) {
  const seenIndexes = new Set();
  for (const [slug, slot] of Object.entries(clones)) {
    if (!isValidCloneSlot(slug, slot)) return false;
    if (seenIndexes.has(slot.index)) return false; // two slugs claiming one index
    seenIndexes.add(slot.index);
  }
  return true;
}

/**
 * Read the registry file. NEVER throws.
 * Returns { status, registry, raw }:
 *   - status "missing"   → file absent; registry = fresh empty registry
 *   - status "ok"        → parsed; registry = the parsed object
 *   - status "malformed" → unreadable/invalid JSON/wrong shape; registry = null,
 *                          raw = the bytes on disk (so callers can preserve them)
 */
export function readRegistry(filePath) {
  if (!existsSync(filePath)) {
    return { status: "missing", registry: emptyRegistry(), raw: null };
  }
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    return { status: "malformed", registry: null, raw: null, error: err };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { status: "malformed", registry: null, raw, error: err };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.clones !== "object" ||
    parsed.clones === null ||
    Array.isArray(parsed.clones)
  ) {
    return { status: "malformed", registry: null, raw };
  }
  // Deep-validate every clone entry — a syntactically-valid JSON file can
  // still carry structurally-invalid slots (string index, missing fields,
  // mismatched dbName, duplicate indexes). Those must be classified malformed,
  // not silently reused.
  if (!areRegistryEntriesValid(parsed.clones)) {
    return { status: "malformed", registry: null, raw };
  }
  if (typeof parsed.version !== "number") {
    parsed.version = REGISTRY_VERSION;
  }
  return { status: "ok", registry: parsed, raw };
}

/**
 * Read the registry for a MUTATING command. Throws on a malformed registry
 * because silently resetting it can hand out a port band that an existing
 * dormant clone already owns). The bad file is left untouched on disk.
 */
export function requireUsableRegistry(filePath) {
  const result = readRegistry(filePath);
  if (result.status === "malformed") {
    throw new Error(
      `Clone registry at ${filePath} is malformed and was NOT modified. ` +
        `Inspect/repair it by hand (or delete it only if you are sure no dormant ` +
        `clones exist), then retry.`,
    );
  }
  return result.registry;
}

/** Atomic write: temp file in the same dir + rename. Creates ~/.cinatra/ if absent. */
export function writeRegistry(filePath, data) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({ ...data, version: data.version ?? REGISTRY_VERSION }, null, 2) + "\n";
  const tmp = path.join(dir, `.clones.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, payload, { mode: 0o600 });
  renameSync(tmp, filePath);
}

// --- file lock -------------------------------------------------------------

/**
 * Is the process recorded in a registry-lock file still alive? The lock body
 * is written as `"<pid> <iso>\n"`. A LIVE holder must never be judged stale
 * (it may legitimately be mid-long-operation), so staleness requires BOTH an
 * old mtime AND a dead holder pid. Unreadable / unparsable → treat as "not
 * provably alive" so a corrupt lock can still be reclaimed via the mtime
 * gate.
 */
function lockHolderAlive(lockPath) {
  let pid = null;
  try {
    const first = readFileSync(lockPath, "utf8").trim().split(/\s+/)[0];
    pid = Number.parseInt(first, 10);
  } catch {
    return false;
  }
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM → the process exists but is owned by another user: still alive.
    return err && err.code === "EPERM";
  }
}

/**
 * Run `fn` while holding an exclusive lock on `<filePath>.lock`.
 *
 * temp+rename prevents torn writes but not lost updates — two
 * `setup clone` processes can both read, both allocate index 0, last rename
 * wins. Every read→allocate→write sequence runs inside this lock.
 *
 * Best-effort, single-host: `openSync(..., "wx")` is the mutex; a lock whose
 * file mtime is older than LOCK_STALE_MS is considered abandoned and stolen.
 * `fn` may be async; the lock is always released in `finally`.
 */
export async function withRegistryLock(filePath, fn) {
  const lockPath = `${filePath}.lock`;
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd = null;

  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      if (err && err.code === "EEXIST") {
        // Lock held — check for staleness, else wait and retry. Stale
        // requires BOTH an old mtime AND a dead holder pid: a live holder
        // running a long operation must never have its lock stolen.
        let stale = false;
        let staleIno = null;
        try {
          const st = statSync(lockPath);
          staleIno = st.ino;
          const mtimeOld = Date.now() - st.mtimeMs > LOCK_STALE_MS;
          stale = mtimeOld && !lockHolderAlive(lockPath);
        } catch {
          // Lock vanished between openSync and statSync — retry immediately.
        }
        if (stale) {
          // Inode-stable steal gate: only steal if the file at lockPath is
          // STILL the exact inode we judged stale. A fresh holder that
          // acquired between the stat above and now is a NEW file (new
          // inode) — we must NOT rename its lock away. This closes the
          // "rob a live fresh holder" race: a changed (or vanished) inode
          // means back off and let the loop re-contend.
          try {
            if (statSync(lockPath).ino !== staleIno) {
              continue;
            }
          } catch {
            continue;
          }
          // TOCTOU-safe steal: an unconditional `unlinkSync(lockPath)` here
          // can delete a *fresh* lock if the stale holder exited and a new
          // holder acquired between the stat above and the unlink — two
          // processes would then enter the critical section. Instead,
          // atomically rename the exact file we judged stale out of the
          // way; `renameSync` moves a single inode and fails (ENOENT) if
          // it's already gone/rotated. Re-verify staleness on the moved
          // file; if it turned out fresh (we raced a new holder), restore
          // it when the slot is free, then retry the normal acquire.
          const stealPath = `${lockPath}.steal.${process.pid}.${Date.now()}`;
          try {
            renameSync(lockPath, stealPath);
          } catch {
            // Already removed/rotated by someone else — just retry.
            continue;
          }
          // Re-verify on the MOVED file: stale needs old mtime AND a dead
          // holder. If we raced a brand-new holder (it wrote a fresh lock
          // with a live pid between our gate and the rename), the moved file
          // is NOT stale and must be restored.
          let stolenStillStale = true;
          try {
            const stolenMtimeOld =
              Date.now() - statSync(stealPath).mtimeMs > LOCK_STALE_MS;
            stolenStillStale = stolenMtimeOld && !lockHolderAlive(stealPath);
          } catch {
            /* moved file vanished — treat as stale/handled */
          }
          if (stolenStillStale) {
            try {
              unlinkSync(stealPath);
            } catch {
              /* already gone — fine */
            }
          } else {
            // We grabbed a still-fresh lock. Restore it ONLY if no newer
            // holder has taken the slot — `linkSync` is atomic and fails
            // EEXIST if `lockPath` now exists (no-clobber; `renameSync`
            // would silently overwrite a newer holder's lock). Either way
            // drop our temp copy.
            try {
              linkSync(stealPath, lockPath);
            } catch {
              /* lockPath taken by a newer holder — discard our copy */
            }
            try {
              unlinkSync(stealPath);
            } catch {
              /* best-effort */
            }
          }
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out after ${LOCK_TIMEOUT_MS}ms waiting for the clone registry lock ` +
              `(${lockPath}). If no other 'cinatra clone' command is running, delete the ` +
              `lock file and retry.`,
          );
        }
        await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
        continue;
      }
      throw err;
    }
  }

  // Capture the inode of the lock file WE created. If another process later
  // judges our lock stale and steals it (unlink + recreate), the path points
  // at a different inode — and we must NOT unlink that new holder's lock on
  // our way out. An unconditional unlink in `finally` lets a resumed stale
  // holder delete the active holder's lock.
  let ourInode = null;
  try {
    ourInode = fstatSync(fd).ino;
  } catch {
    /* fstat failed — fall back to best-effort unlink in finally */
  }
  try {
    writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
  } catch {
    /* diagnostics only — never fail the lock over this */
  }
  try {
    return await fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      // Only remove the lock if it is still OURS — same inode we created.
      // ourInode === null (fstat failed) falls back to an unconditional
      // unlink, preserving the prior best-effort behavior.
      if (ourInode === null || statSync(lockPath).ino === ourInode) {
        unlinkSync(lockPath);
      }
    } catch {
      /* lock already removed (e.g. stolen as stale) — nothing to do */
    }
  }
}

// --- slot operations (pure) ------------------------------------------------

function cloneRegistry(registry) {
  return {
    version: registry.version ?? REGISTRY_VERSION,
    clones: { ...registry.clones },
  };
}

/**
 * Allocate (or return the existing) registry slot for `slug`.
 *
 * Pure — returns { registry, slot } with a NEW registry object; the caller
 * persists it via writeRegistry inside withRegistryLock.
 *
 * - slug present AND same worktreePath → returns the existing slot unchanged
 *   (idempotent re-run, regardless of `state`).
 * - slug present AND different worktreePath → THROWS; never alias
 *   two worktrees onto one clone DB).
 * - slug absent → lowest free index 0..CLONE_MAX_INDEX, state "provisioning"
 *   (the caller flips it to "ready" only after the DB + .env.local
 *   succeed; a leftover "provisioning" entry is a resumable/cleanable ghost,
 *   not a silent success).
 */
export function allocateSlot(registry, slug, { worktreePath }) {
  if (!isValidSlug(slug)) {
    throw new Error(`Invalid clone slug "${slug}". Must match /^[a-z0-9][a-z0-9-]{0,29}$/.`);
  }
  if (typeof worktreePath !== "string" || worktreePath.length === 0) {
    throw new Error("allocateSlot requires a non-empty worktreePath.");
  }

  const existing = registry.clones[slug];
  if (existing) {
    if (existing.worktreePath !== worktreePath) {
      throw new Error(
        `Clone slug "${slug}" already maps to worktree ${existing.worktreePath} — ` +
          `refusing to alias it onto ${worktreePath}. Use a distinct --slug, or ` +
          `prune the existing clone first.`,
      );
    }
    return { registry: cloneRegistry(registry), slot: existing };
  }

  const usedIndexes = new Set(
    Object.values(registry.clones).map((c) => c.index),
  );
  let index = -1;
  for (let i = 0; i <= CLONE_MAX_INDEX; i += 1) {
    if (!usedIndexes.has(i)) {
      index = i;
      break;
    }
  }
  if (index === -1) {
    throw new Error(
      `All ${CLONE_MAX_INDEX + 1} clone slots are in use. Run 'cinatra clone prune' on a ` +
        `clone you no longer need.`,
    );
  }

  const { nextjsPort, wayflowPort } = portsForIndex(index);
  const slot = {
    index,
    nextjsPort,
    wayflowPort,
    dbName: cloneDbName(slug),
    worktreePath,
    state: "provisioning",
    createdAt: new Date().toISOString(),
  };
  const next = cloneRegistry(registry);
  next.clones[slug] = slot;
  return { registry: next, slot };
}

/** Flip a slot to state "ready" after provisioning succeeds. Returns a new registry. */
export function markSlotReady(registry, slug) {
  const existing = registry.clones[slug];
  if (!existing) {
    throw new Error(`Cannot mark unknown clone slug "${slug}" ready.`);
  }
  const next = cloneRegistry(registry);
  next.clones[slug] = { ...existing, state: "ready" };
  return next;
}

/** Remove a slot. Returns { registry, removed } — `removed` is the dropped slot or null. */
export function releaseSlot(registry, slug) {
  const removed = registry.clones[slug] ?? null;
  const next = cloneRegistry(registry);
  delete next.clones[slug];
  return { registry: next, removed };
}

export function getClone(registry, slug) {
  return registry.clones[slug] ?? null;
}

export function listClones(registry) {
  return Object.entries(registry.clones)
    .map(([slug, slot]) => ({ slug, ...slot }))
    .sort((a, b) => a.index - b.index);
}

// Worktree-path lookup helpers for the EnterWorktree / ExitWorktree hooks.
// The realpath fallback to `path.resolve` is critical so a worktree directory
// removed before the ExitWorktree hook fires can still be matched against the
// stored slot.

/**
 * Canonicalise an absolute worktree path. Returns the realpath when the
 * path exists on disk; otherwise returns `path.resolve(p)` so callers
 * can still string-compare against a stored absolute path (the typical
 * stale-clone / ExitWorktree-after-removal scenario).
 */
export function canonicalizeWorktreePath(p) {
  if (typeof p !== "string" || p.length === 0) return null;
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Find the registry slot whose stored worktreePath matches the input.
 * Matches on either realpath (when both resolve) OR the absolute-normalised
 * string (covers the case where the worktree dir has been removed).
 *
 * @returns {{ slug: string, slot: object } | null}
 */
export function findCloneByWorktreePath(registry, worktreePath) {
  if (!registry || typeof worktreePath !== "string") return null;
  const inputReal = canonicalizeWorktreePath(worktreePath);
  const inputResolved = path.resolve(worktreePath);
  for (const [slug, slot] of Object.entries(registry.clones)) {
    if (typeof slot?.worktreePath !== "string") continue;
    const slotReal = canonicalizeWorktreePath(slot.worktreePath);
    const slotResolved = path.resolve(slot.worktreePath);
    if (inputReal === slotReal || inputResolved === slotResolved) {
      return { slug, slot };
    }
  }
  return null;
}

/**
 * A slot is stale iff its worktreePath does NOT resolve to an existing
 * directory. There is NO `$HOME` / repo-root exclusion — Cinatra worktrees
 * live under `$HOME`, so excluding `$HOME` makes the rule useless.
 * The existence-of-directory check is the canonical liveness signal.
 */
export function isWorktreePathStale(slot) {
  if (typeof slot?.worktreePath !== "string") return true;
  try {
    return !statSync(slot.worktreePath).isDirectory();
  } catch {
    return true;
  }
}

// --- test surface ----------------------------------------------------------

export const __test = {
  CLONE_NEXTJS_PORT_BASE,
  CLONE_WAYFLOW_PORT_BASE,
  CLONE_MAX_INDEX,
  SEED_DB_NAME,
  cloneSlugFromBranch,
  isValidSlug,
  cloneDbName,
  isProtectedDbName,
  portsForIndex,
  defaultRegistryPath,
  readRegistry,
  requireUsableRegistry,
  writeRegistry,
  withRegistryLock,
  allocateSlot,
  markSlotReady,
  releaseSlot,
  getClone,
  listClones,
};
