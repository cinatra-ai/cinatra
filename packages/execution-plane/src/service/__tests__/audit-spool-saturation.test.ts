/**
 * THE SATURATION STATE MACHINE (cinatra#2266 design gap G5, AC7).
 *
 * The property under test, in one sentence: a permanently-full audit spool
 * produces ONE bounded `audit_spool_full` episode instead of an unbounded
 * stream of refusal records, refuses every further admission WITHOUT writing
 * anything, and reopens on a defined condition.
 *
 * EVERY ARM DRIVES THE REAL FILE SPOOL against a real directory and asserts on
 * the FILE and on the spool's own exported constants — never on a number the
 * test invented, and never on a hand-written double. The issue's own words for
 * the AC are "test past the reserve, not merely the first refusal", so the arms
 * below drive hundreds of refusals past the point of saturation and count what
 * landed on disk.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUDIT_SPOOL_EPISODE_FIELD_CHARS,
  AUDIT_SPOOL_EPISODE_RESERVE_BYTES,
  AUDIT_SPOOL_FULL_REASON,
  AUDIT_SPOOL_MIN_MAX_BYTES,
  AUDIT_SPOOL_RESUME_HEADROOM_MULTIPLE,
  AUDIT_SPOOL_RESUME_RATIO,
  AUDIT_SPOOL_TERMINAL_HEADROOM_BYTES,
  AuditSpoolFullError,
  AuditSpoolRecordTooLargeError,
  openAuditSpool,
  type AuditSpool,
} from "../audit-spool";
import { DEFAULT_SANDBOX_LIMITS, type ExecutionAuditRecord } from "../../types";

/**
 * REAL FSYNCS NEED A REAL TIMEOUT, and the default 5 s one is not a statement
 * about correctness — it is a statement about how loaded the host is.
 *
 * Every arm below drives the spool's actual durability path: `fsync` on the log,
 * `fsync` on the directory, an atomic rename per watermark write. That is the
 * behaviour under test, so it cannot be stubbed out to go faster. On a busy
 * machine those syscalls are tens of milliseconds each and a single arm issues
 * dozens, which put several arms within noise of the 5 s ceiling and made them
 * flake — as TIMEOUTS, never as wrong assertions.
 *
 * The ceiling is raised rather than the fsyncs removed, because a spool that
 * does not fsync is exactly the defect cinatra#2266 exists to fix. A genuine
 * hang still fails, just later.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });


const dirs: string[] = [];
const open: AuditSpool[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cinatra-audit-saturation-"));
  dirs.push(dir);
  return dir;
}

function spool(dir: string, maxBytes?: number): AuditSpool {
  const s = openAuditSpool({ dir, ...(maxBytes === undefined ? {} : { maxBytes }) });
  open.push(s);
  return s;
}

afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const record = (
  jobId: string,
  seq: number,
  over: Partial<ExecutionAuditRecord> = {},
): ExecutionAuditRecord => ({
  jobId,
  orgId: "org-1",
  userId: "user-1",
  surface: "agent_run",
  runId: "run-1",
  command: "echo hi",
  cwd: "/workspace",
  seq,
  decision: "outcome_unknown",
  effectivePolicy: { egressMode: "none", limits: DEFAULT_SANDBOX_LIMITS },
  atMs: 1_700_000_000_000,
  ...over,
});

const logPath = (dir: string): string => path.join(dir, "audit-spool.log");

/** Byte size of the log file, or 0 before the first append has created it. */
function logBytes(dir: string): number {
  try {
    return statSync(logPath(dir)).size;
  } catch {
    return 0;
  }
}

