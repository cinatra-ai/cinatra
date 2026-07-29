import { describe, expect, it, vi } from "vitest";
import {
  buildPendingConfirmationContext,
  PENDING_CONFIRMATION_CONTEXT_MAX_LINES,
  PENDING_CONFIRMATION_CONTEXT_WINDOW_MS,
} from "@/lib/assistant-runtime/pending-confirmation-context";
import type { ConnectorInstancePendingCallRecord } from "@/lib/connector-instance-pending-call-store";

// cinatra#2020 S5 PR-4 — the §6.3 model-context section: transitions-only,
// one-hour window, hard 5-line cap, empty string when silent, and a read
// failure never fails the turn.

const NOW = Date.parse("2026-07-28T12:00:00.000Z");

function record(
  overrides: Partial<ConnectorInstancePendingCallRecord>,
): ConnectorInstancePendingCallRecord {
  return {
    id: "cipc_1",
    connectorKey: "wordpress",
    instanceId: "inst-1",
    serverId: "wps_1",
    toolName: "core/delete-post",
    args: null,
    argsHash: "h",
    argsBytes: 2,
    argsPreview: "{}",
    toolFingerprint: "tf",
    targetFingerprint: "gf",
    derivedClass: "destructive",
    surface: "chat",
    userId: "u1",
    orgId: "org1",
    primitiveName: null,
    intent: null,
    causation: null,
    context: null,
    status: "executed",
    failureCode: null,
    resultSummary: null,
    decidedBy: "u1",
    decidedAt: new Date(NOW - 5 * 60_000).toISOString(),
    consumedAt: null,
    executingDeadline: null,
    executedAt: null,
    expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
    createdAt: new Date(NOW - 20 * 60_000).toISOString(),
    updatedAt: new Date(NOW - 5 * 60_000).toISOString(),
    ...overrides,
  };
}

function build(records: ConnectorInstancePendingCallRecord[]) {
  return buildPendingConfirmationContext(
    { orgId: "org1", userId: "u1" },
    { listForViewer: vi.fn(async () => records), now: () => NOW },
  );
}

describe("buildPendingConfirmationContext (§6.3)", () => {
  it("empty list → empty string (byte-identical system prompt)", async () => {
    await expect(build([])).resolves.toBe("");
  });

  it("pending rows are NOT transitions → empty string", async () => {
    await expect(build([record({ status: "pending" })])).resolves.toBe("");
  });

  it("renders one line per transition with the decided vocabulary", async () => {
    const out = await build([
      record({ id: "a", status: "executed" }),
      record({ id: "b", status: "denied" }),
      record({ id: "c", status: "expired" }),
    ]);
    expect(out).toContain("[user confirmed] core/delete-post on wps_1 → executed");
    expect(out).toContain("[user denied] core/delete-post on wps_1 → not executed");
    expect(out).toContain("[expired unconfirmed] core/delete-post on wps_1 → not executed");
  });

  it("renders execution_interrupted as OUTCOME-UNKNOWN, never an ordinary failure", async () => {
    const out = await build([
      record({ status: "failed", failureCode: "execution_interrupted" }),
    ]);
    expect(out).toContain("outcome unknown");
    expect(out).toContain("verify on the site before retrying");
    expect(out).not.toContain("→ failed (");
  });

  it("filters transitions older than the window", async () => {
    const stale = new Date(NOW - PENDING_CONFIRMATION_CONTEXT_WINDOW_MS - 60_000).toISOString();
    await expect(
      build([record({ decidedAt: stale, updatedAt: stale })]),
    ).resolves.toBe("");
  });

  it("hard-caps at the newest 5 lines", async () => {
    const records = Array.from({ length: 9 }, (_, i) =>
      record({
        id: `cipc_${i}`,
        toolName: `tool-${i}`,
        updatedAt: new Date(NOW - (i + 1) * 60_000).toISOString(),
        decidedAt: new Date(NOW - (i + 1) * 60_000).toISOString(),
      }),
    );
    const out = await build(records);
    const lines = out.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(PENDING_CONFIRMATION_CONTEXT_MAX_LINES);
    expect(out).toContain("tool-0"); // newest kept
    expect(out).not.toContain("tool-8"); // oldest dropped
  });

  it("orders by decidedAt, not updatedAt, when the two diverge", async () => {
    // "older" was decided most recently but its updatedAt is stale (touched
    // earlier by an unrelated event); "newer" was decided earlier but its
    // updatedAt is fresher. Ordering must follow decidedAt for both the
    // recency window and the sort, so "older" (the more recent DECISION)
    // sorts first.
    const out = await build([
      record({
        id: "newer-updated",
        toolName: "tool-stale-decision",
        decidedAt: new Date(NOW - 30 * 60_000).toISOString(),
        updatedAt: new Date(NOW - 1 * 60_000).toISOString(),
      }),
      record({
        id: "older-updated",
        toolName: "tool-fresh-decision",
        decidedAt: new Date(NOW - 1 * 60_000).toISOString(),
        updatedAt: new Date(NOW - 30 * 60_000).toISOString(),
      }),
    ]);
    const lines = out.split("\n").filter((l) => l.startsWith("- "));
    expect(lines[0]).toContain("tool-fresh-decision");
    expect(lines[1]).toContain("tool-stale-decision");
  });

  it("an unparseable updatedAt does not scramble order when decidedAt is null", async () => {
    const out = await build([
      record({ id: "a", toolName: "tool-good", decidedAt: null, updatedAt: new Date(NOW - 60_000).toISOString() }),
      record({ id: "b", toolName: "tool-bad", decidedAt: null, updatedAt: "not-a-date" }),
    ]);
    // The unparseable row is excluded by the recency filter (its effective
    // timestamp is -Infinity, never >= cutoff), so only the valid row remains.
    expect(out).toContain("tool-good");
    expect(out).not.toContain("tool-bad");
  });

  it("bounded content: never args/previews (ids + tool/server names only)", async () => {
    const out = await build([record({ argsPreview: '{"secret":"[redacted]"}' })]);
    expect(out).not.toContain("argsPreview");
    expect(out).not.toContain("[redacted]");
  });

  it("a store read failure yields an empty section, never a throw", async () => {
    await expect(
      buildPendingConfirmationContext(
        { orgId: "org1", userId: "u1" },
        { listForViewer: vi.fn(async () => Promise.reject(new Error("db down"))), now: () => NOW },
      ),
    ).resolves.toBe("");
  });
});
