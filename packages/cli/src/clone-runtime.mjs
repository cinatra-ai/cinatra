// ---------------------------------------------------------------------------
// Clone runtime helpers (host-native Next.js + per-clone WayFlow).
//
// Pure helpers wrapping the per-slug runtime-state directory at
// `~/.cinatra/clones/<slug>/` (pid file, log file, generated compose.yml,
// runtime lock file, Tailscale state directory). Also: process-liveness
// checks, compose-project name derivation, log truncation, port-band guard,
// Tailscale-authkey validation + redaction.
//
// Plain ESM `.mjs`, importable from the CLI without compilation.
// Hermetically testable — no side effects beyond fs/process when callers
// invoke the imperative helpers.
//
// Public surface (also re-exported as `__test` for hermetic vitest):
//   - paths: cloneRuntimeDir, clonePidPath, cloneLogPath, cloneLockPath,
//     cloneComposePath, cloneTailscaleStateDir, cloneTailscaleServePath
//   - naming: cloneComposeProjectName, cloneTailscaleHostname
//   - process: isPidAlive, processCommandLineMatches
//   - lock: acquireRuntimeLock, releaseRuntimeLock, isRuntimeLockHeld
//   - guard: assertPortBandOk, CLONE_NEXTJS_PORT_LIMIT, CLONE_WAYFLOW_PORT_LIMIT
//   - secret: validateTailscaleAuthkey, redactTailscaleAuthkey,
//     scrubTailscaleAuthkey
// ---------------------------------------------------------------------------

import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  linkSync,
  statSync,
  truncateSync,
  readlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  CLONE_NEXTJS_PORT_BASE,
  CLONE_WAYFLOW_PORT_BASE,
  CLONE_MAX_INDEX,
  isValidSlug,
  canonicalizeWorktreePath,
} from "./clone-registry.mjs";

// --- constants -------------------------------------------------------------

// Inclusive upper bounds for the port-band ownership check. Slot indices are
// 0..CLONE_MAX_INDEX, so port = base + index falls in [base, base+max].
export const CLONE_NEXTJS_PORT_LIMIT = CLONE_NEXTJS_PORT_BASE + CLONE_MAX_INDEX;
export const CLONE_WAYFLOW_PORT_LIMIT = CLONE_WAYFLOW_PORT_BASE + CLONE_MAX_INDEX;

// --- runtime dir / paths --------------------------------------------------

/**
 * Per-clone runtime state directory. Defaults to `~/.cinatra/clones/<slug>`
 * but is overridable via `{ home }` for hermetic tests.
 */
export function cloneRuntimeDir(slug, { home } = {}) {
  if (!isValidSlug(slug)) {
    throw new Error(`Invalid clone slug "${slug}".`);
  }
  const root = home ?? os.homedir();
  return path.join(root, ".cinatra", "clones", slug);
}

export function clonePidPath(slug, opts) {
  return path.join(cloneRuntimeDir(slug, opts), "nextjs.pid");
}

export function cloneLogPath(slug, opts) {
  return path.join(cloneRuntimeDir(slug, opts), "nextjs.log");
}

export function cloneLockPath(slug, opts) {
  return path.join(cloneRuntimeDir(slug, opts), "clone.lock");
}

export function cloneComposePath(slug, opts) {
  return path.join(cloneRuntimeDir(slug, opts), "compose.yml");
}

export function cloneTailscaleStateDir(slug, opts) {
  return path.join(cloneRuntimeDir(slug, opts), "tailscale-state");
}

export function cloneTailscaleServePath(slug, opts) {
  return path.join(cloneRuntimeDir(slug, opts), "tailscale-serve.json");
}

