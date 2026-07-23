/**
 * Unit tests for the #1987 shared-seam answered-gate-submission provenance
 * enforcement (F1 deferred from #1960):
 *   src/app/api/agents/passthrough/answered-gate-provenance.ts
 *
 * The atomic single-use / replay / mismatch semantics of the Redis substrate are
 * proven against a REAL store in
 * packages/a2a/src/__tests__/answered-gate-provenance.integration.test.ts. HERE
 * we prove the seam's DECISION logic and its SEAM-property registration:
 *   - AC1/AC2  : the persist is authorized ONLY on a `consumed` result; a
 *                run-frame-valid call with no answered-gate record is REJECTED.
 *   - AC3      : a `mismatch` / `absent` consume result is REJECTED (the route
 *                surfaces a non-2xx so the apply node fails the run).
 *   - AC7      : a missing `verifiedSubmissionId`, an absent resume payload, or a
 *                THROW from the provenance store all FAIL CLOSED — never a
 *                run-frame-only decision.
 *   - AC5      : the binding is a SEAM property — every member of
 *                RUN_SCOPED_PERSIST_TOOLS is bound by construction (the
 *                enforcement is generic over `tool`, so a new #1946-template
 *                member inherits it with no per-member authz code), and the
 *                read/shape run-scoped primitives (list/exclude) + the send
 *                primitive are NOT mis-registered as persists (AC6).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Control the a2a substrate consume result / throw. The helper `await import`s
// @cinatra-ai/a2a; this mock intercepts that dynamic import.
const consumeMock = vi.hoisted(() => vi.fn());
vi.mock("@cinatra-ai/a2a", () => ({
  consumeAnsweredGateSubmission: consumeMock,
}));

import {
  RUN_SCOPED_PERSIST_TOOLS,
  isRunScopedPersistTool,
  enforceAnsweredGateProvenance,
} from "@/app/api/agents/passthrough/answered-gate-provenance";

const DRAFTS = "email_outreach_initial_drafts_update";
const RECIPIENTS = "email_outreach_recipients_update";
const PAYLOAD = JSON.stringify({ drafts: [{ id: "d1", subject: "S", body: "B" }] });

beforeEach(() => consumeMock.mockReset());

describe("RUN_SCOPED_PERSIST_TOOLS registration (AC5 seam property / AC6 no mis-registration)", () => {
  it("binds exactly the #1959 + #1960 persist primitives", () => {
    expect([...RUN_SCOPED_PERSIST_TOOLS].sort()).toEqual([DRAFTS, RECIPIENTS].sort());
  });

  it("classifies the persist primitives as bound and the read/shape + send primitives as UNBOUND", () => {
    expect(isRunScopedPersistTool(DRAFTS)).toBe(true);
    expect(isRunScopedPersistTool(RECIPIENTS)).toBe(true);
    // Non-persist run-scoped primitives (their authz stays untouched — AC6).
    expect(isRunScopedPersistTool("agent_run_hitl_prompts_list")).toBe(false);
    expect(isRunScopedPersistTool("agent_run_hitl_prompts_exclude")).toBe(false);
    expect(isRunScopedPersistTool("email_test_delivery_run_send")).toBe(false);
    // Generic (non-run-scoped) primitives.
    expect(isRunScopedPersistTool("objects_save")).toBe(false);
  });
});

describe("enforceAnsweredGateProvenance", () => {
  const base = {
    runId: "run-1",
    verifiedSubmissionId: "gate-task-1",
    resumePayloadJson: PAYLOAD,
  };

  it("AUTHORIZES the persist only on a `consumed` result (AC1/AC2 pass arm)", async () => {
    consumeMock.mockResolvedValue("consumed");
    const decision = await enforceAnsweredGateProvenance({ tool: DRAFTS, ...base });
    expect(decision).toEqual({ ok: true });
    // The bind consumed the answer for the EXACT gate + payload, from the frame.
    expect(consumeMock).toHaveBeenCalledWith("run-1", "gate-task-1", PAYLOAD);
  });

  it("REJECTS a run-frame-valid call with NO answered-gate record (AC2 reject arm)", async () => {
    consumeMock.mockResolvedValue("absent");
    const decision = await enforceAnsweredGateProvenance({ tool: RECIPIENTS, ...base });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.status).toBe(403);
      expect(decision.error).toMatch(/no unconsumed answered-gate submission/i);
    }
  });

  it("REJECTS a mutated/substituted payload (AC3)", async () => {
    consumeMock.mockResolvedValue("mismatch");
    const decision = await enforceAnsweredGateProvenance({ tool: RECIPIENTS, ...base });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.status).toBe(403);
      expect(decision.error).toMatch(/does not match the operator's answered-gate/i);
    }
  });

  it("FAILS CLOSED when the frame carries no verifiedSubmissionId (AC7)", async () => {
    const decision = await enforceAnsweredGateProvenance({
      tool: DRAFTS,
      runId: "run-1",
      verifiedSubmissionId: undefined,
      resumePayloadJson: PAYLOAD,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.error).toMatch(/no verified answered-gate submission id/i);
    // Never reaches the store — the decision is fail-closed on the frame.
    expect(consumeMock).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when the resume payload is absent (AC7)", async () => {
    const decision = await enforceAnsweredGateProvenance({
      tool: DRAFTS,
      runId: "run-1",
      verifiedSubmissionId: "gate-task-1",
      resumePayloadJson: undefined,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.error).toMatch(/resume payload is absent/i);
    expect(consumeMock).not.toHaveBeenCalled();
  });

  // The substrate-THROW fail-closed case (AC7 "unreadable provenance store")
  // lives in its own single-test file (answered-gate-provenance-failclosed.test.ts)
  // — a rejecting mock combined with a prior resolving mock call in the SAME file
  // trips vitest 4's rejection tracker even when the helper handles it, so it is
  // isolated to keep this suite deterministic.

  it("is GENERIC over the tool — a newly-added persist member inherits the binding with no per-member code (AC5)", async () => {
    // Simulate a future #1946-template persist primitive added to the set: the
    // enforcement path is keyed purely on the `tool` argument + the frame, so the
    // SAME consume/deny logic applies with zero new authz code.
    consumeMock.mockResolvedValue("consumed");
    for (const tool of [...RUN_SCOPED_PERSIST_TOOLS, "some_future_1946_persist"]) {
      const decision = await enforceAnsweredGateProvenance({ tool, ...base });
      expect(decision).toEqual({ ok: true });
    }
    consumeMock.mockResolvedValue("absent");
    for (const tool of [...RUN_SCOPED_PERSIST_TOOLS, "some_future_1946_persist"]) {
      const decision = await enforceAnsweredGateProvenance({ tool, ...base });
      expect(decision.ok).toBe(false);
    }
  });
});
