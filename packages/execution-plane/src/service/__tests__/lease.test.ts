/**
 * The HOST-EXCLUSIVITY LEASE MATRIX (exec-plane L3).
 *
 * Run against a REAL temp directory and REAL atomic renames, not a mocked
 * filesystem. The whole point of the module is how it behaves when the
 * provisioning side replaces the lease inode underneath it, and a mocked `fs`
 * cannot reproduce that — it would happily "pass" for an implementation that
 * cached a file descriptor, which is the exact bug this design exists to avoid.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  HOST_EXCLUSIVITY_LOCK_DIR_NAME,
  HostExclusivityLeaseGuard,
  LEASE_FILE_MODE,
  evaluateHostExclusivityLease,
  hostExclusivityPlacementGuard,
  lockIsStale,
  nodeLeaseIo,
  parseHostExclusivityLease,
  serializeHostExclusivityLease,
  startHostExclusivityRenewal,
  type LeaseIo,
  type LeaseRenewalResult,
} from "../lease";

let dir: string;
let leasePath: string;

/** Exactly what the provisioning script's `printf` emits, published by `mv`. */
async function publishLease(doc: {
  tenant: string;
  acquiredAtEpochS: number;
  ttlSeconds: number;
  renewedAtEpochS?: number;
}): Promise<void> {
  const body = serializeHostExclusivityLease({
    tenant: doc.tenant,
    acquiredAtEpochS: doc.acquiredAtEpochS,
    ttlSeconds: doc.ttlSeconds,
    renewedAtEpochS: doc.renewedAtEpochS ?? doc.acquiredAtEpochS,
  });
  const temp = path.join(dir, `.lease.${Math.random().toString(16).slice(2)}`);
  await writeFile(temp, body, { mode: 0o600 });
  await rename(temp, leasePath); // the writer's atomic publish
}

