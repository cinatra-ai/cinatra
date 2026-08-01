/**
 * The remote audit drain: READ → WRITE → ACK, and stdio is retained rather than
 * destroyed (cinatra#2266 — slice 1 fixed the stdio discard #2258 shipped;
 * slice 2 replaced the destructive take with an acknowledged durable spool).
 *
 * These run against the REAL relay and the REAL spool (`createAuditRelay` over
 * `createMemoryAuditSpool` — the same state machine the file spool uses, with
 * the volume swapped out), not a hand-written double, because the properties
 * under test live in the interaction between what the loop asks for, what the
 * spool does with an absent limit, and when the records actually leave.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: vi.fn(async () => null),
  readAgentTemplateById: vi.fn(async () => null),
}));

import {
  AUDIT_DRAIN_MAX_RECORDS,
  AUDIT_DRAIN_MAX_STDIO_ENTRIES,
  MAX_REPORTED_EPISODES,
  drainAuditPasses,
  type AuditDrainSource,
} from "@/lib/execution/execution-broker-remote-construct";
import {
  AUDIT_SPOOL_EPISODE_RESERVE_BYTES,
  AUDIT_SPOOL_TERMINAL_HEADROOM_BYTES,
  createAuditRelay,
  createMemoryAuditSpool,
  DEFAULT_SANDBOX_LIMITS,
  type AckAuditPayload,
  type DrainAuditPayload,
  type DrainAuditResultPayload,
  type ExecAuditRelay,
  type ExecutionAuditRecord,
} from "@cinatra-ai/execution-plane";

const record = (jobId: string, seq = 0): ExecutionAuditRecord => ({
  jobId,
  orgId: "org-1",
  userId: "user-1",
  surface: "agent_run",
  command: "echo hi",
  cwd: "/workspace",
  seq,
  decision: "executed",
  exitCode: 0,
  termination: "exited",
  effectivePolicy: { egressMode: "none", limits: DEFAULT_SANDBOX_LIMITS },
  atMs: 1_700_000_000_000,
});

/** A relay holding two audit records and two retained stdio entries. */
async function seededRelay(): Promise<ExecAuditRelay> {
  const relay = createAuditRelay({ spool: createMemoryAuditSpool() });
  await relay.auditSink(record("job-a", 0));
  await relay.auditSink(record("job-b", 1));
  relay.stdioSink({ jobId: "job-a", seq: 0, stdout: "hi\n", stderr: "" });
  relay.stdioSink({ jobId: "job-b", seq: 0, stdout: "", stderr: "boom\n" });
  return relay;
}

/** Wire a relay up as the two ops the loop calls. */
function sourceOver(
  relay: ExecAuditRelay,
  spy?: { limits?: (DrainAuditPayload | undefined)[]; acks?: AckAuditPayload[] },
): AuditDrainSource {
  return {
    drainAudit: async (limits) => {
      spy?.limits?.push(limits);
      return relay.read(limits);
    },
    ackAudit: async (payload) => {
      spy?.acks?.push(payload);
      const outcome = await relay.ack(payload);
      if (!outcome.ok) throw new Error(`ackAudit refused: ${outcome.reason}`);
      return {
        acked: true as const,
        head: outcome.head,
        removed: outcome.removed,
        remaining: outcome.remaining,
      };
    },
  };
}

