/**
 * Idempotency-ledger tests (exec-plane S1 remainder, epic cinatra#1705).
 *
 * The guarantee under test is narrow and load-bearing: a repeated `commandId`
 * never becomes a second execution. Claim atomicity, completed-replay, in-flight
 * refusal, release-on-no-dispatch, and the bounded/TTL'd retention that keeps a
 * process-local ledger from becoming an unbounded cache.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMMAND_LEDGER_RETENTION_MS,
  createInMemoryCommandLedger,
} from "../command-ledger";
import type { ExecResult } from "../../types";

const OK: ExecResult = {
  ok: true,
  result: {
    exitCode: 0,
    stdout: "hi",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    termination: "exited",
    wallMs: 12,
    imageDigest: "sha256:abc",
    workspaceKb: 4,
  },
};

describe("in-memory command ledger", () => {
  it("declares itself non-durable so a caller can report the posture", () => {
    expect(createInMemoryCommandLedger().isDurable).toBe(false);
  });

  it("claims a fresh id, then reports the same id as in-flight", async () => {
    const ledger = createInMemoryCommandLedger();
    expect(await ledger.claim("c1", "j1")).toEqual({ state: "claimed" });
    expect(await ledger.claim("c1", "j1")).toEqual({ state: "in_flight" });
  });

  it("replays a completed outcome instead of allowing a second run", async () => {
    const ledger = createInMemoryCommandLedger();
    await ledger.claim("c1", "j1");
    await ledger.complete("c1", "j1", { kind: "exec", result: OK });
    const again = await ledger.claim("c1", "j1");
    expect(again.state).toBe("completed");
    if (again.state !== "completed") return;
    expect(again.record.outcome).toEqual({ kind: "exec", result: OK });
    expect(again.record.jobId).toBe("j1");
  });

  it("is atomic against a concurrent burst on the same id — exactly one claim", async () => {
    const ledger = createInMemoryCommandLedger();
    const claims = await Promise.all(
      Array.from({ length: 32 }, () => ledger.claim("hot", "j1")),
    );
    expect(claims.filter((c) => c.state === "claimed")).toHaveLength(1);
    expect(claims.filter((c) => c.state === "in_flight")).toHaveLength(31);
  });

  it("releases a claim that never dispatched, so a retry is possible", async () => {
    const ledger = createInMemoryCommandLedger();
    await ledger.claim("c1", "j1");
    await ledger.release("c1");
    expect(await ledger.claim("c1", "j1")).toEqual({ state: "claimed" });
  });

  it("records an environment refusal so a retry refuses identically", async () => {
    const ledger = createInMemoryCommandLedger();
    await ledger.claim("c1", "j1");
    await ledger.complete("c1", "j1", {
      kind: "environmentUntrusted",
      reason: "no_provenance_key",
    });
    const again = await ledger.claim("c1", "j1");
    expect(again.state).toBe("completed");
    if (again.state !== "completed") return;
    expect(again.record.outcome).toEqual({
      kind: "environmentUntrusted",
      reason: "no_provenance_key",
    });
  });

  it("evicts past the record cap, oldest first, once past the replay window", async () => {
    let now = 1_000_000;
    const ledger = createInMemoryCommandLedger({
      maxRecords: 2,
      minReplayMs: 1_000,
      nowMs: () => now,
    });
    for (const id of ["a", "b", "c"]) {
      await ledger.claim(id, "j");
      await ledger.complete(id, "j", { kind: "exec", result: OK });
    }
    // All three are still inside the guaranteed replay window, so the SOFT cap
    // has not evicted anything yet (that is the whole point of the window).
    expect(ledger.size()).toBe(3);
    // Past the window, the cap applies again and drops the oldest.
    now += 1_001;
    await ledger.claim("d", "j");
    await ledger.complete("d", "j", { kind: "exec", result: OK });
    expect((await ledger.claim("a", "j")).state).toBe("claimed");
    expect((await ledger.claim("d", "j")).state).toBe("completed");
  });

  /**
   * THE REPLAY GUARANTEE NEEDS A MINIMUM DURATION. With only a record cap, a
   * burst of newer completions could evict a record microseconds after it was
   * written — so a retry arriving well inside its retry budget would find nothing
   * and RE-RUN a model-authored command. A record inside `minReplayMs` is
   * therefore never evicted to make room.
   */
  it("never evicts a record inside the guaranteed replay window to make room", async () => {
    let now = 1_000_000;
    // maxRecords 10 ⇒ hard ceiling 40, so a 20-deep burst exercises the SOFT cap
    // (10) while staying clear of the ceiling — isolating the window guarantee.
    const ledger = createInMemoryCommandLedger({
      maxRecords: 10,
      minReplayMs: 60_000,
      nowMs: () => now,
    });
    await ledger.claim("keep-me", "j");
    await ledger.complete("keep-me", "j", { kind: "exec", result: OK });
    // A burst of newer completions, all within the window and well past the cap.
    for (let i = 0; i < 20; i += 1) {
      now += 1; // still far inside minReplayMs
      await ledger.claim(`burst-${i}`, "j");
      await ledger.complete(`burst-${i}`, "j", { kind: "exec", result: OK });
    }
    expect(ledger.size()).toBeGreaterThan(10);
    // The record a retry would need is still replayable, cap notwithstanding.
    expect((await ledger.claim("keep-me", "j")).state).toBe("completed");
    expect(ledger.droppedReplayGuarantees).toBe(0);
  });

  it("counts a dropped replay guarantee instead of degrading silently at the hard ceiling", async () => {
    let now = 1_000_000;
    // maxRecords 1 ⇒ hard ceiling 4. Filling past it inside the window forces
    // eviction of young records, which must be COUNTED.
    const ledger = createInMemoryCommandLedger({
      maxRecords: 1,
      minReplayMs: 60_000,
      nowMs: () => now,
    });
    for (let i = 0; i < 12; i += 1) {
      now += 1;
      await ledger.claim(`c-${i}`, "j");
      await ledger.complete(`c-${i}`, "j", { kind: "exec", result: OK });
    }
    expect(ledger.size()).toBeLessThanOrEqual(4);
    expect(ledger.droppedReplayGuarantees).toBeGreaterThan(0);
  });

  /**
   * A THROW IS NOT PROOF THAT NOTHING RAN, so the servers record a terminal
   * `failed` outcome instead of releasing the claim. A repeat of that id must come
   * back as the recorded failure — never as a fresh claim that would re-run.
   */
  /**
   * `complete()` must build the record BEFORE it clears the claim. Reading the
   * clock is an injectable seam and can throw; clearing the claim first would
   * leave the id CLAIMABLE again after a command that may already have run.
   */
  it("keeps the claim held when recording the outcome fails", async () => {
    let failClock = false;
    const ledger = createInMemoryCommandLedger({
      nowMs: () => {
        if (failClock) throw new Error("clock failed");
        return 1_000_000;
      },
    });
    expect((await ledger.claim("c1", "j1")).state).toBe("claimed");
    failClock = true;
    await expect(
      ledger.complete("c1", "j1", { kind: "exec", result: OK }),
    ).rejects.toThrow(/clock failed/);
    failClock = false; // the clock recovers; the claim must still be held
    // Still in-flight — NOT claimable again.
    expect((await ledger.claim("c1", "j1")).state).toBe("in_flight");
  });

  it("refuses a contradictory retention/replay configuration at construction", () => {
    expect(() =>
      createInMemoryCommandLedger({ retentionMs: 1_000, minReplayMs: 60_000 }),
    ).toThrow(/must be >= minReplayMs/);
    expect(() => createInMemoryCommandLedger({ maxRecords: Number.POSITIVE_INFINITY })).toThrow(
      /finite positive number/,
    );
    expect(() => createInMemoryCommandLedger({ maxRecords: Number.NaN })).toThrow(
      /finite positive number/,
    );
  });

  it("reports outstanding claims so an un-settled dispatch is observable", async () => {
    const ledger = createInMemoryCommandLedger();
    expect(ledger.inFlightSize()).toBe(0);
    await ledger.claim("c1", "j1");
    expect(ledger.inFlightSize()).toBe(1);
    await ledger.complete("c1", "j1", { kind: "exec", result: OK });
    expect(ledger.inFlightSize()).toBe(0);
  });

  it("replays a recorded dispatch failure instead of re-claiming the id", async () => {
    const ledger = createInMemoryCommandLedger();
    await ledger.claim("c1", "j1");
    await ledger.complete("c1", "j1", { kind: "failed", message: "sink rejected" });
    const again = await ledger.claim("c1", "j1");
    expect(again.state).toBe("completed");
    if (again.state === "completed") {
      expect(again.record.outcome).toEqual({ kind: "failed", message: "sink rejected" });
    }
  });

  it("expires a completed record past the retention window", async () => {
    let now = 1_000_000;
    const ledger = createInMemoryCommandLedger({ nowMs: () => now });
    await ledger.claim("c1", "j1");
    await ledger.complete("c1", "j1", { kind: "exec", result: OK });
    expect((await ledger.claim("c1", "j1")).state).toBe("completed");
    now += DEFAULT_COMMAND_LEDGER_RETENTION_MS + 1;
    expect((await ledger.claim("c1", "j1")).state).toBe("claimed");
  });
});