/** Ensure the runtime dir exists (idempotent, 0700). */
export function ensureCloneRuntimeDir(slug, opts) {
  const dir = cloneRuntimeDir(slug, opts);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// --- naming ----------------------------------------------------------------

/**
 * Compose project name for a per-clone stack. Includes the slot index so
 * slug-renames don't collide across recreated registry rows.
 * Compose v2 accepts `[a-z0-9_-]+`, starting with a letter or digit.
 */
export function cloneComposeProjectName(slug, index) {
  if (!isValidSlug(slug)) throw new Error(`Invalid clone slug "${slug}".`);
  if (typeof index !== "number" || index < 0 || index > CLONE_MAX_INDEX) {
    throw new Error(`Invalid slot index ${index}; expected 0..${CLONE_MAX_INDEX}.`);
  }
  const sanitized = slug.replace(/[^a-z0-9-]/g, "-");
  return `cinatra-clone-${sanitized}-${index}`;
}

/**
 * Tailscale device hostname. Stable across container restarts (the state
 * volume preserves the node identity). Slot-index suffix mirrors the compose
 * project name to disambiguate renamed registry rows.
 */
export function cloneTailscaleHostname(slug, index) {
  if (!isValidSlug(slug)) throw new Error(`Invalid clone slug "${slug}".`);
  if (typeof index !== "number" || index < 0 || index > CLONE_MAX_INDEX) {
    throw new Error(`Invalid slot index ${index}; expected 0..${CLONE_MAX_INDEX}.`);
  }
  return `cinatra-${slug.replace(/[^a-z0-9-]/g, "-")}-${index}`;
}

// --- process ---------------------------------------------------------------

/** Returns true iff the pid currently exists. ESRCH → false. */
export function isPidAlive(pid) {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process → genuinely dead. EPERM = the process EXISTS
    // but is owned by another user (we can't signal it) → still ALIVE.
    // Treating EPERM (or any non-ESRCH error) as dead would bypass every
    // fail-closed guard that gates on liveness and let prune DROP the DB
    // under a live-but-unverifiable clone.
    return !!err && err.code !== "ESRCH";
  }
}

// `runCloneStart` spawns `spawn("pnpm", ["dev"], { detached: true })`. The
// recorded pid is therefore the package-manager wrapper — its `ps` command
// line is e.g. `node /…/pnpm dev`, NOT `next`. The actual `next dev` /
// `next-server` are child processes sharing the spawned process group. A
// `mustContain: ["next"]` check against the wrapper pid ALWAYS fails, which
// can make `clone stop`/`status` and the prune in-flight guard treat
// a healthy running clone as "not ours" (leaked Next.js + a prune that could
// DROP a live clone DB). Recognise the dev-runner wrapper too.
//
// Deliberately NARROW: only the exact spawned form `<pm> dev` (we run
// `spawn("pnpm", ["dev"])`, so `ps` shows `pnpm dev` or `node …/pnpm dev`)
// and the Next.js child (`next dev` / `next-server`). It must NOT match
// unrelated same-worktree commands like `pnpm exec tool --mode dev`,
// `npm run dev:docs`, or a path containing "next" (e.g. `…/nextcloud/…`) —
// stop / `prune --force-stop` signal a process group based on this, so a
// loose match could kill an unrelated process. `dev` must be a whole token
// (followed by whitespace or end-of-string), and `next` must not be a
// substring of a longer path segment.
// The `next` branch requires `next dev` or `next-server` (whole token) —
// NOT bare `next` (which would also match `next build` / `next lint` /
// `next start` and let `clone stop` signal an unrelated same-worktree
// `next build` via a reused pid file).
const CLONE_DEV_PROC_RE =
  /(?:^|[\s/])(?:pnpm|npm|yarn|bun)\s+dev(?:\s|$)|(?:^|[\s/])next(?:-server|\s+dev)(?:\s|$)/;

/**
 * Best-effort check that a pid belongs to a process we'd recognise as the
 * clone's host-native Next.js dev server (or the package-manager wrapper we
 * spawned it through). Compares the command line (via `ps`) and, when
 * `cwdMustEqual` is given, the process cwd (symlink-canonicalised both
 * sides).
 *
 * Returns:
 *   { alive: false } — pid not running.
 *   { alive: true, ours: true } — looks like our process.
 *   { alive: true, ours: false, why } — alive, POSITIVELY a different
 *     process (command not a clone dev process, or cwd resolved to a
 *     different path).
 *   { alive: true, ours: false, indeterminate: true, why } — alive but we
 *     could NOT verify (ps/lsof/proc lookup failed, or platform
 *     unsupported). A destructive caller (prune) must fail CLOSED on this;
 *     a signalling caller (stop) must NOT signal it.
 */
