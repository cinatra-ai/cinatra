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
  drainAuditPasses,
  type AuditDrainSource,
} from "@/lib/execution/execution-broker-remote-construct";
import {
  createAuditRelay,
  createMemoryAuditSpool,
  DEFAULT_SANDBOX_LIMITS,
  type AckAuditPayload,
  type DrainAuditPayload,
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
