/**
 * The remote audit drain does not DESTROY retained stdio (cinatra#2266, the
 * defect #2258 shipped).
 *
 * `drainAudit` is destructive — the broker's relay splices out whatever it
 * returns — and `maxStdioEntries` defaults to "all of it". The app-side loop
 * asked only for audit records, so every buffered stdout/stderr entry was
 * spliced out into `batch.stdio` on a 15-second cycle and dropped on the floor,
 * because this side wires no stdio consumer at all. The fix is to ask for ZERO
 * until a consumer lands.
 *
 * These run against the REAL relay (`createBufferedAuditRelay`), not a stub of
 * it, because the whole defect lived in the interaction between what the loop
 * asks for and what `drain()` does with an absent limit — a hand-written double
 * would have encoded the fix rather than tested it. The third test is the
 * negative control: it drives the same relay the way the loop used to and
 * asserts stdio IS destroyed, so the retention assertion cannot pass vacuously.
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
} from "@/lib/execution/execution-broker-remote-construct";
import {
  createBufferedAuditRelay,
  DEFAULT_SANDBOX_LIMITS,
  type DrainAuditPayload,
  type ExecutionAuditRecord,
} from "@cinatra-ai/execution-plane";

const record = (jobId: string): ExecutionAuditRecord => ({
  jobId,
  orgId: "org-1",
  userId: "user-1",
  surface: "agent_run",
  command: "echo hi",
  cwd: "/workspace",
  decision: "executed",
  exitCode: 0,
  termination: "exited",
  effectivePolicy: { egressMode: "none", limits: DEFAULT_SANDBOX_LIMITS },
  atMs: 1_700_000_000_000,
});

/** A relay holding two audit records and two retained stdio entries. */
function seededRelay() {
  const relay = createBufferedAuditRelay();
  relay.auditSink(record("job-a"));
  relay.auditSink(record("job-b"));
  relay.stdioSink({ jobId: "job-a", seq: 0, stdout: "hi\n", stderr: "" });
  relay.stdioSink({ jobId: "job-b", seq: 0, stdout: "", stderr: "boom\n" });
  return relay;
}

describe("drainAuditPasses — stdio is retained, not destroyed", () => {
  let written: ExecutionAuditRecord[];
  beforeEach(() => {
    written = [];
  });
  const sink = (r: ExecutionAuditRecord) => {
    written.push(r);
  };

  it("asks the broker for ZERO stdio entries", async () => {
    const limits: (DrainAuditPayload | undefined)[] = [];
    const relay = seededRelay();
    await drainAuditPasses(
      {
        drainAudit: async (passed) => {
          limits.push(passed);
          return relay.drain(passed);
        },
      },
      sink,
    );
    expect(limits).toHaveLength(1);
    expect(limits[0]).toEqual({
      maxAuditRecords: AUDIT_DRAIN_MAX_RECORDS,
      maxStdioEntries: 0,
    });
    expect(AUDIT_DRAIN_MAX_STDIO_ENTRIES).toBe(0);
  });

  it("writes every audit record and leaves the stdio entries in the broker", async () => {
    const relay = seededRelay();
    await drainAuditPasses({ drainAudit: async (l) => relay.drain(l) }, sink);

    expect(written.map((r) => r.jobId)).toEqual(["job-a", "job-b"]);
    // The audit records really were taken...
    expect(relay.drain({ maxStdioEntries: 0 }).audit).toEqual([]);
    // ...and the stdio entries really were NOT.
    expect(relay.drain().stdio).toHaveLength(2);
  });

  it("negative control: the pre-fix call shape DOES destroy them", async () => {
    const relay = seededRelay();
    // Exactly what the loop issued before this fix: an audit cap and no stdio
    // limit at all.
    const batch = relay.drain({ maxAuditRecords: AUDIT_DRAIN_MAX_RECORDS });
    expect(batch.stdio).toHaveLength(2);
    expect(relay.drain().stdio).toHaveLength(0);
  });

  it("reports a dropped-stdio gap instead of letting the reset counter eat it", async () => {
    const gaps: string[] = [];
    const relay = createBufferedAuditRelay({ maxStdioEntries: 1 });
    relay.stdioSink({ jobId: "job-a", seq: 0, stdout: "first\n", stderr: "" });
    relay.stdioSink({ jobId: "job-a", seq: 1, stdout: "second\n", stderr: "" });

    await drainAuditPasses({ drainAudit: async (l) => relay.drain(l) }, sink, {
      onGap: (message) => gaps.push(message),
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("stdio");
    // The relay reset its counter as it answered — reporting it here is the
    // only place that loss is ever visible.
    expect(relay.drain().droppedStdio).toBe(0);
  });

  it("reports a dropped-audit gap for the same reason", async () => {
    const gaps: string[] = [];
    const relay = createBufferedAuditRelay({ maxAuditRecords: 1 });
    relay.auditSink(record("job-a"));
    relay.auditSink(record("job-b"));

    await drainAuditPasses({ drainAudit: async (l) => relay.drain(l) }, sink, {
      onGap: (message) => gaps.push(message),
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("audit record");
    expect(written.map((r) => r.jobId)).toEqual(["job-b"]);
  });

  it("stays bounded when the broker keeps answering a full pass", async () => {
    const gaps: string[] = [];
    let passes = 0;
    await drainAuditPasses(
      {
        drainAudit: async () => {
          passes += 1;
          return {
            audit: Array.from({ length: AUDIT_DRAIN_MAX_RECORDS }, (_, i) =>
              record(`job-${i}`),
            ),
            stdio: [],
            droppedAudit: 0,
            droppedStdio: 0,
            relayed: true,
          };
        },
      },
      sink,
      { maxPasses: 3, onGap: (message) => gaps.push(message) },
    );
    expect(passes).toBe(3);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("3 drain passes");
  });
});