export function processCommandLineMatches(pid, { cwdMustEqual } = {}) {
  if (!isPidAlive(pid)) return { alive: false };

  let cmd = "";
  try {
    cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Could not VERIFY (vs. a positive mismatch) — caller must decide
    // whether to fail closed (e.g. destructive prune) on an unverified
    // live pid.
    return { alive: true, ours: false, indeterminate: true, why: "ps failed (likely permission)" };
  }

  // The process is "ours" by command line ONLY if it is the spawned
  // dev-runner wrapper / Next.js process per the narrow CLONE_DEV_PROC_RE.
  // No loose substring fallback — a path like `…/nextcloud/…` must not
  // count as ours. The cwd check below is the authoritative per-clone
  // discriminator; this is the process-shape sanity gate.
  if (!CLONE_DEV_PROC_RE.test(cmd)) {
    return {
      alive: true,
      ours: false,
      why: `command line is not a clone dev process: ${cmd}`,
    };
  }

  if (typeof cwdMustEqual === "string") {
    let cwd = null;
    try {
      // macOS: lsof; Linux: /proc/<pid>/cwd readlink.
      if (process.platform === "darwin") {
        // `-a` ANDs the `-p`/`-d` filters. WITHOUT `-a`, `lsof -p <pid>` is
        // an OR filter that dumps EVERY process's cwd — the parse below then
        // grabbed the first system process's path (typically `/`), so the
        // cwd guard silently never matched on macOS. With `-a -p <pid>` the
        // output is a single `p<pid>` / `fcwd` / `n<path>` block.
        const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        // lsof -Fn emits the cwd as an "n<path>" line. Anchor to the n line
        // that follows this pid's record so a multi-line dump can't mislead.
        const match = out.split("\n").find((line) => line.startsWith("n"));
        cwd = match ? match.slice(1) : null;
      } else if (process.platform === "linux") {
        // Linux readlink of a REMOVED cwd yields exactly "<path> (deleted)".
        // A clone whose worktree was `rm -rf`'d (the `prune --stale` case)
        // is still OUR process — strip ONLY this kernel-emitted suffix so
        // the path still matches slot.worktreePath instead of reading as
        // "not ours" and letting prune DROP the DB under a live clone.
        // Explicitly gated to linux so the
        // `(deleted)` strip can never touch a path from another source.
        cwd = readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, "");
      } else {
        // Unsupported platform for cwd resolution — cannot verify.
        return { alive: true, ours: false, indeterminate: true, why: "cwd lookup unsupported on platform" };
      }
    } catch {
      return { alive: true, ours: false, indeterminate: true, why: "cwd lookup failed" };
    }
    if (canonicalizeWorktreePath(cwd) !== canonicalizeWorktreePath(cwdMustEqual)) {
      return { alive: true, ours: false, why: `cwd mismatch: got ${cwd} want ${cwdMustEqual}` };
    }
  }

  return { alive: true, ours: true };
}

// --- runtime lock ----------------------------------------------------------

/**
 * Acquire the per-clone runtime lock. Best-effort: open-O_EXCL on the lock
 * file. Throws if another process holds it. The caller is responsible for
 * calling `releaseRuntimeLock(slug)` from a `finally` block on EVERY failure
 * path.
 */
// A null-owner lock (no readable pid) younger than this is treated as a
// foreign acquirer's transient state, NOT stealable — back off and retry.
// Only an OLD null-owner lock counts as abandoned/corrupt and stealable.
// (Our own acquires are atomic link-publishes of a fully-written file, so
// they never present an empty/no-pid window.)
const RUNTIME_LOCK_NULL_STALE_MS = 30_000;

function sleepSyncMs(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* brief sync backoff for a short CLI lock */ }
}

