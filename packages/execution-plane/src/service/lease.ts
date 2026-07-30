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
 * How long a VALID lease document may be reused without re-reading. Short on
 * purpose: it bounds only how stale our view of the tenant/replacement can be,
 * never how stale our view of EXPIRY is — `check()` re-derives expiry against
 * the current clock on every call, cached document or not.
 */
export const DEFAULT_LEASE_CACHE_TTL_MS = 2_000;

/** Mutex spin, matching the provisioning script's bounded ~10s wait. */
export const LOCK_SPIN_ATTEMPTS = 100;
export const LOCK_SPIN_DELAY_MS = 100;
/** A lock directory older than this belongs to a crashed holder. */
export const STALE_LOCK_MS = 60_000;

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
      /** Epoch seconds the lease lapses at; `null` for a non-expiring lease. */
      expiresAtEpochS: number | null;
    }
  | { ok: false; reason: LeaseRefusalReason; message: string };

export type LeaseRenewalResult =
  | { ok: true; lease: HostExclusivityLease }
  | {
      ok: false;
      reason: LeaseRefusalReason | "lock_unavailable" | "write_failed";
      message: string;
    };

/** Injection seams so the matrix runs hermetically (and on a real temp dir). */
export type LeaseIo = {
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, data: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  mkdir: (dirPath: string) => Promise<void>;
  rmdir: (dirPath: string) => Promise<void>;
  removeFile: (filePath: string) => Promise<void>;
  dirModifiedAtMs: (dirPath: string) => Promise<number | null>;
  sleep: (ms: number) => Promise<void>;
};

export const nodeLeaseIo: LeaseIo = {
  readFile: (filePath) => readFile(filePath, "utf8"),
  // 0o600 mirrors the writer's `chmod 600` on the temp file.
  writeFile: (filePath, data) => writeFile(filePath, data, { mode: 0o600 }),
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

/** Parse one lease document. Anything unexpected is `malformed` (fail-closed). */
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
  return {
    ok: true,
    lease: {
      tenant,
      acquiredAtEpochS,
      ttlSeconds,
      renewedAtEpochS: isNonNegativeInteger(renewedAt) ? renewedAt : null,
    },
  };
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
    expiresAtEpochS:
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
    const nowMs = this.now();
    const nowEpochS = Math.floor(nowMs / 1000);
    if (this.cached && nowMs - this.cached.readAtMs < this.cacheTtlMs) {
      const verdict = evaluateHostExclusivityLease(
        this.cached.lease,
        this.tenant,
        nowEpochS,
      );
      if (!verdict.ok) this.cached = null;
      return verdict;
    }
    const read = await this.read();
    if (!read.ok) {
      this.cached = null;
      return read;
    }
    this.cached = { lease: read.lease, readAtMs: nowMs };
    const verdict = evaluateHostExclusivityLease(read.lease, this.tenant, nowEpochS);
    if (!verdict.ok) this.cached = null;
    return verdict;
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
      const nowEpochS = Math.floor(this.now() / 1000);
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
      const tempPath = path.join(this.leaseDir, `.lease.${this.tempSuffix()}`);
      try {
        await this.io.writeFile(tempPath, body);
        await this.io.rename(tempPath, this.leasePath);
      } catch (err) {
        await this.io.removeFile(tempPath).catch(() => {});
        return {
          ok: false,
          reason: "write_failed",
          message: `Could not publish the renewed host-exclusivity lease: ${describe(err)}`,
        };
      }
      this.cached = { lease: renewed, readAtMs: this.now() };
      return { ok: true, lease: renewed };
    } finally {
      await this.io.rmdir(this.lockDir).catch(() => {});
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
        if (modifiedAtMs !== null && this.now() - modifiedAtMs > STALE_LOCK_MS) {
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
