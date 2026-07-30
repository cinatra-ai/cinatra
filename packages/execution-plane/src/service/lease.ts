/**
 * HOST-EXCLUSIVITY LEASE — the broker's read/renew side (exec-plane L3, epic
 * cinatra#1705).
 *
 * A spoke that runs execution-plane workers IN-VM must be single-tenant for
 * local execution: the platform trust ruling forbids a second tenant's workers
 * sharing a host that already runs a tenant's local workers. The provisioning
 * side takes that lease BEFORE local-worker mode is enabled and can reclaim it
 * (expiry, or an explicit operator revoke). This module is the other half: the
 * broker REVALIDATES the lease before every placement decision and, when it no
 * longer holds, stops admitting and drains what is already running.
 *
 * THE LEASE DOCUMENT IS NOT OURS TO DEFINE. It is a one-line JSON file written
 * by the provisioning script and parsed by that script's own `sed` expressions:
 *
 *     {"tenant":"<slug>","acquired_at":<epoch_s>,"ttl_seconds":<n>,"renewed_at":<epoch_s>}
 *
 * `serializeHostExclusivityLease` reproduces that byte layout EXACTLY —
 * same keys, same order, no whitespace, trailing newline — because a renewal
 * this process writes has to stay readable by the shell parser that owns
 * acquisition and release. Do not "improve" it into `JSON.stringify`.
 *
 * READ BY PATH, EVERY TIME. The writer publishes with an atomic `mv` of a
 * fully-formed temp file, i.e. a RENAME: the path is repointed at a NEW inode.
 * A cached file descriptor — or a container that bind-mounts the lease FILE
 * rather than its DIRECTORY — keeps the OLD inode alive and would go on reading
 * a lease that no longer exists on the host. Every read here is a fresh
 * `readFile(path)`, and the deployment binds the lease DIRECTORY.
 *
 * EXPIRY MATH IS COPIED FROM THE WRITER, INCLUDING WHAT IT IGNORES. The
 * provisioning script computes expiry as `ttl > 0 && now > acquired_at + ttl`
 * and NEVER reads `renewed_at`. So a renewal that bumped only `renewed_at`
 * would leave the lease reclaimable by another tenant while this broker's
 * workers are live — the renewal below therefore rewrites `acquired_at` to
 * `now` (and keeps `renewed_at` in step for the operator's benefit), under the
 * SAME POSIX `mkdir` mutex the writer uses, after re-reading and re-verifying
 * ownership. A renewal that cannot prove the lease is still ours writes
 * nothing.
 *
 * FAIL-CLOSED, INCLUDING ON "I DON'T KNOW". Absent, unreadable, malformed,
 * expired, or held by another tenant all refuse placement. This is deliberately
 * the OPPOSITE posture from the run-liveness probe (which stays permissive on a
 * transient read error): liveness protects one run, host exclusivity is a
 * tenancy boundary, and a host we cannot prove is ours must not be running our
 * containers next to somebody else's.
 */

import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import * as path from "node:path";

/** Default lease path on the spoke; overridable per deployment. */
export const DEFAULT_HOST_EXCLUSIVITY_LEASE_PATH =
  "/opt/cinatra-exec/host-exclusivity.lease";

/** The provisioning script's mutex, taken for the read-decide-write section. */
export const HOST_EXCLUSIVITY_LOCK_DIR_NAME = ".host-exclusivity.lock.d";

/** Scoped env the broker service reads (never an app variable). */
export const HOST_EXCLUSIVITY_MODE_ENV = "EXEC_HOST_EXCLUSIVITY";
export const HOST_EXCLUSIVITY_TENANT_ENV = "EXEC_HOST_EXCLUSIVITY_TENANT";
export const HOST_EXCLUSIVITY_LEASE_PATH_ENV = "EXEC_HOST_EXCLUSIVITY_LEASE";
export const HOST_EXCLUSIVITY_RENEW_INTERVAL_ENV =
  "EXEC_HOST_EXCLUSIVITY_RENEW_INTERVAL_MS";