function guardFor(
  tenant: string,
  over: { nowMs?: () => number; cacheTtlMs?: number } = {},
): HostExclusivityLeaseGuard {
  return new HostExclusivityLeaseGuard({
    tenant,
    leasePath,
    cacheTtlMs: over.cacheTtlMs ?? 0,
    ...(over.nowMs ? { nowMs: over.nowMs } : {}),
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cinatra-exec-lease-"));
  leasePath = path.join(dir, "host-exclusivity.lease");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

describe("lease document format", () => {
  it("serializes BYTE-IDENTICALLY to the provisioning script's printf", () => {
    // printf '{"tenant":"%s","acquired_at":%s,"ttl_seconds":%s,"renewed_at":%s}\n'
    expect(
      serializeHostExclusivityLease({
        tenant: "acme",
        acquiredAtEpochS: 1700000000,
        ttlSeconds: 3600,
        renewedAtEpochS: 1700000500,
      }),
    ).toBe(
      '{"tenant":"acme","acquired_at":1700000000,"ttl_seconds":3600,"renewed_at":1700000500}\n',
    );
  });

  it("round-trips through the script's own sed expressions", () => {
    const body = serializeHostExclusivityLease({
      tenant: "acme",
      acquiredAtEpochS: 1700000000,
      ttlSeconds: 0,
      renewedAtEpochS: 1700000000,
    });
    // The three extractions the writer performs, transcribed:
    expect(/.*"tenant":"([^"]*)".*/.exec(body)?.[1]).toBe("acme");
    expect(/.*"acquired_at":([0-9]*).*/.exec(body)?.[1]).toBe("1700000000");
    expect(/.*"ttl_seconds":([0-9]*).*/.exec(body)?.[1]).toBe("0");
  });

  it("refuses to write a tenant that is not a slug (JSON-injection guard)", () => {
    expect(() =>
      serializeHostExclusivityLease({
        tenant: 'a","tenant":"b',
        acquiredAtEpochS: 1,
        ttlSeconds: 0,
        renewedAtEpochS: 1,
      }),
    ).toThrow(/tenant/);
  });

  it("parses malformed documents fail-closed", () => {
    expect(parseHostExclusivityLease("not json").ok).toBe(false);
    expect(parseHostExclusivityLease("[]").ok).toBe(false);
    expect(parseHostExclusivityLease('{"tenant":"A_B","acquired_at":1,"ttl_seconds":0}').ok).toBe(
      false,
    );
    expect(parseHostExclusivityLease('{"tenant":"a","ttl_seconds":0}').ok).toBe(false);
    expect(
      parseHostExclusivityLease('{"tenant":"a","acquired_at":1,"ttl_seconds":"x"}').ok,
    ).toBe(false);
  });

  // Codex round 1, finding 2b — the class of documents where JSON.parse and the
  // writer's greedy `sed` DISAGREE. Each of these would previously have been
  // read as ours, or as live, while the writer read it otherwise.
  it("refuses a nested `tenant` the writer's greedy sed would read instead", () => {
    // sed takes the LAST "tenant":"…" on the line: the writer sees "rival".
    const hostile =
      '{"tenant":"acme","acquired_at":1,"ttl_seconds":0,"renewed_at":1,"x":{"tenant":"rival"}}\n';
    expect(/.*"tenant":"([^"]*)".*/.exec(hostile)?.[1]).toBe("rival");
    expect(parseHostExclusivityLease(hostile).ok).toBe(false);
  });

  it("refuses exponent notation the writer would read as a different number", () => {
    // `[0-9]*` captures "1" from "1e3": the writer sees ttl=1, we would see 1000.
    const hostile =
      '{"tenant":"acme","acquired_at":1000,"ttl_seconds":1e3,"renewed_at":1000}\n';
    expect(/.*"ttl_seconds":([0-9]*).*/.exec(hostile)?.[1]).toBe("1");
    expect(parseHostExclusivityLease(hostile).ok).toBe(false);
  });

  it("refuses reordered keys, extra whitespace and a missing newline", () => {
    expect(
      parseHostExclusivityLease(
        '{"acquired_at":1,"tenant":"acme","ttl_seconds":0,"renewed_at":1}\n',
      ).ok,
    ).toBe(false);
    expect(
      parseHostExclusivityLease(
        '{ "tenant":"acme", "acquired_at":1, "ttl_seconds":0, "renewed_at":1 }\n',
      ).ok,
    ).toBe(false);
    expect(
      parseHostExclusivityLease(
        '{"tenant":"acme","acquired_at":1,"ttl_seconds":0,"renewed_at":1}',
      ).ok,
    ).toBe(false);
  });

  it("refuses a lease whose acquired_at + ttl is not exactly representable", () => {
    const hostile = `{"tenant":"acme","acquired_at":${Number.MAX_SAFE_INTEGER},"ttl_seconds":2,"renewed_at":1}\n`;
    expect(parseHostExclusivityLease(hostile).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The check matrix
// ---------------------------------------------------------------------------

describe("check() — the placement precondition", () => {
  it("VALID, same tenant, within TTL ⇒ ok", async () => {
    await publishLease({ tenant: "acme", acquiredAtEpochS: 1000, ttlSeconds: 600 });
    const verdict = await guardFor("acme", { nowMs: () => 1_100_000 }).check();
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.liveThroughEpochS).toBe(1600);
  });

  it("a non-expiring lease (ttl 0) never lapses", async () => {
    await publishLease({ tenant: "acme", acquiredAtEpochS: 1000, ttlSeconds: 0 });
    const verdict = await guardFor("acme", { nowMs: () => 9_999_999_000 }).check();
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.liveThroughEpochS).toBeNull();
  });

  it("ABSENT ⇒ refused", async () => {
    const verdict = await guardFor("acme").check();
    expect(verdict).toMatchObject({ ok: false, reason: "absent" });
  });

  it("EXPIRED ⇒ refused, with the writer's exact boundary", async () => {
    await publishLease({ tenant: "acme", acquiredAtEpochS: 1000, ttlSeconds: 600 });
    // now == acquired_at + ttl is still LIVE (`now > acq + ttl` is strict) —
    // the two sides must never disagree about the same instant.
    expect((await guardFor("acme", { nowMs: () => 1_600_000 }).check()).ok).toBe(true);
    expect(await guardFor("acme", { nowMs: () => 1_601_000 }).check()).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  it("ANOTHER TENANT ⇒ refused, and the refusal names no tenant", async () => {
    await publishLease({ tenant: "other", acquiredAtEpochS: 1000, ttlSeconds: 0 });
    const verdict = await guardFor("acme", { nowMs: () => 1_100_000 }).check();
    expect(verdict).toMatchObject({ ok: false, reason: "other_tenant" });
    if (!verdict.ok) expect(verdict.message).not.toContain("other");
  });

  it("MALFORMED ⇒ refused (never treated as absent, never as ours)", async () => {
    await writeFile(leasePath, "{oops\n");
    expect(await guardFor("acme").check()).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("UNREADABLE ⇒ refused (a lease we cannot prove is not a lease we hold)", async () => {
    // A directory where the lease file should be: readFile fails with EISDIR,
    // which is neither ENOENT nor a parse failure.
    await mkdir(leasePath);
    expect(await guardFor("acme").check()).toMatchObject({ ok: false, reason: "unreadable" });
  });

  it("reads BY PATH, so an atomic replacement is observed immediately", async () => {
    await publishLease({ tenant: "acme", acquiredAtEpochS: 1000, ttlSeconds: 0 });
    const guard = guardFor("acme", { nowMs: () => 1_100_000 });
    expect((await guard.check()).ok).toBe(true);
    // The provisioning side reclaims the host for somebody else: a NEW inode
    // arrives at the same path. A cached fd (or a file bind-mount) would still
    // report the old, reassuring answer.
    await publishLease({ tenant: "rival", acquiredAtEpochS: 1050, ttlSeconds: 0 });
    expect(await guard.check()).toMatchObject({ ok: false, reason: "other_tenant" });
  });

  it("does NOT cache by default — every placement decision re-reads the lease", async () => {
    // Codex round 1, finding 2a. A cached ok verdict is stale about OWNERSHIP,
    // and the window is one in which we would keep placing containers on a host
    // another tenant already holds.
    await publishLease({ tenant: "acme", acquiredAtEpochS: 1000, ttlSeconds: 0 });
    const guard = new HostExclusivityLeaseGuard({
      tenant: "acme",
      leasePath,
      nowMs: () => 1_100_000,
    });
    expect((await guard.check()).ok).toBe(true);
    await publishLease({ tenant: "rival", acquiredAtEpochS: 1050, ttlSeconds: 0 });
    expect(await guard.check()).toMatchObject({ ok: false, reason: "other_tenant" });
  });

  it("the OPT-IN cache bounds staleness about the TENANT but never about EXPIRY", async () => {
    await publishLease({ tenant: "acme", acquiredAtEpochS: 1000, ttlSeconds: 600 });
    let nowMs = 1_100_000;
    const guard = guardFor("acme", { nowMs: () => nowMs, cacheTtlMs: 60_000 });
    expect((await guard.check()).ok).toBe(true);
    // Still inside the cache window, but past the lease's own TTL: the cached
    // DOCUMENT is reused, the VERDICT is recomputed, so this must refuse.
    nowMs = 1_650_000;
    expect(await guard.check()).toMatchObject({ ok: false, reason: "expired" });
  });

  it("a refusal drops the cache, so a re-acquired lease is picked up at once", async () => {
    const nowMs = 1_100_000;
    const guard = guardFor("acme", { nowMs: () => nowMs, cacheTtlMs: 3_600_000 });
    expect(await guard.check()).toMatchObject({ ok: false, reason: "absent" });
    await publishLease({ tenant: "acme", acquiredAtEpochS: 1000, ttlSeconds: 0 });
    expect((await guard.check()).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Renewal
// ---------------------------------------------------------------------------

describe("renew() — under the writer's own mutex", () => {
  it("bumps acquired_at, because that is the ONLY field the writer expires on", async () => {
    await publishLease({ tenant: "acme", acquiredAtEpochS: 1000, ttlSeconds: 600 });
    const result = await guardFor("acme", { nowMs: () => 1_500_000 }).renew();
    expect(result.ok).toBe(true);
    const body = await readFile(leasePath, "utf8");
    const parsed = parseHostExclusivityLease(body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.lease.acquiredAtEpochS).toBe(1500);
    expect(parsed.lease.renewedAtEpochS).toBe(1500);
    // The regression this asserts: bumping ONLY renewed_at would leave
    // acquired_at at 1000, so the writer would still consider the lease expired
    // at 1601 and hand the host to another tenant under live workers.
    expect(body).toContain('"acquired_at":1500');
  });

  it("preserves the TTL rather than inventing one", async () => {
    await publishLease({ tenant: "acme", acquiredAtEpochS: 1000, ttlSeconds: 900 });
    await guardFor("acme", { nowMs: () => 1_100_000 }).renew();
    const parsed = parseHostExclusivityLease(await readFile(leasePath, "utf8"));
    expect(parsed.ok && parsed.lease.ttlSeconds).toBe(900);
  });

  it("writes NOTHING when the lease is another tenant's", async () => {
    await publishLease({ tenant: "rival", acquiredAtEpochS: 1000, ttlSeconds: 0 });
    const before = await readFile(leasePath, "utf8");
    const result = await guardFor("acme", { nowMs: () => 1_100_000 }).renew();
    expect(result).toMatchObject({ ok: false, reason: "other_tenant" });
    expect(await readFile(leasePath, "utf8")).toBe(before);
  });

  it("writes NOTHING when our own lease already expired (no self-resurrection)", async () => {
    await publishLease({ tenant: "acme", acquiredAtEpochS: 1000, ttlSeconds: 60 });
    const before = await readFile(leasePath, "utf8");
    const result = await guardFor("acme", { nowMs: () => 9_000_000 }).renew();
    expect(result).toMatchObject({ ok: false, reason: "expired" });
    expect(await readFile(leasePath, "utf8")).toBe(before);
  });

  it("writes NOTHING when the lease is absent", async () => {
    const result = await guardFor("acme").renew();
    expect(result).toMatchObject({ ok: false, reason: "absent" });
  });

  it("takes the writer's mkdir mutex, and yields when another holder has it", async () => {
    await publishLease({ tenant: "acme", acquiredAtEpochS: 1000, ttlSeconds: 0 });
    const lockDir = path.join(dir, HOST_EXCLUSIVITY_LOCK_DIR_NAME);
    await mkdir(lockDir); // a concurrent provisioning run holds the lock
    const guard = new HostExclusivityLeaseGuard({
      tenant: "acme",
      leasePath,
      cacheTtlMs: 0,
      nowMs: () => 1_100_000,
      // Collapse the bounded spin so the test does not actually wait ~10s. The
      // ATTEMPT COUNT is the contract; the delay is not.
      io: {
        ...(await import("../lease")).nodeLeaseIo,
        sleep: async () => {},
      },
    });
    const result = await guard.renew();
    expect(result).toMatchObject({ ok: false, reason: "lock_unavailable" });
    // The lock is left exactly as the other holder made it.
    await rm(lockDir, { recursive: true, force: true });
  });

  it("releases the mutex on every path, including a refusal", async () => {
    await publishLease({ tenant: "rival", acquiredAtEpochS: 1000, ttlSeconds: 0 });
    await guardFor("acme", { nowMs: () => 1_100_000 }).renew();
    await expect(
      readFile(path.join(dir, HOST_EXCLUSIVITY_LOCK_DIR_NAME)),
    ).rejects.toThrow();
    // And a subsequent renewal can still take it.
    await publishLease({ tenant: "acme", acquiredAtEpochS: 1000, ttlSeconds: 0 });
    expect((await guardFor("acme", { nowMs: () => 1_100_000 }).renew()).ok).toBe(true);
  });

  it("a CONCURRENT atomic mv between our read and our write cannot be stomped", async () => {
    // The realistic race: we decide to renew, and the provisioning side
    // force-reclaims the host for another tenant. Because the read-decide-write
    // section runs under the SAME mutex the writer takes, the reclaim can only
    // land before our read or after our write — never between. Simulate the
    // "before" ordering (the dangerous one) and assert we do not overwrite it.
    await publishLease({ tenant: "acme", acquiredAtEpochS: 1000, ttlSeconds: 0 });
    const guard = new HostExclusivityLeaseGuard({
      tenant: "acme",
      leasePath,
      cacheTtlMs: 0,
      nowMs: () => 1_100_000,
      io: {
        ...(await import("../lease")).nodeLeaseIo,
        readFile: async (filePath: string) => {
          // The reclaim lands just before we read — exactly what holding the
          // mutex guarantees can happen (and all that can happen).
          await publishLease({ tenant: "rival", acquiredAtEpochS: 1090, ttlSeconds: 0 });
          return readFile(filePath, "utf8");
        },
      },
    });
    const result = await guard.renew();
    expect(result).toMatchObject({ ok: false, reason: "other_tenant" });
    const parsed = parseHostExclusivityLease(await readFile(leasePath, "utf8"));
    expect(parsed.ok && parsed.lease.tenant).toBe("rival");
  });
});

// ---------------------------------------------------------------------------
// Ownership handoff (cinatra#2325)
// ---------------------------------------------------------------------------

/**
 * THE ROOT-BROKER CASE, which no in-process test can produce for real: the
 * shipped broker runs as ROOT in a container and renews a lease that lives on a
 * bind-mounted host directory, so its temp file is minted as root while the
 * lease it replaces belongs to the provisioning user. The rename then hands the
 * lease to root and the provisioning side loses REVOKE.
 *
 * This process cannot become root, so the two identities are injected. What is
 * NOT faked is the choreography under test — the real temp file, the real
 * rename, the real refusal ordering.
 */
function ownershipIo(over: {
  /** Identity the LEASE reports (the provisioning side's). */
  lease: { uid: number; gid: number };
  /** Identity a freshly minted TEMP file reports (the broker's). */
  minted: { uid: number; gid: number };
  /** What the filesystem reports AFTER a chown — the point of the re-stat. */
  afterChown?: { uid: number; gid: number };
  chownError?: NodeJS.ErrnoException;
  modeAfterChown?: number;
  calls: { chown: Array<{ path: string; uid: number; gid: number }> };
}): Partial<LeaseIo> {
  let chowned = false;
  return {
    identityOf: async (filePath) => {
      const real = await nodeLeaseIo.identityOf(filePath);
      if (real === null) return null;
      const mode = chowned && over.modeAfterChown !== undefined ? over.modeAfterChown : real.mode;
      if (filePath === leasePath) return { ...over.lease, mode };
      const owner = chowned ? (over.afterChown ?? over.minted) : over.minted;
      return { ...owner, mode };
    },
    chown: async (filePath, uid, gid) => {
      over.calls.chown.push({ path: filePath, uid, gid });
      if (over.chownError) throw over.chownError;
      chowned = true;
    },
  };
}

describe("renew() — the ownership handoff (cinatra#2325)", () => {
  it("gives the replacement the ownership of the lease it replaces", async () => {
    await publishLease({ tenant: "acme", acquiredAtEpochS: 1000, ttlSeconds: 3600 });
    const calls = { chown: [] as Array<{ path: string; uid: number; gid: number }> };
    const guard = new HostExclusivityLeaseGuard({
      tenant: "acme",
      leasePath,
      cacheTtlMs: 0,
      nowMs: () => 1_100_000,
      io: {
        ...nodeLeaseIo,
        ...ownershipIo({
          lease: { uid: 1000, gid: 1000 },
          minted: { uid: 0, gid: 0 },
          afterChown: { uid: 1000, gid: 1000 },
          calls,
        }),
      },
    });
    expect((await guard.renew()).ok).toBe(true);
    // The chown targeted the TEMP file, never the lease path: the handoff is
    // part of the atomic publish, so the lease is never once observed carrying
    // an owner the provisioning side cannot use.
    expect(calls.chown).toHaveLength(1);
    expect(calls.chown[0]).toMatchObject({ uid: 1000, gid: 1000 });
    expect(calls.chown[0]?.path).not.toBe(leasePath);
    // ...and the document really was republished.
    const parsed = parseHostExclusivityLease(await readFile(leasePath, "utf8"));
    expect(parsed.ok && parsed.lease.acquiredAtEpochS).toBe(1100);
  });

  it("does not chown at all when the identities already agree", async () => {
    // Docker Desktop's file sharing maps a bind mount to the container's own
    // identity, so the broker sees its own uid on the provisioning side's file.
    // An unsupported chown must not be able to fail a renewal that never needed
    // one — which is why the call is conditional rather than unconditional.
    await publishLease({ tenant: "acme", acquiredAtEpochS: 1000, ttlSeconds: 3600 });
    const calls = { chown: [] as Array<{ path: string; uid: number; gid: number }> };
    const guard = new HostExclusivityLeaseGuard({
      tenant: "acme",
      leasePath,
      cacheTtlMs: 0,
      nowMs: () => 1_100_000,
      io: {
        ...nodeLeaseIo,
        ...ownershipIo({
          lease: { uid: 0, gid: 0 },
          minted: { uid: 0, gid: 0 },
          chownError: Object.assign(new Error("EOPNOTSUPP"), { code: "EOPNOTSUPP" }),
          calls,
        }),
      },
    });
    expect((await guard.renew()).ok).toBe(true);
    expect(calls.chown).toHaveLength(0);
  });

  it("REFUSES when chown reports success but the ownership did not move", async () => {
    // The adversarial case, and the reason the handoff is verified by a re-stat
    // rather than by chown's return value: CIFS without unix extensions, and
    // some FUSE/virtiofs layers, accept the call and keep reporting their own
    // mapping. Trusting the return value publishes the root-owned lease while
    // reporting a healthy renewal.
    await publishLease({ tenant: "acme", acquiredAtEpochS: 1000, ttlSeconds: 3600 });
    const before = await readFile(leasePath, "utf8");
    const calls = { chown: [] as Array<{ path: string; uid: number; gid: number }> };
    const guard = new HostExclusivityLeaseGuard({
      tenant: "acme",
      leasePath,
      cacheTtlMs: 0,
      nowMs: () => 1_100_000,
      io: {
        ...nodeLeaseIo,
        ...ownershipIo({
          lease: { uid: 1000, gid: 1000 },
          minted: { uid: 0, gid: 0 },
          afterChown: { uid: 0, gid: 0 }, // the call "succeeded" and changed nothing
          calls,
        }),
      },
    });
    const result = await guard.renew();
    expect(result).toMatchObject({ ok: false, reason: "write_failed" });
    expect(calls.chown).toHaveLength(1);
    // NOTHING was published — the existing lease is byte-identical.
    expect(await readFile(leasePath, "utf8")).toBe(before);
    // ...and no temp file was left behind in the lease directory.
    expect((await readdir(dir)).filter((n) => n.startsWith(".lease."))).toEqual([]);
  });

  it("REFUSES, typed and not thrown, when chown itself fails", async () => {
    await publishLease({ tenant: "acme", acquiredAtEpochS: 1000, ttlSeconds: 3600 });
    const before = await readFile(leasePath, "utf8");
    const calls = { chown: [] as Array<{ path: string; uid: number; gid: number }> };
    const guard = new HostExclusivityLeaseGuard({
      tenant: "acme",
      leasePath,
      cacheTtlMs: 0,
      nowMs: () => 1_100_000,
      io: {
        ...nodeLeaseIo,
        ...ownershipIo({
          lease: { uid: 1000, gid: 1000 },
          minted: { uid: 0, gid: 0 },
          chownError: Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
          calls,
        }),
      },
    });
    const result = await guard.renew();
    expect(result).toMatchObject({ ok: false, reason: "write_failed" });
    expect(await readFile(leasePath, "utf8")).toBe(before);
    expect((await readdir(dir)).filter((n) => n.startsWith(".lease."))).toEqual([]);
    // The mutex is released even on this path.
    expect((await readdir(dir)).includes(HOST_EXCLUSIVITY_LOCK_DIR_NAME)).toBe(false);
  });

  it("REFUSES when the replacement's mode is not the canonical 0600", async () => {
    // A broker started under a restrictive umask would publish a lease its own
    // provisioning user cannot rewrite. The mode is asserted, not requested.
    await publishLease({ tenant: "acme", acquiredAtEpochS: 1000, ttlSeconds: 3600 });
    const before = await readFile(leasePath, "utf8");
    const calls = { chown: [] as Array<{ path: string; uid: number; gid: number }> };
    const guard = new HostExclusivityLeaseGuard({
      tenant: "acme",
      leasePath,
      cacheTtlMs: 0,
      nowMs: () => 1_100_000,
      io: {
        ...nodeLeaseIo,
        ...ownershipIo({
          lease: { uid: 1000, gid: 1000 },
          minted: { uid: 0, gid: 0 },
          afterChown: { uid: 1000, gid: 1000 },
          modeAfterChown: 0o400,
          calls,
        }),
      },
    });
    expect(await guard.renew()).toMatchObject({ ok: false, reason: "write_failed" });
    expect(await readFile(leasePath, "utf8")).toBe(before);
  });

  it("publishes the canonical 0600 against the real filesystem", async () => {
    await publishLease({ tenant: "acme", acquiredAtEpochS: 1000, ttlSeconds: 3600 });
    // The lease starts WIDER than canonical, exactly as a hand-provisioned file
    // might; the renewal narrows it and never widens it.
    await chmod(leasePath, 0o644);
    expect((await guardFor("acme", { nowMs: () => 1_100_000 }).renew()).ok).toBe(true);
    expect((await stat(leasePath)).mode & 0o777).toBe(LEASE_FILE_MODE);
    // Same-process renewal ⇒ same uid; the assertion that matters on a real
    // cross-identity host is the E2E battery's, which runs a ROOT container.
    expect((await stat(leasePath)).uid).toBe(process.getuid?.());
  });

  it("renew() is TOTAL: an injected I/O rejection becomes a typed refusal", async () => {
    // A renewal that threw would bypass the caller's reporting entirely.
    await publishLease({ tenant: "acme", acquiredAtEpochS: 1000, ttlSeconds: 3600 });
    const guard = new HostExclusivityLeaseGuard({
      tenant: "acme",
      leasePath,
      cacheTtlMs: 0,
      nowMs: () => 1_100_000,
      io: {
        ...nodeLeaseIo,
        identityOf: async () => {
          throw Object.assign(new Error("stat is not supported here"), { code: "EIO" });
        },
      },
    });
    await expect(guard.renew()).resolves.toMatchObject({
      ok: false,
      reason: "write_failed",
    });
  });

  it("the renewal timer REPORTS a rejection instead of swallowing it", async () => {
    const seen: LeaseRenewalResult[] = [];
    const stop = startHostExclusivityRenewal(
      { renew: async () => Promise.reject(new Error("the guard blew up")) },
      5,
      (result) => seen.push(result),
    );
    // Give the interval a few chances to fire.
    await new Promise((resolve) => setTimeout(resolve, 60));
    stop();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toMatchObject({ ok: false, reason: "write_failed" });
    expect(seen[0]?.ok === false && seen[0].message).toContain("the guard blew up");
  });

  it("a reporter that throws does not take the renewal timer with it", async () => {
    let calls = 0;
    const stop = startHostExclusivityRenewal(
      {
        renew: async () => ({
          ok: false as const,
          reason: "absent" as const,
          message: "no lease",
        }),
      },
      5,
      () => {
        calls += 1;
        throw new Error("the logger is broken");
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    stop();
    expect(calls).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Projection onto the broker's seam
// ---------------------------------------------------------------------------

describe("the writer's own predicates, reproduced", () => {
  it("stale-lock reclaim matches `find -mmin +1`, which fires at ~120s not 60s", () => {
    // Codex round 1, finding 4. Reclaiming at 60s would let this process delete
    // a lock a legitimate 61–119s shell critical section still holds.
    expect(lockIsStale(59_000)).toBe(false);
    expect(lockIsStale(61_000)).toBe(false);
    expect(lockIsStale(119_000)).toBe(false);
    expect(lockIsStale(120_000)).toBe(true);
    expect(lockIsStale(600_000)).toBe(true);
  });

  it("the expiry boundary is the writer's own, and the field is named for it", () => {
    const lease = {
      tenant: "acme",
      acquiredAtEpochS: 100,
      ttlSeconds: 10,
      renewedAtEpochS: 100,
    };
    const live = evaluateHostExclusivityLease(lease, "acme", 110);
    expect(live.ok).toBe(true);
    // 110 is the LAST live second — `now > acq + ttl` is strict on both sides.
    if (live.ok) expect(live.liveThroughEpochS).toBe(110);
    expect(evaluateHostExclusivityLease(lease, "acme", 111).ok).toBe(false);
  });
});

describe("hostExclusivityPlacementGuard", () => {
  it("projects a verdict without leaking the tenant or the path", async () => {
    await publishLease({ tenant: "rival", acquiredAtEpochS: 1000, ttlSeconds: 0 });
    const verdict = await hostExclusivityPlacementGuard(
      guardFor("acme", { nowMs: () => 1_100_000 }),
    )();
    expect(verdict).toMatchObject({ ok: false, reason: "host_exclusivity_other_tenant" });
    if (!verdict.ok) {
      expect(verdict.message).not.toContain(dir);
      expect(verdict.message).not.toContain("rival");
    }
  });

  it("passes a held lease straight through", async () => {
    await publishLease({ tenant: "acme", acquiredAtEpochS: 1000, ttlSeconds: 0 });
    await expect(
      hostExclusivityPlacementGuard(guardFor("acme", { nowMs: () => 1_100_000 }))(),
    ).resolves.toEqual({ ok: true });
  });
});