describe("drainAuditPasses — read, write, then acknowledge", () => {
  let written: ExecutionAuditRecord[];
  beforeEach(() => {
    written = [];
  });
  const writer = async (r: ExecutionAuditRecord) => {
    written.push(r);
    return { state: "inserted" as const, id: `row-${r.deliveryKey}` };
  };

  it("asks the broker for ZERO stdio entries", async () => {
    const spy = { limits: [] as (DrainAuditPayload | undefined)[] };
    await drainAuditPasses(sourceOver(await seededRelay(), spy), writer);
    expect(spy.limits).toHaveLength(1);
    expect(spy.limits[0]).toEqual({
      maxAuditRecords: AUDIT_DRAIN_MAX_RECORDS,
      maxStdioEntries: 0,
    });
    expect(AUDIT_DRAIN_MAX_STDIO_ENTRIES).toBe(0);
  });

  it("writes every audit record, acknowledges the head, and leaves stdio in the broker", async () => {
    const relay = await seededRelay();
    const spy = { acks: [] as AckAuditPayload[] };
    await drainAuditPasses(sourceOver(relay, spy), writer);

    expect(written.map((r) => r.jobId)).toEqual(["job-a", "job-b"]);
    // ONE acknowledgement, naming the spool and the exact head of the batch.
    expect(spy.acks).toHaveLength(1);
    expect(spy.acks[0]?.spoolId).toBe(relay.spool.spoolId);
    // The records really did leave, and only after the ACK...
    expect(relay.read({ maxStdioEntries: 0 }).audit).toEqual([]);
    // ...and the stdio entries really did NOT.
    expect(relay.read().stdio).toHaveLength(2);
  });

  it("does NOT acknowledge when a kernel write fails — the records stay spooled", async () => {
    const relay = await seededRelay();
    const spy = { acks: [] as AckAuditPayload[] };
    const failing = async (r: ExecutionAuditRecord) => {
      written.push(r);
      if (written.length === 2) throw new Error("kernel is down");
      return { state: "inserted" as const, id: "row" };
    };

    await expect(drainAuditPasses(sourceOver(relay, spy), failing)).rejects.toThrow(
      /kernel is down/,
    );
    expect(spy.acks).toHaveLength(0);
    // THE LOAD-BEARING ASSERTION: nothing was removed, so the next drain
    // re-delivers BOTH records — including the one that was written before the
    // failure. That re-delivery is the at-least-once contract, and the kernel's
    // delivery key is what makes it harmless.
    const still = relay.read({ maxStdioEntries: 0 });
    expect(still.audit.map((r) => r.jobId)).toEqual(["job-a", "job-b"]);
  });

  it("re-delivers the SAME delivery keys until the batch is acknowledged", async () => {
    const relay = await seededRelay();
    const first = relay.read({ maxStdioEntries: 0 });
    const second = relay.read({ maxStdioEntries: 0 });
    expect(second.head).toBe(first.head);
    expect(second.audit.map((r) => r.deliveryKey)).toEqual(
      first.audit.map((r) => r.deliveryKey),
    );
    expect(first.audit.every((r) => typeof r.deliveryKey === "string")).toBe(true);
  });

  it("reports a dropped-stdio gap instead of letting the reset counter eat it", async () => {
    const gaps: string[] = [];
    const relay = createAuditRelay({
      spool: createMemoryAuditSpool(),
      maxStdioEntries: 1,
    });
    relay.stdioSink({ jobId: "job-a", seq: 0, stdout: "first\n", stderr: "" });
    relay.stdioSink({ jobId: "job-a", seq: 1, stdout: "second\n", stderr: "" });

    await drainAuditPasses(sourceOver(relay), writer, {
      onGap: (message) => gaps.push(message),
    });
    expect(gaps.filter((g) => g.includes("stdio"))).toHaveLength(1);
    // The relay reset its counter as it answered — reporting it here is the
    // only place that loss is ever visible.
    expect(relay.read().droppedStdio).toBe(0);
  });

  it("reports the NON-DURABLE spool as a gap in the guarantee", async () => {
    const gaps: string[] = [];
    await drainAuditPasses(sourceOver(await seededRelay()), writer, {
      onGap: (message) => gaps.push(message),
    });
    expect(gaps.filter((g) => g.includes("NOT durable"))).toHaveLength(1);
  });

  it("stays bounded when the broker keeps answering a full pass", async () => {
    const gaps: string[] = [];
    let passes = 0;
    const full: AuditDrainSource = {
      drainAudit: async () => {
        passes += 1;
        return {
          audit: Array.from({ length: AUDIT_DRAIN_MAX_RECORDS }, (_, i) =>
            record(`job-${i}`, i),
          ),
          stdio: [],
          head: passes * AUDIT_DRAIN_MAX_RECORDS,
          spoolId: "spool-1",
          remaining: AUDIT_DRAIN_MAX_RECORDS,
          durable: true,
          refusedReservations: 0,
          recoveredUnknown: 0,
          droppedAudit: 0,
          droppedStdio: 0,
          relayed: true,
        };
      },
      ackAudit: async (payload) => ({
        acked: true as const,
        head: payload.head,
        removed: AUDIT_DRAIN_MAX_RECORDS,
        remaining: AUDIT_DRAIN_MAX_RECORDS,
      }),
    };
    await drainAuditPasses(full, writer, {
      maxPasses: 3,
      onGap: (message) => gaps.push(message),
    });
    expect(passes).toBe(3);
    expect(gaps.filter((g) => g.includes("3 drain passes"))).toHaveLength(1);
  });

  it("reports recovered outcome_unknown records and refused reservations as gaps", async () => {
    const gaps: string[] = [];
    const source: AuditDrainSource = {
      drainAudit: async () => ({
        audit: [],
        stdio: [],
        head: 0,
        spoolId: "spool-1",
        remaining: 0,
        durable: true,
        refusedReservations: 4,
        recoveredUnknown: 2,
        droppedAudit: 0,
        droppedStdio: 0,
        relayed: true,
      }),
      ackAudit: async () => {
        throw new Error("must not acknowledge an empty batch");
      },
    };
    await drainAuditPasses(source, writer, { onGap: (m) => gaps.push(m) });
    expect(gaps.filter((g) => g.includes("outcome_unknown"))).toHaveLength(1);
    expect(gaps.filter((g) => g.includes("pre-dispatch reservation"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// THE SATURATION EPISODE ON THE WIRE (cinatra#2266 G5/AC7, slice 3)
// ---------------------------------------------------------------------------

/**
 * A saturated spool refuses commands and writes NO record for the refusals —
 * that is the mechanism, not an omission. So the count of what was refused
 * reaches an operator through the drain response and nowhere else, and this is
 * the loop that has to surface it. The RECOVERY has the opposite hazard:
 * `lastEpisode` is durable state that rides every response from then on, so a
 * loop reporting it unconditionally would print a recovery line every fifteen
 * seconds for the life of the broker.
 */
describe("drainAuditPasses — the saturation episode", () => {
  const writer = async (r: ExecutionAuditRecord) => ({
    state: "inserted" as const,
    id: `row-${r.deliveryKey}`,
  });

  function saturationSource(
    saturation: DrainAuditResultPayload["saturation"],
  ): AuditDrainSource {
    return {
      drainAudit: async () => ({
        audit: [],
        stdio: [],
        head: 0,
        spoolId: "spool-1",
        remaining: 0,
        durable: true,
        refusedReservations: 0,
        recoveredUnknown: 0,
        droppedAudit: 0,
        droppedStdio: 0,
        relayed: true,
        ...(saturation ? { saturation } : {}),
      }),
      ackAudit: async () => {
        throw new Error("must not acknowledge an empty batch");
      },
    };
  }

  it("reports an OPEN episode, with the count of refusals that produced no record", async () => {
    const gaps: string[] = [];
    await drainAuditPasses(
      saturationSource({
        state: "saturated",
        episodes: 1,
        episode: { id: "spool-1:episode:1", openedAtMs: 1_700_000_000_000, refused: 4_321 },
      }),
      writer,
      { onGap: (m) => gaps.push(m) },
    );
    const reported = gaps.filter((g) => g.includes("SATURATED"));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("spool-1:episode:1");
    expect(reported[0]).toContain("4321");
    // The posture is stated, not implied: nothing ran unaccounted for.
    expect(reported[0]).toContain("Nothing ran unaccounted for");
  });

  it("reports a RECOVERY exactly ONCE per episode, however many drains follow", async () => {
    const gaps: string[] = [];
    const reportedEpisodes = new Set<string>();
    const source = saturationSource({
      state: "open",
      episodes: 1,
      lastEpisode: {
        id: "spool-1:episode:1",
        openedAtMs: 1_700_000_000_000,
        refused: 12,
        closedAtMs: 1_700_000_060_000,
      },
    });
    for (let i = 0; i < 5; i += 1) {
      await drainAuditPasses(source, writer, { onGap: (m) => gaps.push(m), reportedEpisodes });
    }
    const recovered = gaps.filter((g) => g.includes("RECOVERED"));
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toContain("spool-1:episode:1");
    expect(recovered[0]).toContain("12");
  });

  it("reports a SECOND episode's recovery — the memo suppresses repeats, not new episodes", async () => {
    const gaps: string[] = [];
    const reportedEpisodes = new Set<string>();
    for (const id of ["spool-1:episode:1", "spool-1:episode:2"]) {
      await drainAuditPasses(
        saturationSource({
          state: "open",
          episodes: 2,
          lastEpisode: { id, openedAtMs: 1, refused: 1, closedAtMs: 2 },
        }),
        writer,
        { onGap: (m) => gaps.push(m), reportedEpisodes },
      );
    }
    expect(gaps.filter((g) => g.includes("RECOVERED"))).toHaveLength(2);
  });

  it("says nothing when the broker reports no saturation at all", async () => {
    const gaps: string[] = [];
    await drainAuditPasses(saturationSource(undefined), writer, { onGap: (m) => gaps.push(m) });
    expect(gaps.filter((g) => g.includes("SATURATED") || g.includes("RECOVERED"))).toHaveLength(0);
  });

  it("does not report a recovery for an episode that is still OPEN", async () => {
    // `lastEpisode` without a `closedAtMs` is not a recovery. Reporting it as
    // one would announce that the plane came back while it is still refusing.
    const gaps: string[] = [];
    await drainAuditPasses(
      saturationSource({
        state: "open",
        episodes: 1,
        lastEpisode: { id: "spool-1:episode:1", openedAtMs: 1, refused: 3 },
      }),
      writer,
      { onGap: (m) => gaps.push(m) },
    );
    expect(gaps.filter((g) => g.includes("RECOVERED"))).toHaveLength(0);
  });

  it("bounds the reported-episode memo so a long-lived loop cannot grow it forever", async () => {
    const reportedEpisodes = new Set<string>();
    for (let i = 0; i < MAX_REPORTED_EPISODES + 25; i += 1) {
      await drainAuditPasses(
        saturationSource({
          state: "open",
          episodes: i + 1,
          lastEpisode: { id: `spool-1:episode:${i}`, openedAtMs: 1, refused: 1, closedAtMs: 2 },
        }),
        writer,
        { onGap: () => {}, reportedEpisodes },
      );
    }
    expect(reportedEpisodes.size).toBeLessThanOrEqual(MAX_REPORTED_EPISODES);
  });

  it("surfaces the episode the REAL relay reports for a REAL saturated spool", async () => {
    // Not a hand-built payload: a real file-less spool driven past its bound,
    // read through the real relay, reported by the real loop.
    const gaps: string[] = [];
    // A bound with room for a couple of reservations and no more, derived from
    // the spool module's own constants rather than from a literal.
    const relay = createAuditRelay({
      spool: createMemoryAuditSpool({
        maxBytes: AUDIT_SPOOL_EPISODE_RESERVE_BYTES + 3 * AUDIT_SPOOL_TERMINAL_HEADROOM_BYTES,
      }),
    });
    let admitted = 0;
    for (let i = 0; i < 500; i += 1) {
      try {
        await relay.auditReserver(record(`job-${i}`, i));
        admitted += 1;
      } catch {
        break;
      }
    }
    expect(admitted).toBeGreaterThanOrEqual(1);
    expect(relay.auditAdmission().admitted).toBe(false);

    await drainAuditPasses(sourceOver(relay), writer, { onGap: (m) => gaps.push(m) });
    const reported = gaps.filter((g) => g.includes("SATURATED"));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain(relay.spool.spoolId);
  });
});