/**
 * How long a VALID lease document may be reused without re-reading.
 *
 * ZERO BY DEFAULT — every placement decision reads the lease (Codex round 1,
 * finding 2a, ADOPTED). A cache here does not merely make the view stale, it
 * makes it stale about OWNERSHIP: during the window, the provisioning side can
 * revoke our lease and hand the host to another tenant while we keep admitting
 * containers onto it. That is precisely the state the lease exists to prevent,
 * and the read it saves is one small file on a local bind mount.
 *
 * The knob remains for a deployment that explicitly accepts up to `cacheTtlMs`
 * of that exposure in exchange for the read. Even then the cache holds the
 * DOCUMENT, never the verdict: expiry is re-derived against the current clock
 * on every call.
 */
export const DEFAULT_LEASE_CACHE_TTL_MS = 0;

/** Mutex spin, matching the provisioning script's bounded ~10s wait. */
export const LOCK_SPIN_ATTEMPTS = 100;
export const LOCK_SPIN_DELAY_MS = 100;
/**
 * Stale-lock reclaim threshold, in WHOLE MINUTES, reproducing `find -mmin +1`
 * (Codex round 1, finding 4, ADOPTED).
 *
 * `-mmin +1` compares TRUNCATED minutes and `+n` means strictly greater, so the
 * shell first reclaims at ~120 s, not 60 s. A 60 s threshold here would let this
 * process delete a lock a legitimate 61–119 s shell critical section still
 * holds — two writers inside the read-decide-write section, which is the exact
 * failure the mutex exists to prevent. Compare the same way the shell does.
 */
export const STALE_LOCK_MINUTES = 1;

/** True when the shell's `find -mmin +STALE_LOCK_MINUTES` would fire. */
export function lockIsStale(ageMs: number): boolean {
  return Math.floor(ageMs / 60_000) > STALE_LOCK_MINUTES;
}

/** The tenant slug shape the provisioning script validates before writing. */
export const TENANT_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type HostExclusivityLease = {
  tenant: string;
  /** `acquired_at` — epoch SECONDS, the only field expiry is computed from. */
  acquiredAtEpochS: number;
  /** `ttl_seconds` — 0 means non-expiring (renewal keeps it live instead). */
  ttlSeconds: number;
  /** `renewed_at` — informational; the writer's expiry math never reads it. */
  renewedAtEpochS: number | null;
};

export type LeaseRefusalReason =
  | "absent"
  | "unreadable"
  | "malformed"
  | "expired"
  | "other_tenant";

export type LeaseVerdict =
  | {
      ok: true;
      lease: HostExclusivityLease;
      /**
       * The LAST epoch second at which the lease is still live; `null` for a
       * non-expiring lease.
       *
       * Named for the writer's own comparison (`now > acquired_at + ttl`), not
       * for the moment of lapse: at `acquired_at + ttl` the lease is still held
       * by both sides, and it first expires one second later. An
       * `expiresAt`-shaped name reads one second early and would eventually be
       * used that way (Codex round 1, finding 5a, ADOPTED).
       */
      liveThroughEpochS: number | null;
    }
  | { ok: false; reason: LeaseRefusalReason; message: string };

export type LeaseRenewalResult =
  | { ok: true; lease: HostExclusivityLease }
  | {
      ok: false;
      reason: LeaseRefusalReason | "lock_unavailable" | "write_failed";
      message: string;
    };

/** Retries for the exclusive temp-name mint and for the mutex release. */
export const TEMP_NAME_ATTEMPTS = 5;
export const LOCK_RELEASE_ATTEMPTS = 3;

