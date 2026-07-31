/**
 * The DURABLE AUDIT SPOOL (cinatra#2266 slice 2, G1 + G2).
 *
 * TESTABLE, NOT INSPECTABLE — which is the point the issue makes about the
 * original acceptance criteria. Every arm below drives the REAL file spool
 * against a REAL directory and asserts on the FILE (its bytes, its recovered
 * contents after a real SIGKILL of a real child process), never on a config
 * constant and never on a hand-written double. Where a fault is needed it is
 * INJECTED into the filesystem the spool actually uses.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AuditSpoolFullError,
  AuditSpoolLockedError,
  createMemoryAuditSpool,
  openAuditSpool,
  type AuditSpool,
} from "../audit-spool";
import { DEFAULT_SANDBOX_LIMITS, type ExecutionAuditRecord } from "../../types";

const dirs: string[] = [];
const open: AuditSpool[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cinatra-audit-spool-"));
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
  command: "echo hi",
  cwd: "/workspace",
  seq,
  decision: "executed",
  effectivePolicy: { egressMode: "none", limits: DEFAULT_SANDBOX_LIMITS },
  atMs: 1_700_000_000_000,
  ...over,
});

const logPath = (dir: string): string => path.join(dir, "audit-spool.log");

describe("audit spool — delivery identity and the non-destructive read", () => {
  it("stamps a spool-local delivery key and reads it back in producer order", async () => {
    const dir = tempDir();
    const s = spool(dir);
    await s.append(record("job-a", 0));
    await s.append(record("job-b", 1));

    const batch = s.read();
    expect(batch.entries.map((r) => r.jobId)).toEqual(["job-a", "job-b"]);
    expect(batch.entries.map((r) => r.deliveryKey)).toEqual([
      `${s.spoolId}:1`,
      `${s.spoolId}:2`,
    ]);
    // A pure read: repeat it and nothing moved.
    expect(s.read().head).toBe(batch.head);
    expect(s.read().entries).toHaveLength(2);
  });

  it("gives two IDENTICAL pre-dispatch refusals on ONE job distinct delivery keys", async () => {
    // cinatra#2266 AC2. Same job, same reason, no dispatch — the case the D6
    // key (`jobId + seq + decision`) could not distinguish when `seq` was
    // allocated at dispatch and refusals defaulted it.
    const dir = tempDir();
    const s = spool(dir);
    await s.append(record("job-a", 0, { decision: "refused", reason: "voucher_invalid" }));
    await s.append(record("job-a", 1, { decision: "refused", reason: "voucher_invalid" }));

    const keys = s.read().entries.map((r) => r.deliveryKey);
    expect(new Set(keys).size).toBe(2);
    // ...and neither defaulted its producer sequence.
    expect(s.read().entries.map((r) => r.seq)).toEqual([0, 1]);
  });
});

describe("audit spool — acknowledgement", () => {
  it("removes exactly the acknowledged prefix and nothing else", async () => {
    const dir = tempDir();
    const s = spool(dir);
    for (let i = 0; i < 4; i += 1) await s.append(record(`job-${i}`, i));

    const batch = s.read(2);
    expect(batch.entries).toHaveLength(2);
    expect(batch.remaining).toBe(2);

    const acked = await s.ack({ spoolId: s.spoolId, head: batch.head });
    expect(acked).toMatchObject({ ok: true, removed: 2, remaining: 2 });
    expect(s.read().entries.map((r) => r.jobId)).toEqual(["job-2", "job-3"]);
    // The FILE shrank too — the prefix is gone from disk, not only from memory.
    expect(readFileSync(logPath(dir), "utf8")).not.toContain('"job-0"');
  });

  it("refuses a stale, a misrouted and an out-of-order acknowledgement", async () => {
    const dir = tempDir();
    const s = spool(dir);
    await s.append(record("job-a", 0));
    await s.append(record("job-b", 1));
    const batch = s.read();

    expect(await s.ack({ spoolId: "another-volume", head: batch.head })).toMatchObject({
      ok: false,
      reason: "wrong_spool",
    });
    expect(await s.ack({ spoolId: s.spoolId, head: batch.head + 50 })).toMatchObject({
      ok: false,
      reason: "unknown_head",
    });
    // Nothing was removed by either refusal.
    expect(s.read().entries).toHaveLength(2);

    expect(await s.ack({ spoolId: s.spoolId, head: batch.head })).toMatchObject({ ok: true });
    // Replaying the same ACK is now stale.
    expect(await s.ack({ spoolId: s.spoolId, head: batch.head })).toMatchObject({
      ok: false,
      reason: "stale_head",
    });
  });
});

describe("audit spool — the byte bound (asserted on the FILE)", () => {
  it("refuses a reservation once the file would exceed the bound, and the file stays under it", async () => {
    const dir = tempDir();
    // Small enough that a handful of records reaches it; the assertion below is
    // on `statSync().size`, not on this constant.
    const maxBytes = 8_192;
    const s = spool(dir, maxBytes);

    let refused = 0;
    for (let i = 0; i < 200; i += 1) {
      try {
        await s.reserve(record(`job-${i}`, i, { decision: "outcome_unknown" }));
      } catch (err) {
        expect(err).toBeInstanceOf(AuditSpoolFullError);
        refused += 1;
        break;
      }
    }
    expect(refused).toBe(1);
    expect(statSync(logPath(dir)).size).toBeLessThanOrEqual(maxBytes);
    expect(s.stats().refusedReservations).toBe(1);
  });

  it("lets a COMMITTED command past the bound rather than losing the record of a real run", async () => {
    // The reservation is where capacity is claimed and where a refusal belongs.
    // Once a command HAS RUN its record is not droppable, so `commit` is
    // deliberately not bound-checked — the overshoot is bounded by the
    // reservations outstanding.
    const dir = tempDir();
    const maxBytes = 8_192;
    const s = spool(dir, maxBytes);
    const reservation = await s.reserve(record("job-a", 0, { decision: "outcome_unknown" }));
    // A terminal record far larger than the reserved headroom. It still lands.
    await expect(
      reservation.commit(
        record("job-a", 0, { decision: "executed", command: "x".repeat(10_000) }),
      ),
    ).resolves.toBeUndefined();
    expect(s.read().entries.map((r) => r.decision)).toEqual(["executed"]);
    expect(statSync(logPath(dir)).size).toBeGreaterThan(maxBytes);
    // And the bound still refuses the NEXT admission, so the overshoot is
    // bounded by the reservations outstanding rather than open-ended.
    await expect(
      s.reserve(record("job-b", 0, { decision: "outcome_unknown" })),
    ).rejects.toBeInstanceOf(AuditSpoolFullError);
  });
});

describe("audit spool — single writer", () => {
  it("refuses a second LIVE writer against the same volume", () => {
    const dir = tempDir();
    spool(dir);
    expect(() => openAuditSpool({ dir })).toThrow(AuditSpoolLockedError);
  });

  it("takes over a lock whose holder is dead, so a crash is not a permanent outage", async () => {
    const dir = tempDir();
    const s = spool(dir);
    await s.append(record("job-a", 0));
    await s.close();
    open.length = 0;
    // Simulate a lock left behind by a killed process: a pid that cannot exist.
    writeFileSync(path.join(dir, "audit-spool.lock"), "999999999\n");
    const reopened = spool(dir);
    expect(reopened.read().entries.map((r) => r.jobId)).toEqual(["job-a"]);
  });
});

describe("audit spool — torn append recovery", () => {
  it("truncates a partially-flushed final line instead of reading it as a record", async () => {
    const dir = tempDir();
    const s = spool(dir);
    await s.append(record("job-a", 0));
    await s.append(record("job-b", 1));
    await s.close();
    open.length = 0;

    // A torn append: the tail of the file is a half-written frame with no
    // terminating newline — exactly what an interrupted `write()` leaves.
    const raw = readFileSync(logPath(dir), "utf8");
    writeFileSync(logPath(dir), `${raw}0123456789abcdef {"pos":3,"deliv`);

    const reopened = spool(dir);
    expect(reopened.read().entries.map((r) => r.jobId)).toEqual(["job-a", "job-b"]);
    // The torn bytes are GONE from the file, so the next append cannot land
    // after a partial frame and make the log unparseable forever.
    expect(readFileSync(logPath(dir), "utf8").endsWith("\n")).toBe(true);
    expect(readFileSync(logPath(dir), "utf8")).not.toContain('{"pos":3');
  });

  it("refuses a corrupt frame in the MIDDLE rather than skipping it", async () => {
    const dir = tempDir();
    const s = spool(dir);
    await s.append(record("job-a", 0));
    await s.append(record("job-b", 1));
    await s.close();
    open.length = 0;

    const lines = readFileSync(logPath(dir), "utf8").split("\n");
    // Corrupt the FIRST frame's payload so its digest no longer matches.
    lines[0] = lines[0]!.replace("job-a", "job-X");
    writeFileSync(logPath(dir), lines.join("\n"));

    // Silently skipping it would drop a record and renumber nothing; reading it
    // would return a record the digest says is not what was written.
    expect(() => openAuditSpool({ dir })).toThrow(/unreadable frame/);
  });
});

describe("audit spool — SIGKILL between dispatch and completion (G1/AC4)", () => {
  it("recovers an unresolved reservation as an explicit outcome_unknown record", () => {
    const dir = tempDir();
    // A REAL child process, a REAL reservation on a REAL file, and a REAL
    // SIGKILL — the process never gets to run an exit handler, which is the
    // whole point: nothing but the fsynced file survives it.
    const script = path.resolve(__dirname, "audit-spool-kill-child.ts");
    const result = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
    // The child kills ITSELF with SIGKILL after reserving, so a clean exit here
    // would mean the arm never exercised the crash it exists to test.
    expect(result.signal).toBe("SIGKILL");

    const reopened = spool(dir);
    const entries = reopened.read().entries;
    expect(entries).toHaveLength(2);
    // The command that completed before the kill keeps its terminal record...
    expect(entries[0]).toMatchObject({ jobId: "job-done", decision: "executed" });
    // ...and the one that was dispatched and never resolved is NOT silence.
    expect(entries[1]).toMatchObject({
      jobId: "job-inflight",
      decision: "outcome_unknown",
      reason: "outcome_unknown",
    });
    expect(reopened.stats().recoveredUnknown).toBe(1);
    // The delivery key is the one allocated BEFORE dispatch (the reservation
    // frame's own position, 3: reserve → commit → reserve), so the record an
    // investigation reads names the same slot the reservation claimed.
    expect(entries[1]?.deliveryKey).toBe(`${reopened.spoolId}:3`);
  });

  it("re-delivers the same delivery keys across a restart until they are acknowledged", async () => {
    const dir = tempDir();
    const first = spool(dir);
    await first.append(record("job-a", 0));
    await first.append(record("job-b", 1));
    const before = first.read().entries.map((r) => r.deliveryKey);
    // No ACK — the app died before it could confirm the write.
    await first.close();
    open.length = 0;

    const second = spool(dir);
    expect(second.spoolId).toBe(first.spoolId);
    expect(second.read().entries.map((r) => r.deliveryKey)).toEqual(before);
  });

  it("does not re-deliver what WAS acknowledged before the restart", async () => {
    const dir = tempDir();
    const first = spool(dir);
    await first.append(record("job-a", 0));
    await first.append(record("job-b", 1));
    const batch = first.read(1);
    await first.ack({ spoolId: first.spoolId, head: batch.head });
    await first.close();
    open.length = 0;

    const second = spool(dir);
    expect(second.read().entries.map((r) => r.jobId)).toEqual(["job-b"]);
  });
});

describe("audit spool — an OPEN reservation survives truncation", () => {
  it("carries an unresolved reservation across an ACK that removes the frames around it", async () => {
    // Without this the ACK would delete the only evidence that a dispatched
    // command exists, and the crash recovery above would have nothing to find.
    const dir = tempDir();
    const s = spool(dir);
    await s.append(record("job-a", 0));
    const reservation = await s.reserve(record("job-inflight", 0, { decision: "outcome_unknown" }));
    await s.append(record("job-c", 0));

    const batch = s.read();
    // The reservation itself is NOT deliverable — it is bookkeeping.
    expect(batch.entries.map((r) => r.jobId)).toEqual(["job-a", "job-c"]);
    await s.ack({ spoolId: s.spoolId, head: batch.head });
    expect(s.stats().openReservations).toBe(1);

    await s.close();
    open.length = 0;
    const reopened = spool(dir);
    expect(reopened.read().entries.map((r) => r.jobId)).toEqual(["job-inflight"]);
    expect(reopened.read().entries[0]?.decision).toBe("outcome_unknown");
    void reservation;
  });

  it("a committed reservation is delivered ONCE, as the terminal record", async () => {
    const dir = tempDir();
    const s = spool(dir);
    const reservation = await s.reserve(record("job-a", 0, { decision: "outcome_unknown" }));
    await reservation.commit(record("job-a", 0, { decision: "executed", exitCode: 0 }));

    const entries = s.read().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ decision: "executed", deliveryKey: reservation.deliveryKey });
    // And a restart does not resurrect the reservation as an outcome_unknown.
    await s.close();
    open.length = 0;
    const reopened = spool(dir);
    expect(reopened.read().entries.map((r) => r.decision)).toEqual(["executed"]);
    expect(reopened.stats().recoveredUnknown).toBe(0);
  });
});

describe("audit spool — the in-memory placement is honest about itself", () => {
  it("reports durable:false and behaves identically otherwise", async () => {
    const s = createMemoryAuditSpool();
    expect(s.durable).toBe(false);
    await s.append(record("job-a", 0));
    const batch = s.read();
    expect(batch.entries[0]?.deliveryKey).toBe(`${s.spoolId}:1`);
    expect(await s.ack({ spoolId: s.spoolId, head: batch.head })).toMatchObject({ ok: true });
  });
});