export function acquireRuntimeLock(slug, opts) {
  ensureCloneRuntimeDir(slug, opts);
  const lockPath = cloneLockPath(slug, opts);
  // Bounded retry: each iteration either acquires (atomic link-publish of a
  // fully-written file → no empty-file window) or steals a provably
  // dead/abandoned lock. Capped so pathological contention can't spin
  // forever (~50 * 50ms ≈ 2.5s tolerance for a foreign partial write).
  for (let attempt = 0; attempt < 50; attempt += 1) {
    // Publish atomically: write the pid to a temp file FIRST, then
    // `linkSync` it into place (atomic, no-clobber). The lock file is
    // therefore fully populated the instant it becomes observable — a
    // racer can never see it pid-less and wrongly judge it stealable.
    const tmpPath = `${lockPath}.acq.${process.pid}.${Date.now()}`;
    try {
      writeFileSync(tmpPath, `${process.pid}\n${new Date().toISOString()}\n`, { mode: 0o600 });
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* best-effort */ }
      throw err;
    }
    try {
      linkSync(tmpPath, lockPath);
      try { unlinkSync(tmpPath); } catch { /* best-effort */ }
      return; // acquired
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* best-effort */ }
      if (!err || err.code !== "EEXIST") throw err;
    }

    const ownerPid = readLockOwnerPid(lockPath);
    if (ownerPid != null && isPidAlive(ownerPid)) {
      throw new Error(
        `clone start: runtime lock held by pid ${ownerPid} at ${lockPath}. ` +
          `Either wait for the other invocation to finish, or run 'cinatra clone status --slug ${slug}' to investigate.`,
      );
    }
    if (ownerPid == null) {
      // No readable pid. With atomic link-publish this is NOT a transient
      // window for any well-behaved acquirer, so it's a foreign/corrupt
      // lock — but only treat it as stealable once it has aged past the
      // stale threshold; a younger one might still be a misbehaving peer.
      let ageMs = Infinity;
      try { ageMs = Date.now() - statSync(lockPath).mtimeMs; }
      catch { continue; /* vanished — retry acquire */ }
      if (ageMs <= RUNTIME_LOCK_NULL_STALE_MS) {
        sleepSyncMs(50);
        continue; // back off; do NOT steal a fresh pid-less lock
      }
    }

    // Owner is provably dead, or a stale/corrupt pid-less lock → steal via
    // atomic rename (only ONE racer can rename a given inode; the rest get
    // ENOENT and just retry). Never an unconditional unlink.
    const stealPath = `${lockPath}.steal.${process.pid}.${Date.now()}`;
    try {
      renameSync(lockPath, stealPath);
    } catch {
      continue; // already rotated/removed by someone else — retry acquire
    }
    // Re-verify on the MOVED file. If a fresh holder recreated lockPath
    // between our check and the rename, the file we grabbed now has a LIVE
    // owner — restore it (no-clobber) and treat the lock as held.
    const stolenOwner = readLockOwnerPid(stealPath);
    if (stolenOwner != null && isPidAlive(stolenOwner)) {
      try {
        linkSync(stealPath, lockPath); // fails EEXIST if a newer holder took it
      } catch {
        /* a newer holder owns lockPath — discard our stolen copy */
      }
      try { unlinkSync(stealPath); } catch { /* best-effort */ }
      throw new Error(
        `clone start: runtime lock held by pid ${stolenOwner} at ${lockPath}. ` +
          `Either wait for the other invocation to finish, or run 'cinatra clone status --slug ${slug}' to investigate.`,
      );
    }
    // Genuinely stale — discard and loop to re-publish.
    try { unlinkSync(stealPath); } catch { /* already gone */ }
  }
  throw new Error(
    `clone start: could not acquire the runtime lock at ${lockPath} after repeated ` +
      `contention. Run 'cinatra clone status --slug ${slug}' to investigate.`,
  );
}

export function releaseRuntimeLock(slug, opts) {
  const lockPath = cloneLockPath(slug, opts);
  try {
    unlinkSync(lockPath);
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }
}

export function isRuntimeLockHeld(slug, opts) {
  return existsSync(cloneLockPath(slug, opts));
}

function readLockOwnerPid(lockPath) {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const first = raw.split("\n", 1)[0]?.trim();
    if (!first) return null;
    const pid = Number.parseInt(first, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// --- port-band guard -------------------------------------------------------

/**
 * Refuse to start a clone whose registered port falls outside the
 * clone-on-demand port bands. Catches corrupt/legacy registry rows.
 */
export function assertPortBandOk(port, kind) {
  if (typeof port !== "number" || !Number.isFinite(port)) {
    throw new Error(`Clone runtime: port for ${kind} is not a number: ${port}`);
  }
  if (kind === "nextjs") {
    if (port < CLONE_NEXTJS_PORT_BASE || port > CLONE_NEXTJS_PORT_LIMIT) {
      throw new Error(
        `Clone runtime: Next.js port ${port} outside band ` +
          `${CLONE_NEXTJS_PORT_BASE}-${CLONE_NEXTJS_PORT_LIMIT}. Registry corrupt?`,
      );
    }
    return;
  }
  if (kind === "wayflow") {
    if (port < CLONE_WAYFLOW_PORT_BASE || port > CLONE_WAYFLOW_PORT_LIMIT) {
      throw new Error(
        `Clone runtime: WayFlow port ${port} outside band ` +
          `${CLONE_WAYFLOW_PORT_BASE}-${CLONE_WAYFLOW_PORT_LIMIT}. Registry corrupt?`,
      );
    }
    return;
  }
  throw new Error(`Clone runtime: unknown port kind "${kind}".`);
}

// --- log management --------------------------------------------------------

/**
 * Truncate the per-clone Next.js log so each `clone start` begins with an
 * empty log. Operators tail the file in another terminal; cumulative debug
 * history is the operator's responsibility.
 */
export function truncateCloneLog(slug, opts) {
  const logPath = cloneLogPath(slug, opts);
  ensureCloneRuntimeDir(slug, opts);
  if (existsSync(logPath)) {
    truncateSync(logPath, 0);
  } else {
    writeFileSync(logPath, "", { mode: 0o600 });
  }
  return logPath;
}

// --- Tailscale authkey -----------------------------------------------------

const TAILSCALE_AUTHKEY_PREFIX = "tskey-auth-";
const TAILSCALE_AUTHKEY_RE = /^tskey-auth-[A-Za-z0-9_-]+$/;

/**
 * Validate a Tailscale auth key shape. The CLI rejects keys that don't start
 * with `tskey-auth-` — Tailscale's documented form — so we fail fast with a
 * useful pointer to the auth-keys docs.
 *
 * @returns {string} the validated key
 */
export function validateTailscaleAuthkey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error(
      "TS_AUTHKEY is required to expose a clone via Tailscale Funnel. " +
        "Generate one at https://login.tailscale.com/configuration/settings/keys (ephemeral + preauthorised recommended).",
    );
  }
  if (!TAILSCALE_AUTHKEY_RE.test(key)) {
    throw new Error(
      `TS_AUTHKEY format invalid (expected '${TAILSCALE_AUTHKEY_PREFIX}…'; got ${redactTailscaleAuthkey(key)}). ` +
        `See https://tailscale.com/kb/1085/auth-keys`,
    );
  }
  return key;
}

