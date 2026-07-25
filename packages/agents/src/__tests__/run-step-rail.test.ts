/**
 * Run step-rail merge contract fixtures (cinatra#2066, C1, AC-2).
 *
 * Pins the EXPLICIT merge contract (`buildRunStepRail`) — ordering, dedup,
 * precedence — across all four sources (template-derived steps + captured
 * submissions; transcript messages; stepResults JSON; review gates), INCLUDING
 * overlap cases, with the expected ordering asserted. Pure: no DB, no React.
 */
import { describe, expect, it } from "vitest";

import {
  buildRunStepRail,
  type RailGate,
  type RailMessage,
  type RailTemplateStep,
} from "../run-step-rail";

const tstep = (index: number, stepNumber: number, label: string): RailTemplateStep => ({
  index,
  stepNumber,
  label,
});

const gate = (
  reviewTaskId: string,
  status: "pending" | "resolved",
  createdAt: string,
  disposition: string | null = null,
): RailGate => ({ gateId: `g_${reviewTaskId}`, reviewTaskId, status, disposition, createdAt });

const msg = (
  id: string,
  sequence: number,
  role: RailMessage["role"],
  messageType: RailMessage["messageType"],
  text?: string,
): RailMessage => ({ id, sequence, role, messageType, text });

describe("buildRunStepRail merge contract", () => {
  it("orchestrator run: template steps form the spine, gates trail in createdAt order", () => {
    const rail = buildRunStepRail({
      templateSteps: [tstep(1, 10, "Draft"), tstep(2, 20, "Refine")],
      // both steps ran (stepResults present) before the trailing gates.
      stepResults: [{ out: "a" }, { out: "b" }],
      gates: [
        gate("t2", "pending", "2026-07-25T10:05:00Z"),
        gate("t1", "resolved", "2026-07-25T10:00:00Z", "approved"),
      ],
    });
    // ordering: two template steps (ordinal 1,2), then gates by createdAt (t1 before t2).
    expect(rail.entries.map((e) => e.key)).toEqual([
      "step:10",
      "step:20",
      "gate:t1",
      "gate:t2",
    ]);
    // t1 resolved ⇒ read-only history; t2 pending ⇒ the active decision.
    const t1 = rail.entries.find((e) => e.key === "gate:t1")!;
    const t2 = rail.entries.find((e) => e.key === "gate:t2")!;
    expect(t1.status).toBe("resolved");
    expect(t1.gate?.resolved).toBe(true);
    expect(t2.status).toBe("pending");
    expect(t2.gate?.resolved).toBe(false);
    // active anchor is the first non-completed/resolved entry — the pending gate.
    expect(rail.activeOrdinal).toBe(t2.ordinal);
  });

  it("PRECEDENCE + DEDUP: template > stepResult > submission collapse to ONE entry per position", () => {
    const rail = buildRunStepRail({
      templateSteps: [tstep(1, 10, "Draft"), tstep(2, 20, "Refine")],
      submissions: [{ stepIndex: 1, answered: true }],
      stepResults: [{ out: "a" }, { out: "b" }],
    });
    // No duplicate entries: two positions only.
    expect(rail.entries).toHaveLength(2);
    const draft = rail.entries[0];
    expect(draft.key).toBe("step:10");
    // Label comes from the template (highest precedence), never the stepResult.
    expect(draft.label).toBe("Draft");
    // All three sources merged into the union.
    expect(draft.sources).toEqual(["stepResult", "submission", "template"]);
    // A captured submission / aligned stepResult ⇒ completed.
    expect(draft.status).toBe("completed");
    expect(rail.entries[1].status).toBe("completed");
    // Everything ran ⇒ no active anchor.
    expect(rail.activeOrdinal).toBeNull();
  });

  it("surplus stepResults past the template length become their own trailing entries", () => {
    const rail = buildRunStepRail({
      templateSteps: [tstep(1, 10, "Draft")],
      stepResults: [{ out: "a" }, { out: "b" }, { out: "c" }],
    });
    expect(rail.entries.map((e) => e.key)).toEqual([
      "step:10",
      "stepResult:1",
      "stepResult:2",
    ]);
    expect(rail.entries.map((e) => e.ordinal)).toEqual([1, 2, 3]);
  });

  it("single-agent run: transcript milestones form the spine; tool/user lines fold out", () => {
    const rail = buildRunStepRail({
      messages: [
        msg("m1", 0, "user", "text", "hi"), // user — not a milestone
        msg("m2", 1, "assistant", "text", "Thinking about it"),
        msg("m3", 2, "assistant", "tool_call"), // tool_call — folds out
        msg("m4", 3, "tool", "tool_result"), // tool result — folds out
        msg("m5", 4, "assistant", "final", "Here is the final answer to your long question that keeps going"),
      ],
      gates: [gate("tv", "pending", "2026-07-25T11:00:00Z")],
    });
    // Only the two assistant text/final turns are rail steps, then the gate.
    expect(rail.entries.map((e) => e.key)).toEqual(["message:m2", "message:m5", "gate:tv"]);
    // Milestone labels: truncated turn text.
    expect(rail.entries[0].label).toBe("Thinking about it");
    expect(rail.entries[1].label.endsWith("…")).toBe(true);
    // Transcript turns already happened ⇒ completed; the gate is the active anchor.
    expect(rail.entries[0].status).toBe("completed");
    expect(rail.activeOrdinal).toBe(rail.entries[2].ordinal);
  });

  it("transcript does NOT form the spine when template steps exist (no message entries)", () => {
    const rail = buildRunStepRail({
      templateSteps: [tstep(1, 10, "Draft")],
      messages: [msg("m2", 1, "assistant", "final", "answer")],
    });
    expect(rail.entries.map((e) => e.key)).toEqual(["step:10"]);
  });

  it("empty run yields an empty rail and a null active anchor", () => {
    const rail = buildRunStepRail({});
    expect(rail.entries).toEqual([]);
    expect(rail.activeOrdinal).toBeNull();
  });

  it("surplus stepResults + gate trail a NON-CONTIGUOUS template index without collision", () => {
    // A template step at display index 3 (non-contiguous), one aligned + one
    // surplus stepResult, then a gate — gate must strictly trail everything.
    const rail = buildRunStepRail({
      templateSteps: [{ index: 3, stepNumber: 30, label: "Late" }],
      stepResults: [{ out: "a" }, { out: "b" }],
      gates: [gate("tg", "pending", "2026-07-25T12:00:00Z")],
    });
    const ordinals = new Map(rail.entries.map((e) => [e.key, e.ordinal]));
    // template ordinal 3; surplus stepResult trails it (4); gate trails that (5).
    expect(ordinals.get("step:30")).toBe(3);
    expect(ordinals.get("stepResult:1")).toBe(4);
    expect(ordinals.get("gate:tg")).toBe(5);
    // no two entries share an ordinal (collision-proof).
    const vals = [...ordinals.values()];
    expect(new Set(vals).size).toBe(vals.length);
  });

  it("transcript ordering is input-order-independent (id tie-break on equal sequence)", () => {
    const forward = buildRunStepRail({
      messages: [msg("b", 1, "assistant", "text", "B"), msg("a", 1, "assistant", "text", "A")],
    });
    const reversed = buildRunStepRail({
      messages: [msg("a", 1, "assistant", "text", "A"), msg("b", 1, "assistant", "text", "B")],
    });
    expect(forward.entries.map((e) => e.key)).toEqual(reversed.entries.map((e) => e.key));
    expect(forward.entries.map((e) => e.key)).toEqual(["message:a", "message:b"]);
  });

  it("gate ordering is DETERMINISTIC under equal createdAt (tie-broken by reviewTaskId)", () => {
    const rail = buildRunStepRail({
      templateSteps: [tstep(1, 10, "Draft")],
      gates: [
        gate("tb", "pending", "2026-07-25T10:00:00Z"),
        gate("ta", "resolved", "2026-07-25T10:00:00Z", "changes_requested"),
      ],
    });
    expect(rail.entries.map((e) => e.key)).toEqual(["step:10", "gate:ta", "gate:tb"]);
  });
});