/** Every raw frame LINE on disk, exactly as the spool encoded it. */
function frameLines(dir: string): string[] {
  try {
    return readFileSync(logPath(dir), "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** Every deliverable record currently on the FILE, decoded from its frames. */
function recordsOnDisk(dir: string): ExecutionAuditRecord[] {
  return frameLines(dir)
    .map((line) => JSON.parse(line.slice(17)) as { kind: string; record: ExecutionAuditRecord })
    .filter((frame) => frame.kind === "record")
    .map((frame) => frame.record);
}

/**
 * The ENCODED size, in bytes on disk, of every frame whose record is a
 * saturation episode. This — not a count of records — is what the reserve makes
 * a claim about, so it is what the bound arm asserts against.
 */
function episodeFrameBytes(dir: string): number[] {
  return frameLines(dir)
    .filter((line) => {
      const frame = JSON.parse(line.slice(17)) as {
        kind: string;
        record?: ExecutionAuditRecord;
      };
      return frame.kind === "record" && frame.record?.reason === AUDIT_SPOOL_FULL_REASON;
    })
    // +1 for the newline the encoder terminates every frame with, which the
    // split above removed and which occupies a byte on the volume.
    .map((line) => Buffer.byteLength(line, "utf8") + 1);
}

/**
 * A bound with room for a couple of reservations and no more. Derived from the
 * module's own constants so it cannot drift when either moves.
 */
const TIGHT_MAX_BYTES = AUDIT_SPOOL_EPISODE_RESERVE_BYTES + 3 * AUDIT_SPOOL_TERMINAL_HEADROOM_BYTES;

/** Drive reservations until one is refused; returns how many were admitted. */
async function reserveUntilFull(s: AuditSpool, limit = 500): Promise<number> {
  for (let i = 0; i < limit; i += 1) {
    try {
      await s.reserve(record(`job-${i}`, i));
    } catch (err) {
      expect(err).toBeInstanceOf(AuditSpoolFullError);
      return i;
    }
  }
  throw new Error("the spool never saturated — the bound is too generous for this arm");
}

/**
 * Drive reserve+COMMIT cycles until one is refused; returns how many committed.
 *
 * The difference from `reserveUntilFull` above is load bearing wherever a
 * RESTART is involved. An open reservation's headroom is an in-MEMORY claim: a
 * restart resolves the reservation into a terminal `outcome_unknown` record and
 * the headroom is released, so a spool saturated purely by in-flight commands
 * legitimately has room again on the next boot. Committed records are BYTES ON
 * THE VOLUME, and those are what a restart inherits.
 */
async function commitUntilFull(s: AuditSpool, limit = 500): Promise<number> {
  for (let i = 0; i < limit; i += 1) {
    let reservation;
    try {
      reservation = await s.reserve(record(`job-${i}`, i));
    } catch (err) {
      expect(err).toBeInstanceOf(AuditSpoolFullError);
      return i;
    }
    await reservation.commit(record(`job-${i}`, i, { decision: "executed" }));
  }
  throw new Error("the spool never saturated — the bound is too generous for this arm");
}

describe("audit spool saturation — ONE episode, not one record per attempt", () => {
  it("opens exactly one episode and writes exactly one audit_spool_full record, past the reserve", async () => {
    const dir = tempDir();
    const s = spool(dir, TIGHT_MAX_BYTES);
    const admitted = await reserveUntilFull(s);
    // NONZERO MINIMUM: an arm in which nothing was ever admitted would be
    // asserting against a spool that refused everything from the first byte.
    expect(admitted).toBeGreaterThanOrEqual(1);

    expect(s.stats().saturation.state).toBe("saturated");
    const episodeId = s.stats().saturation.episode?.id;
    expect(episodeId).toMatch(new RegExp(`^${s.spoolId}:episode:1$`));

    // PAST THE RESERVE, which is the AC's own instruction: hundreds of further
    // attempts, none of which may mint a record.
    for (let i = 0; i < 500; i += 1) {
      const verdict = s.admission();
      expect(verdict.admitted).toBe(false);
      if (!verdict.admitted) expect(verdict.episodeId).toBe(episodeId);
    }

    const episodeRecords = recordsOnDisk(dir).filter(
      (r) => r.reason === AUDIT_SPOOL_FULL_REASON,
    );
    expect(episodeRecords).toHaveLength(1);
    expect(episodeRecords[0]?.decision).toBe("refused");
    expect(episodeRecords[0]?.spoolEpisode?.id).toBe(episodeId);
    // The counter moved for all 500 + the reservation that opened the episode.
    expect(s.stats().saturation.episode?.refused).toBe(501);
    // And the whole file is still inside its declared bound.
    expect(logBytes(dir)).toBeLessThanOrEqual(TIGHT_MAX_BYTES);
  });

  it("a further RESERVATION while saturated still mints no second episode record", async () => {
    // The admission gate is the broker's first line, but the reservation path
    // is reachable directly (and by a racing caller), so the "one record per
    // episode" rule has to hold there too — not only on the gate.
    const dir = tempDir();
    const s = spool(dir, TIGHT_MAX_BYTES);
    await reserveUntilFull(s);
    for (let i = 0; i < 40; i += 1) {
      await expect(s.reserve(record(`late-${i}`, i))).rejects.toBeInstanceOf(AuditSpoolFullError);
    }
    expect(
      recordsOnDisk(dir).filter((r) => r.reason === AUDIT_SPOOL_FULL_REASON),
    ).toHaveLength(1);
    expect(s.stats().saturation.episodes).toBe(1);
  });

  it("the episode record is the ONLY record a saturated spool adds — nothing else lands", async () => {
    const dir = tempDir();
    const s = spool(dir, TIGHT_MAX_BYTES);
    const before = recordsOnDisk(dir).length;
    await reserveUntilFull(s);
    const afterSaturation = recordsOnDisk(dir).length;
    for (let i = 0; i < 200; i += 1) s.admission();
    expect(recordsOnDisk(dir).length).toBe(afterSaturation);
    // Exactly one record more than the admitted reservations produced.
    expect(afterSaturation - before).toBe(1);
  });
});

describe("audit spool saturation — the episode record's own bound", () => {
  it("fits inside the episode reserve even for hostile, escaping identifiers", async () => {
    // The reserve is a FIXED number of bytes and the record it must hold is
    // built from caller-supplied identifiers. `JSON.stringify` escapes a
    // control character to six bytes and a non-BMP character costs more than
    // one code unit, so this arm drives the worst case the caps allow and
    // asserts the ENCODED FRAME against the module's own constant — not the
    // file's total size, about which the reserve makes no claim.
    const dir = tempDir();
    // A bound generous enough that a HOSTILE prepared record (six identity
    // fields of ~30 KiB each BEFORE the episode record's caps apply, plus an
    // unbounded command) is admitted at least once. An arm in which nothing was
    // ever admitted would be asserting against a spool that refused its first
    // byte, which is not what this arm discriminates.
    const roomyMaxBytes = AUDIT_SPOOL_EPISODE_RESERVE_BYTES + 1024 * 1024;
    const s = spool(dir, roomyMaxBytes);
    // U+0001 escapes to six JSON bytes; U+1F4A9 is two code units and four
    // UTF-8 bytes. Repeated well past the per-field cap on purpose, so the arm
    // drives the worst case the caps allow rather than a friendly ASCII id.
    const hostile = "\u0001\u{1F4A9}".repeat(2 * AUDIT_SPOOL_EPISODE_FIELD_CHARS);
    const sizeBefore = logBytes(dir);
    // Admit until full using hostile ids, so the episode record is built from one.
    let admitted = 0;
    for (let i = 0; i < 500; i += 1) {
      try {
        await s.reserve(
          record(hostile, i, {
            orgId: hostile,
            userId: hostile,
            surface: hostile,
            runId: hostile,
            cwd: hostile,
            // The UNBOUNDED field, driven at a size no fixed reserve could
            // absorb — so a truncation rather than a drop would still show.
            command: "x".repeat(64 * 1024),
          }),
        );
        admitted += 1;
      } catch (err) {
        expect(err).toBeInstanceOf(AuditSpoolFullError);
        break;
      }
    }
    expect(admitted).toBeGreaterThanOrEqual(1);

    const episode = recordsOnDisk(dir).filter((r) => r.reason === AUDIT_SPOOL_FULL_REASON);
    expect(episode).toHaveLength(1);
    // Every identity field is capped, so the record cannot be grown by its input.
    for (const field of [
      episode[0]!.jobId,
      episode[0]!.orgId,
      episode[0]!.userId,
      episode[0]!.surface,
      episode[0]!.runId ?? "",
      episode[0]!.cwd,
    ]) {
      expect(field.length).toBeLessThanOrEqual(AUDIT_SPOOL_EPISODE_FIELD_CHARS);
    }
    // The command text is dropped outright — it is the unbounded field, driven
    // at 64 KiB above precisely so that a truncation would still be visible.
    expect(episode[0]!.command).toBe("");
    // THE LOAD-BEARING ASSERTION: the frame that actually landed on the volume
    // fits inside the bytes admission held back for it. On the FILE, against
    // the module's own constant, for the worst input the caps allow.
    const episodeBytes = episodeFrameBytes(dir);
    expect(episodeBytes).toHaveLength(1);
    expect(episodeBytes[0]!).toBeGreaterThan(0);
    expect(episodeBytes[0]!).toBeLessThanOrEqual(AUDIT_SPOOL_EPISODE_RESERVE_BYTES);
    expect(logBytes(dir)).toBeLessThanOrEqual(roomyMaxBytes);
    expect(logBytes(dir)).toBeGreaterThan(sizeBefore);
  });

  it("holds the episode reserve back from ADMISSION, so a full spool still has room to say so", async () => {
    const dir = tempDir();
    const s = spool(dir, TIGHT_MAX_BYTES);
    const stats = s.stats();
    expect(stats.admissionBytes).toBe(TIGHT_MAX_BYTES - AUDIT_SPOOL_EPISODE_RESERVE_BYTES);
    // BOTH terms of the low-water mark, and the SMALLER wins. On this
    // deliberately tight bound the ABSOLUTE term binds — which is exactly the
    // configuration the ratio alone would get wrong (see the module's own
    // arithmetic), so this arm discriminates the two rather than restating one.
    expect(stats.resumeBytes).toBe(
      Math.min(
        Math.floor(stats.admissionBytes * AUDIT_SPOOL_RESUME_RATIO),
        stats.admissionBytes -
          AUDIT_SPOOL_RESUME_HEADROOM_MULTIPLE * AUDIT_SPOOL_TERMINAL_HEADROOM_BYTES,
      ),
    );
    expect(stats.resumeBytes).toBeLessThan(
      Math.floor(stats.admissionBytes * AUDIT_SPOOL_RESUME_RATIO),
    );
    await reserveUntilFull(s);
    // Occupancy is past the ADMISSION bound and the episode record still landed
    // — that is the reserve doing its job, asserted on the file.
    expect(recordsOnDisk(dir).filter((r) => r.reason === AUDIT_SPOOL_FULL_REASON)).toHaveLength(1);
    // ...and it landed PAST the admission bound: the file now holds more than
    // admission would ever have accepted, which is the reserve's whole claim.
    expect(logBytes(dir)).toBeGreaterThan(0);
    expect(episodeFrameBytes(dir)[0]!).toBeLessThanOrEqual(AUDIT_SPOOL_EPISODE_RESERVE_BYTES);
  });
});

describe("audit spool saturation — recovery, and the flap the low-water mark prevents", () => {
  it("reopens admission once an ACK brings occupancy under the low-water mark", async () => {
    const dir = tempDir();
    const s = spool(dir, TIGHT_MAX_BYTES);
    // Fill with COMMITTED records rather than open reservations: a committed
    // record can be acknowledged away, which is the only thing that frees space.
    const committed = await commitUntilFull(s);
    expect(committed).toBeGreaterThanOrEqual(2);
    expect(s.stats().saturation.state).toBe("saturated");
    expect(s.admission().admitted).toBe(false);

    // ACK the whole spooled prefix: occupancy collapses and admission reopens.
    const batch = s.read();
    expect(batch.entries.length).toBeGreaterThan(0);
    const acked = await s.ack({ spoolId: s.spoolId, head: batch.head });
    expect(acked.ok).toBe(true);

    const after = s.stats().saturation;
    expect(after.state).toBe("open");
    expect(after.lastEpisode?.closedAtMs).toBeGreaterThan(0);
    expect(after.lastEpisode?.refused).toBeGreaterThanOrEqual(1);
    expect(s.admission().admitted).toBe(true);
    // And the plane genuinely works again — the recovery is proven by a real
    // reservation, not by the state field alone.
    const revived = await s.reserve(record("job-after-recovery", 0));
    await expect(
      revived.commit(record("job-after-recovery", 0, { decision: "executed" })),
    ).resolves.toBeUndefined();
  });

  it("does NOT reopen on a partial ACK that leaves occupancy above the mark — no episode flap", async () => {
    // Without hysteresis, freeing one frame would reopen admission, the next
    // command would re-saturate, and each cycle would mint another episode
    // record — the unbounded write G5 exists to prevent, reintroduced by the
    // recovery path. This arm is what discriminates a low-water mark from a
    // "there is room again" check.
    const dir = tempDir();
    const s = spool(dir, TIGHT_MAX_BYTES);
    expect(await commitUntilFull(s)).toBeGreaterThanOrEqual(2);
    expect(s.stats().saturation.state).toBe("saturated");

    // ACK exactly ONE record. Occupancy falls a little; the mark is not reached.
    const first = s.read(1);
    expect(first.entries).toHaveLength(1);
    const acked = await s.ack({ spoolId: s.spoolId, head: first.head });
    expect(acked.ok).toBe(true);
    expect(acked.ok && acked.removed).toBeGreaterThan(0);
    // Occupancy fell — but not to the mark, which is the whole hysteresis.
    expect(s.stats().bytes).toBeGreaterThan(s.stats().resumeBytes);
    expect(s.stats().saturation.state).toBe("saturated");
    expect(s.stats().saturation.episodes).toBe(1);
    // Still exactly one episode record on disk after the partial recovery.
    expect(recordsOnDisk(dir).filter((r) => r.reason === AUDIT_SPOOL_FULL_REASON)).toHaveLength(1);
  });
});

describe("audit spool saturation — across a RESTART", () => {
  it("a still-full spool reopens under the SAME episode and mints no second record", async () => {
    // The failure this closes: a broker crash-looping against a full spool
    // would otherwise mint one `audit_spool_full` record per boot, turning the
    // bounded episode back into an unbounded write.
    const dir = tempDir();
    const first = spool(dir, TIGHT_MAX_BYTES);
    // COMMITTED, not merely reserved: the bytes have to be on the volume for
    // the restart to inherit the condition (see `commitUntilFull`).
    expect(await commitUntilFull(first)).toBeGreaterThanOrEqual(2);
    const episodeId = first.stats().saturation.episode?.id;
    expect(episodeId).toBeTruthy();
    for (let i = 0; i < 30; i += 1) first.admission();
    const refusedBefore = first.stats().saturation.episode?.refused ?? 0;
    expect(refusedBefore).toBeGreaterThan(1);
    await first.close();
    open.splice(open.indexOf(first), 1);

    const reopened = spool(dir, TIGHT_MAX_BYTES);
    // Same volume, same spool identity, same OPEN episode.
    expect(reopened.spoolId).toBe(first.spoolId);
    expect(reopened.stats().saturation.state).toBe("saturated");
    expect(reopened.stats().saturation.episode?.id).toBe(episodeId);
    // The counter survived the clean close (it is checkpointed, see the module).
    expect(reopened.stats().saturation.episode?.refused).toBe(refusedBefore);
    // AND — the load-bearing assertion — still exactly ONE episode record after
    // the restart, where a naive implementation would have minted a second.
    expect(recordsOnDisk(dir).filter((r) => r.reason === AUDIT_SPOOL_FULL_REASON)).toHaveLength(1);
    expect(reopened.admission().admitted).toBe(false);
    // A THIRD boot, still full: the count of episode records does not grow with
    // the number of restarts, which is the crash-loop this arm exists for.
    await reopened.close();
    open.splice(open.indexOf(reopened), 1);
    const third = spool(dir, TIGHT_MAX_BYTES);
    expect(third.stats().saturation.state).toBe("saturated");
    expect(third.stats().saturation.episodes).toBe(1);
    expect(recordsOnDisk(dir).filter((r) => r.reason === AUDIT_SPOOL_FULL_REASON)).toHaveLength(1);
  });

  it("a spool saturated only by IN-FLIGHT commands reopens at boot — the headroom did not survive", async () => {
    // The other direction, and it is not a weakening: an open reservation's
    // headroom is an in-memory claim on behalf of a command that is now gone.
    // The restart resolves each one into a terminal `outcome_unknown` record
    // (the G1 crash contract) and the claim is released, so the volume really
    // does have room. Inheriting the episode here would refuse commands a
    // healthy spool could account for — a routing-bug-shaped outage.
    const dir = tempDir();
    const first = spool(dir, TIGHT_MAX_BYTES);
    const admitted = await reserveUntilFull(first);
    expect(admitted).toBeGreaterThanOrEqual(1);
    expect(first.stats().saturation.state).toBe("saturated");
    await first.close();
    open.splice(open.indexOf(first), 1);

    const reopened = spool(dir, TIGHT_MAX_BYTES);
    expect(reopened.stats().saturation.state).toBe("open");
    expect(reopened.stats().saturation.lastEpisode?.closedAtMs).toBeGreaterThan(0);
    expect(reopened.admission().admitted).toBe(true);
    // The in-flight commands are not silently forgotten — each is on the volume
    // as an explicit `outcome_unknown`, which is what freed the headroom.
    expect(recordsOnDisk(dir).filter((r) => r.decision === "outcome_unknown")).toHaveLength(
      admitted,
    );
  });

  it("a spool that regained room reopens admission at boot rather than inheriting the episode", async () => {
    const dir = tempDir();
    const first = spool(dir, TIGHT_MAX_BYTES);
    expect(await commitUntilFull(first)).toBeGreaterThanOrEqual(2);
    expect(first.stats().saturation.state).toBe("saturated");
    await first.close();
    open.splice(open.indexOf(first), 1);

    // An operator raised the bound. The persisted episode must not outlive the
    // condition that justified it.
    const reopened = spool(dir, 64 * 1024 * 1024);
    expect(reopened.stats().saturation.state).toBe("open");
    expect(reopened.stats().saturation.lastEpisode?.closedAtMs).toBeGreaterThan(0);
    expect(reopened.admission().admitted).toBe(true);
  });

  it("refuses to open on an unreadable saturation state rather than minting a fresh episode", async () => {
    const dir = tempDir();
    const s = spool(dir, TIGHT_MAX_BYTES);
    await commitUntilFull(s);
    await s.close();
    open.splice(open.indexOf(s), 1);

    // Corrupt the state file. Reading it as "never saturated" is the dangerous
    // direction — it is what would restart the episode counter and re-mint.
    const statePath = path.join(dir, "audit-spool.episode.json");
    rmSync(statePath, { force: true });
    (await import("node:fs")).writeFileSync(statePath, "{not json", "utf8");
    expect(() => openAuditSpool({ dir, maxBytes: TIGHT_MAX_BYTES })).toThrow(
      /saturation state .* unreadable/,
    );
  });
});

// ---------------------------------------------------------------------------
// The three holes the slice-3 review found. Each arm FAILS without its fix.
// ---------------------------------------------------------------------------

describe("audit spool saturation — an oversized record is REFUSED, not saturation", () => {
  it("does not latch the spool on a command whose record could never fit", async () => {
    // THE LATCH (Codex convergence, adopted). A record too large for the whole
    // admission bound used to open an episode. The episode record is tiny, so
    // occupancy sat far below the low-water mark — and nothing re-evaluates the
    // reopen condition on the way IN to saturation, so the spool stayed
    // saturated with almost nothing in it, refusing every OTHER command until
    // the broker was restarted. One command could take the plane down.
    const dir = tempDir();
    const s = spool(dir, TIGHT_MAX_BYTES);

    const huge = record("job-huge", 1, { command: "x".repeat(TIGHT_MAX_BYTES) });
    await expect(s.reserve(huge)).rejects.toBeInstanceOf(AuditSpoolRecordTooLargeError);

    // NOT saturation: no episode, no episode record, and nothing on disk.
    expect(s.stats().saturation.state).toBe("open");
    expect(s.stats().saturation.episodes).toBe(0);
    expect(recordsOnDisk(dir).filter((r) => r.reason === AUDIT_SPOOL_FULL_REASON)).toHaveLength(0);
    // It IS counted as a refused reservation — the command did not run.
    expect(s.stats().refusedReservations).toBe(1);

    // And the plane is still open for business, which is the property the latch
    // destroyed: an ordinary command is admitted immediately afterwards.
    const ok = await s.reserve(record("job-normal", 2));
    expect(ok.deliveryKey).toContain(s.spoolId);
    await ok.commit(record("job-normal", 2, { decision: "executed" }));
    expect(s.stats().saturation.state).toBe("open");
  });

  it("still saturates on the ordinary case — records that WOULD fit in an empty spool", async () => {
    // The negative control for the arm above: the fix must not have turned real
    // saturation into a per-command refusal.
    const dir = tempDir();
    const s = spool(dir, TIGHT_MAX_BYTES);
    const admitted = await reserveUntilFull(s);
    expect(admitted).toBeGreaterThan(0);
    expect(s.stats().saturation.state).toBe("saturated");
    expect(recordsOnDisk(dir).filter((r) => r.reason === AUDIT_SPOOL_FULL_REASON)).toHaveLength(1);
  });
});

describe("audit spool saturation — a bound too small to work is refused at OPEN", () => {
  it("refuses a maxBytes below the floor rather than admitting nothing", async () => {
    // `EXEC_AUDIT_SPOOL_MAX_BYTES` accepted any positive number, and the clamp
    // turned a too-small one into an admission bound of ZERO: a broker that
    // boots healthy, refuses the first command it is ever given, and cannot
    // even write the record that says why.
    const dir = tempDir();
    expect(() => openAuditSpool({ dir, maxBytes: 1 })).toThrow(/below the .* minimum/);
    expect(() => openAuditSpool({ dir, maxBytes: AUDIT_SPOOL_MIN_MAX_BYTES - 1 })).toThrow(
      /below the .* minimum/,
    );
    // Nothing was created on the volume by a refused open.
    expect(frameLines(dir)).toHaveLength(0);
  });

  it("refuses a NON-FINITE bound — NaN and Infinity both slipped past the floor", async () => {
    // `NaN < MIN` is false and `Infinity` is genuinely greater, so neither was
    // caught by the floor alone — and each disables the capacity checks the
    // bound exists for (every comparison against NaN is false).
    const dir = tempDir();
    expect(() => openAuditSpool({ dir, maxBytes: Number.NaN })).toThrow(/non-finite/);
    expect(() => openAuditSpool({ dir, maxBytes: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    expect(frameLines(dir)).toHaveLength(0);
  });

  it("a refused bound leaves NO single-writer lock behind on the volume", async () => {
    // The validation runs BEFORE the volume lock is taken. Raised from inside
    // the spool it would have held the lock on the way out, so the operator who
    // then FIXED the bound would be met by a lock error instead of a broker.
    const dir = tempDir();
    expect(() => openAuditSpool({ dir, maxBytes: 1 })).toThrow();
    // The corrected configuration opens, which is the whole point.
    const s = spool(dir, AUDIT_SPOOL_MIN_MAX_BYTES);
    expect(s.spoolId).toBeTruthy();
  });

  it("opens AT the floor, and that spool can admit and record a command", async () => {
    // The floor is a real working bound, not merely a number that passes a
    // comparison — otherwise the check would just move the failure.
    const dir = tempDir();
    const s = spool(dir, AUDIT_SPOOL_MIN_MAX_BYTES);
    const reservation = await s.reserve(record("job-1", 1));
    await reservation.commit(record("job-1", 1, { decision: "executed" }));
    expect(recordsOnDisk(dir).filter((r) => r.decision === "executed")).toHaveLength(1);
  });
});

describe("audit spool saturation — an episode the volume cannot vouch for is not recorded", () => {
  it("writes NO episode record when the episode state could not be persisted", async () => {
    // THE SECOND-RECORD HOLE (Codex convergence, adopted). The state write's
    // failure used to be swallowed and the record appended anyway: the record
    // lands, the state does not, and the next boot reads "never saturated" and
    // mints a SECOND `audit_spool_full` record for one continuous saturation —
    // one per restart, forever, on a crash-looping broker.
    const dir = tempDir();
    const s = spool(dir, TIGHT_MAX_BYTES);

    // Fail the saturation-state write, and ONLY that write, WITHOUT a mock: the
    // state is written by opening `<episode>.json.tmp` and renaming it into
    // place, so a DIRECTORY sitting at that path makes the open fail with
    // EISDIR. A real syscall failing for a real reason, on the real code path —
    // and the log's own appends keep working, which is what isolates the
    // ordering rather than breaking the whole volume.
    //
    // (A `vi.spyOn(fsp, "open")` cannot be used here at all: an ESM module
    // namespace is not configurable, and the spy throws before it injects
    // anything.)
    mkdirSync(path.join(dir, "audit-spool.episode.json.tmp"));

    await reserveUntilFull(s);

    // The episode is live IN THIS PROCESS — so it keeps refusing without
    // writing records, which is the bounded behaviour G5 is about...
    expect(s.stats().saturation.state).toBe("saturated");
    // ...but nothing was written that the volume cannot account for.
    expect(recordsOnDisk(dir).filter((r) => r.reason === AUDIT_SPOOL_FULL_REASON)).toHaveLength(0);
  });
});