/**
 * Redact a Tailscale auth key for logging / display. Returns a fixed-length
 * marker that reveals only the last 4 chars of the key, so an operator can
 * cross-check that the right key is being used without exposing the secret.
 */
export function redactTailscaleAuthkey(key) {
  if (typeof key !== "string") return "<not-a-string>";
  if (key.length === 0) return "<empty>";
  // Keep just enough suffix to disambiguate without leaking the secret.
  const tail = key.slice(-4);
  return `${TAILSCALE_AUTHKEY_PREFIX}…${tail}`;
}

/**
 * Scrub a Tailscale auth key out of arbitrary string content. Used when
 * surfacing docker compose stderr or rendered-compose previews so a key
 * accidentally interpolated by some other path doesn't leak.
 */
export function scrubTailscaleAuthkey(content, key) {
  if (typeof content !== "string" || content.length === 0) return content ?? "";
  if (typeof key !== "string" || key.length < 8) return content;
  return content.split(key).join(redactTailscaleAuthkey(key));
}

// --- argv helpers ----------------------------------------------------------

/**
 * Reject any form of `--tailscale-authkey` in argv. Both the space form
 * (`--tailscale-authkey foo`) and equals form (`--tailscale-authkey=foo`)
 * leak the secret through `argv`, `ps`, and shell history — so the CLI
 * refuses outright and tells operators to set `TS_AUTHKEY` in env.
 */
export function rejectTailscaleAuthkeyFlag(argv) {
  if (!Array.isArray(argv)) return;
  if (argv.some((tok) => tok === "--tailscale-authkey" || (typeof tok === "string" && tok.startsWith("--tailscale-authkey=")))) {
    throw new Error(
      "--tailscale-authkey is not accepted; pass TS_AUTHKEY via env to keep the secret out of shell history and process args.",
    );
  }
}

/**
 * Flags that take a value (i.e. argv[i+1] is the value, not a positional).
 * Prevents `--worktree-path /tmp/wt` from being interpreted as a
 * positional slug = "/tmp/wt".
 */
export const CLONE_VALUE_FLAGS = Object.freeze(
  new Set(["--worktree-path", "--slug", "--source-env"]),
);

/**
 * Find a positional slug-shaped argument, skipping the values of known
 * value-taking flags. Returns null if no candidate matches the slug regex.
 */
export function findPositionalSlug(argv) {
  if (!Array.isArray(argv)) return null;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (typeof tok !== "string") continue;
    if (tok.startsWith("--") || tok.startsWith("-")) {
      if (CLONE_VALUE_FLAGS.has(tok)) i++; // skip the value
      continue;
    }
    if (/^[a-z0-9][a-z0-9-]{0,29}$/.test(tok)) return tok;
  }
  return null;
}

// --- __test re-export ------------------------------------------------------

export const __test = {
  CLONE_NEXTJS_PORT_LIMIT,
  CLONE_WAYFLOW_PORT_LIMIT,
  TAILSCALE_AUTHKEY_RE,
};