/** Injection seams so the matrix runs hermetically (and on a real temp dir). */
export type LeaseIo = {
  readFile: (filePath: string) => Promise<string>;
  /** MUST fail with EEXIST rather than truncate or follow an existing path. */
  writeFileExclusive: (filePath: string, data: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  mkdir: (dirPath: string) => Promise<void>;
  rmdir: (dirPath: string) => Promise<void>;
  removeFile: (filePath: string) => Promise<void>;
  dirModifiedAtMs: (dirPath: string) => Promise<number | null>;
  sleep: (ms: number) => Promise<void>;
};

export const nodeLeaseIo: LeaseIo = {
  readFile: (filePath) => readFile(filePath, "utf8"),
  // `wx` + 0o600 reproduces `mktemp` + `chmod 600`: O_EXCL means an existing
  // path — including a symlink somebody planted — is an EEXIST error rather
  // than a target we follow and truncate.
  writeFileExclusive: (filePath, data) =>
    writeFile(filePath, data, { mode: 0o600, flag: "wx" }),
  rename: (from, to) => rename(from, to),
  mkdir: (dirPath) => mkdir(dirPath),
  // `rmdir`, NOT `rm`: the lock is a DIRECTORY, and `fs.rm` without
  // `recursive` refuses one (ERR_FS_EISDIR) — a release that silently never
  // released, wedging every later renewal behind a lock nobody holds. `rmdir`
  // also fails if the directory is non-empty, which is the right refusal: the
  // lock is only ever an empty marker.
  rmdir: (dirPath) => rmdir(dirPath),
  removeFile: (filePath) => rm(filePath, { force: true }),
  dirModifiedAtMs: async (dirPath) => {
    try {
      return (await stat(dirPath)).mtimeMs;
    } catch {
      return null;
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Render the lease document BYTE-FOR-BYTE as the provisioning script's
 * `printf` does. The tenant slug is re-asserted here rather than trusted: it is
 * interpolated into a JSON string, and a value carrying `"` would emit a
 * document the shell parser reads as a DIFFERENT tenant.
 */
export function serializeHostExclusivityLease(lease: {
  tenant: string;
  acquiredAtEpochS: number;
  ttlSeconds: number;
  renewedAtEpochS: number;
}): string {
  if (!TENANT_SLUG_RE.test(lease.tenant)) {
    throw new Error(
      "Refusing to write a host-exclusivity lease for a tenant that is not a valid slug.",
    );
  }
  for (const [field, value] of [
    ["acquired_at", lease.acquiredAtEpochS],
    ["ttl_seconds", lease.ttlSeconds],
    ["renewed_at", lease.renewedAtEpochS],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `Refusing to write a host-exclusivity lease with a non-integer "${field}".`,
      );
    }
  }
  return (
    `{"tenant":"${lease.tenant}",` +
    `"acquired_at":${lease.acquiredAtEpochS},` +
    `"ttl_seconds":${lease.ttlSeconds},` +
    `"renewed_at":${lease.renewedAtEpochS}}\n`
  );
}

/**
 * Parse one lease document. Anything unexpected is `malformed` (fail-closed).
 *
 * THE DOCUMENT MUST BE IN THE WRITER'S EXACT CANONICAL FORM. Not a stylistic
 * preference — a correctness requirement, because the writer parses with greedy
 * `sed` over the raw bytes while this parses structured JSON, and the two
 * disagree on inputs neither would ever produce (Codex round 1, findings 2b/3a,
 * ADOPTED):
 *
 *   - `{"tenant":"a","x":{"tenant":"b"},…}` is tenant "b" to the greedy `sed`
 *     and tenant "a" to `JSON.parse` — i.e. this process would believe it owns
 *     a host the writer considers someone else's;
 *   - `"ttl_seconds":1e3` is 1000 to `JSON.parse` and 1 to the `[0-9]*` capture,
 *     so a lease the writer treats as long expired would verify here.
 *
 * Re-serializing the parsed values and requiring a byte-exact match with the
 * input collapses that entire class: only what the writer itself emits is
 * accepted, and anything else is `malformed` — which is a refusal.
 */
export function parseHostExclusivityLease(
  raw: string,
): { ok: true; lease: HostExclusivityLease } | { ok: false; message: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { ok: false, message: "the lease document is not valid JSON" };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, message: "the lease document is not a JSON object" };
  }
  const record = doc as Record<string, unknown>;
  const tenant = record.tenant;
  if (typeof tenant !== "string" || !TENANT_SLUG_RE.test(tenant)) {
    return { ok: false, message: "the lease document carries no valid tenant slug" };
  }
  const acquiredAtEpochS = record.acquired_at;
  const ttlSeconds = record.ttl_seconds;
  if (!isNonNegativeInteger(acquiredAtEpochS)) {
    return { ok: false, message: "the lease document carries no valid acquired_at" };
  }
  if (!isNonNegativeInteger(ttlSeconds)) {
    return { ok: false, message: "the lease document carries no valid ttl_seconds" };
  }
  const renewedAt = record.renewed_at;
  if (!isNonNegativeInteger(renewedAt)) {
    return { ok: false, message: "the lease document carries no valid renewed_at" };
  }
  // The expiry the writer computes is `acquired_at + ttl_seconds` in shell
  // integer arithmetic, which is exact past IEEE-754's safe range. A sum this
  // process cannot represent exactly is a sum it must not compare against
  // (Codex round 1, finding 5b, ADOPTED).
  if (!Number.isSafeInteger(acquiredAtEpochS + ttlSeconds)) {
    return {
      ok: false,
      message: "the lease document's acquired_at + ttl_seconds is not exactly representable",
    };
  }
  const lease: HostExclusivityLease = {
    tenant,
    acquiredAtEpochS,
    ttlSeconds,
    renewedAtEpochS: renewedAt,
  };
  if (serializeHostExclusivityLease({ ...lease, renewedAtEpochS: renewedAt }) !== raw) {
    return {
      ok: false,
      message:
        "the lease document is not in the writer's canonical form (it would be read " +
        "differently by the writer's own parser)",
    };
  }
  return { ok: true, lease };
}

/**
 * Evaluate a parsed lease for `tenant` at `nowEpochS`.
 *
 * The expiry comparison is `now > acquired_at + ttl`, strictly greater, exactly
 * as the writer computes it — a lease is live for its full final second on both
 * sides of the boundary, so the two never disagree about the same instant.
 */
export function evaluateHostExclusivityLease(
  lease: HostExclusivityLease,
  tenant: string,
  nowEpochS: number,
): LeaseVerdict {
  if (lease.tenant !== tenant) {
    return {
      ok: false,
      reason: "other_tenant",
      message:
        "The execution host is leased to a different tenant for local-worker mode; " +
        "placement is refused (fail-closed).",
    };
  }
  if (lease.ttlSeconds > 0 && nowEpochS > lease.acquiredAtEpochS + lease.ttlSeconds) {
    return {
      ok: false,
      reason: "expired",
      message:
        "This tenant's host-exclusivity lease has expired and the host may be " +
        "reclaimed at any moment; placement is refused (fail-closed).",
    };
  }
  return {
    ok: true,
    lease,
    liveThroughEpochS:
      lease.ttlSeconds > 0 ? lease.acquiredAtEpochS + lease.ttlSeconds : null,
  };
}

export type HostExclusivityGuardConfig = {
  /** This deployment's tenant slug — the only tenant a valid lease may name. */
  tenant: string;
  /** Absolute path of the lease document ON the spoke. */
  leasePath?: string;
  /** How long a VALID document may be reused without re-reading. */
  cacheTtlMs?: number;
  /** Injectable clock (epoch ms) for hermetic tests. */
  nowMs?: () => number;
  io?: LeaseIo;
  /** Injectable temp-name source, so a renewal is reproducible in tests. */
  tempSuffix?: () => string;
};

/**
 * The broker's view of the lease: a cached-but-never-stale-about-expiry read,
 * plus the renewal that keeps `acquired_at` moving.
 */
export class HostExclusivityLeaseGuard {
  private readonly tenant: string;
  private readonly leasePath: string;
  private readonly leaseDir: string;
  private readonly lockDir: string;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly io: LeaseIo;
  private readonly tempSuffix: () => string;
  private cached: { lease: HostExclusivityLease; readAtMs: number } | null = null;

  constructor(config: HostExclusivityGuardConfig) {
    if (!TENANT_SLUG_RE.test(config.tenant)) {
      throw new Error(
        `${HOST_EXCLUSIVITY_TENANT_ENV} must be a tenant slug matching ${TENANT_SLUG_RE.source}.`,
      );
    }
    this.tenant = config.tenant;
    this.leasePath = config.leasePath ?? DEFAULT_HOST_EXCLUSIVITY_LEASE_PATH;
    if (!path.isAbsolute(this.leasePath)) {
      throw new Error(
        `${HOST_EXCLUSIVITY_LEASE_PATH_ENV} must be an absolute path (got a relative one).`,
      );
    }
    this.leaseDir = path.dirname(this.leasePath);
    this.lockDir = path.join(this.leaseDir, HOST_EXCLUSIVITY_LOCK_DIR_NAME);
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_LEASE_CACHE_TTL_MS;
    this.now = config.nowMs ?? (() => Date.now());
    this.io = config.io ?? nodeLeaseIo;
    this.tempSuffix = config.tempSuffix ?? (() => randomBytes(6).toString("hex"));
  }

  /** Drop the cached document, so the next `check()` re-reads from disk. */
  invalidate(): void {
    this.cached = null;
  }

  /**
   * Fail-closed revalidation, run before EVERY placement decision.
   *
   * The cache holds the parsed DOCUMENT, never the verdict: expiry is always
   * re-derived against the current clock, so a lease cannot be admitted past
   * its TTL by a stale positive. A refusal always drops the cache, so a
   * re-acquired lease is picked up on the very next call rather than after the
   * cache window.
   */
  async check(): Promise<LeaseVerdict> {
    if (this.cached && this.now() - this.cached.readAtMs < this.cacheTtlMs) {
      const verdict = evaluateHostExclusivityLease(
        this.cached.lease,
        this.tenant,
        this.nowEpochS(),
      );
      if (!verdict.ok) this.cached = null;
      return verdict;
    }
    const read = await this.read();
    if (!read.ok) {
      this.cached = null;
      return read;
    }
    this.cached = { lease: read.lease, readAtMs: this.now() };
    // Sample the clock AFTER the awaited read, never before it (Codex round 1,
    // finding 2c, ADOPTED): a read that completes across the expiry boundary
    // would otherwise be judged against the timestamp from before it, and admit
    // a placement the writer already considers expired.
    const verdict = evaluateHostExclusivityLease(
      read.lease,
      this.tenant,
      this.nowEpochS(),
    );
    if (!verdict.ok) this.cached = null;
    return verdict;
  }

  private nowEpochS(): number {
    return Math.floor(this.now() / 1000);
  }

  /**
   * Renew under the writer's own mutex.
   *
   * Re-read INSIDE the lock, verify the lease still names this tenant and has
   * not lapsed, then publish a document with `acquired_at = now`. Bumping only
   * `renewed_at` would be a no-op to the writer's expiry math (it reads
   * `acquired_at + ttl` and nothing else), i.e. another tenant could reclaim
   * the host under live workers while our renewals "succeeded".
   */
  async renew(): Promise<LeaseRenewalResult> {
    const held = await this.acquireLock();
    if (!held) {
      return {
        ok: false,
        reason: "lock_unavailable",
        message:
          "Could not take the host-exclusivity lock; the lease was left untouched.",
      };
    }
    try {
      const read = await this.read();
      if (!read.ok) return read;
      const nowEpochS = this.nowEpochS();
      const verdict = evaluateHostExclusivityLease(read.lease, this.tenant, nowEpochS);
      if (!verdict.ok) return verdict;
      const renewed: HostExclusivityLease = {
        tenant: this.tenant,
        acquiredAtEpochS: nowEpochS,
        ttlSeconds: read.lease.ttlSeconds,
        renewedAtEpochS: nowEpochS,
      };
      const body = serializeHostExclusivityLease({
        tenant: renewed.tenant,
        acquiredAtEpochS: renewed.acquiredAtEpochS,
        ttlSeconds: renewed.ttlSeconds,
        renewedAtEpochS: nowEpochS,
      });
      // Same publish choreography as the writer: a fully-formed temp file in
      // the SAME directory (so the rename is atomic on one filesystem), then
      // rename over the target. A reader can only ever see one whole document.
      //
      // The temp file is created EXCLUSIVELY (`wx`, mode 0600) and the name is
      // retried on collision — `mktemp` semantics, not `writeFile`'s truncating
      // open, which would follow a pre-planted symlink or reuse an existing
      // file's permissions (Codex round 1, finding 3b, ADOPTED).
      let tempPath: string | null = null;
      try {
        for (let attempt = 0; attempt < TEMP_NAME_ATTEMPTS; attempt += 1) {
          const candidate = path.join(this.leaseDir, `.lease.${this.tempSuffix()}`);
          try {
            await this.io.writeFileExclusive(candidate, body);
            tempPath = candidate;
            break;
          } catch (err) {
            if ((err as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw err;
          }
        }
        if (tempPath === null) {
          return {
            ok: false,
            reason: "write_failed",
            message:
              "Could not create a temp file to publish the renewed host-exclusivity lease.",
          };
        }
        await this.io.rename(tempPath, this.leasePath);
      } catch (err) {
        if (tempPath !== null) await this.io.removeFile(tempPath).catch(() => {});
        return {
          ok: false,
          reason: "write_failed",
          message: `Could not publish the renewed host-exclusivity lease: ${describe(err)}`,
        };
      }
      this.cached = { lease: renewed, readAtMs: this.now() };
      return { ok: true, lease: renewed };
    } finally {
      await this.releaseLock();
    }
  }

  /**
   * Release the mutex, retrying a bounded number of times.
   *
   * Codex round 1, finding 3c — PARTIALLY ADOPTED. The retry is adopted. The
   * other half ("report failure instead of success") is REBUTTED and recorded:
   * a renewal whose rename landed genuinely renewed the lease, and turning that
   * into a reported failure would make the caller re-renew a lease that is
   * already correct while the real problem — a lock nobody holds — went
   * unaddressed either way. The designed remedy for a wedged lock is the
   * stale-lock reclaim both sides implement, and it is what a crashed holder
   * gets too.
   */
  private async releaseLock(): Promise<void> {
    for (let attempt = 0; attempt < LOCK_RELEASE_ATTEMPTS; attempt += 1) {
      try {
        await this.io.rmdir(this.lockDir);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
        if (attempt + 1 < LOCK_RELEASE_ATTEMPTS) await this.io.sleep(LOCK_SPIN_DELAY_MS);
      }
    }
  }

  private async read(): Promise<
    { ok: true; lease: HostExclusivityLease } | Extract<LeaseVerdict, { ok: false }>
  > {
    let raw: string;
    try {
      raw = await this.io.readFile(this.leasePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        return {
          ok: false,
          reason: "absent",
          message:
            "No host-exclusivity lease is present on this execution host; placement " +
            "is refused (fail-closed).",
        };
      }
      return {
        ok: false,
        reason: "unreadable",
        message:
          "The host-exclusivity lease could not be read; placement is refused " +
          "(fail-closed — an unprovable lease is not a held one).",
      };
    }
    const parsed = parseHostExclusivityLease(raw);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: "malformed",
        message: `The host-exclusivity lease is unusable (${parsed.message}); placement is refused (fail-closed).`,
      };
    }
    return { ok: true, lease: parsed.lease };
  }

  /**
   * The provisioning script's POSIX-atomic `mkdir` mutex, reproduced: bounded
   * spin, and a lock directory older than `STALE_LOCK_MS` is reclaimed (a
   * crashed holder must not wedge every future renewal).
   */
  private async acquireLock(): Promise<boolean> {
    for (let attempt = 0; attempt < LOCK_SPIN_ATTEMPTS; attempt += 1) {
      try {
        await this.io.mkdir(this.lockDir);
        return true;
      } catch {
        const modifiedAtMs = await this.io.dirModifiedAtMs(this.lockDir);
        if (modifiedAtMs !== null && lockIsStale(this.now() - modifiedAtMs)) {
          await this.io.rmdir(this.lockDir).catch(() => {});
        }
      }
      await this.io.sleep(LOCK_SPIN_DELAY_MS);
    }
    return false;
  }
}

/**
 * Project the guard onto the broker's placement seam.
 *
 * The broker learns only ok/not-ok plus a coarse reason — it never sees the
 * tenant slug or the lease path, and neither does anything the broker audits.
 */
export function hostExclusivityPlacementGuard(
  guard: Pick<HostExclusivityLeaseGuard, "check">,
): () => Promise<{ ok: true } | { ok: false; reason: string; message: string }> {
  return async () => {
    const verdict = await guard.check();
    if (verdict.ok) return { ok: true };
    return {
      ok: false,
      reason: `host_exclusivity_${verdict.reason}`,
      message: verdict.message,
    };
  };
}

/**
 * Drive renewals on a timer. Returns the stopper. The handle is `unref`'d so a
 * renewal timer never keeps a process alive on its own.
 */
export function startHostExclusivityRenewal(
  guard: Pick<HostExclusivityLeaseGuard, "renew">,
  intervalMs: number,
  onResult?: (result: LeaseRenewalResult) => void,
): () => void {
  const handle = setInterval(() => {
    void guard
      .renew()
      .then((result) => onResult?.(result))
      .catch(() => {
        /* a renewal failure is reported through onResult, never thrown here */
      });
  }, intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
