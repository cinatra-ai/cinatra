// Unit tests for the per-turn no-progress guard (cinatra#2580).
//
// The guard's ONE job is to stay silent on every turn that is working and to
// fire on the measured stalled shape (one call identity returning nothing,
// step after step, while the loop re-bills a full ~43k-token envelope each
// time). The false-POSITIVE cases below matter more than the true-positive
// one: a guard that cuts a good turn costs the user their answer, which is
// worse than the money it saves.

import { describe, expect, it } from "vitest";
import {
  createTurnCostGuard,
  noProgressMessage,
  DEFAULT_NO_PROGRESS_REPEAT_LIMIT,
  TURN_STOPPED_NO_PROGRESS_CODE,
} from "../ports";

type Guard = ReturnType<typeof createTurnCostGuard>;

/** One provider step containing a single tool round-trip. */
function step(
  guard: Guard,
  id: string | undefined,
  name: string,
  args: unknown,
  result: string,
  serverLabel?: string,
) {
  guard.observeToolCall({ id, name, arguments: args, serverLabel });
  guard.observeToolResult({ id, name, result, serverLabel });
  guard.observeStepEnd();
}

/** N consecutive steps whose one call returns nothing — the measured shape. */
function stall(guard: Guard, n: number, name = "agent_list") {
  for (let i = 0; i < n; i++) step(guard, `call-${i}`, name, { limit: 10 }, "");
}

describe("turn cost guard — stays silent while the turn is progressing", () => {
  it("does not fire below the repeat limit", () => {
    expect(DEFAULT_NO_PROGRESS_REPEAT_LIMIT).toBe(4);
    const guard = createTurnCostGuard();
    stall(guard, DEFAULT_NO_PROGRESS_REPEAT_LIMIT - 1);
    expect(guard.verdict()).toBeNull();
  });

  it("NEVER fires on a poll loop whose result is byte-identical but has bytes", () => {
    // The case that rules out a pure identical-result predicate: a run poll can
    // legitimately return exactly `{"status":"running"}` many times and flip on
    // the next call.
    const guard = createTurnCostGuard();
    for (let i = 0; i < 10; i++) {
      step(guard, `c${i}`, "agent_run_get", { id: "r1" }, '{"status":"running"}');
    }
    expect(guard.verdict()).toBeNull();
  });

  it("never fires on repeated EMPTY RESULT SETS — `[]` is an answer", () => {
    const guard = createTurnCostGuard();
    for (let i = 0; i < 10; i++) step(guard, `c${i}`, "objects_list", { type: "note" }, "[]");
    expect(guard.verdict()).toBeNull();
  });

  it("never fires on a repeated ERROR ENVELOPE — it carries text, and may carry data", () => {
    // Rejected predicate: an `{"error": …}` payload is not "nothing". It can
    // carry usable records alongside the error, and a transient error that
    // recovers on the next call is ordinary.
    const guard = createTurnCostGuard();
    for (let i = 0; i < 10; i++) {
      step(guard, `c${i}`, "crm_account_search", { q: "acme" }, '{"error":"2 failed","items":[{"id":"a1"}]}');
    }
    expect(guard.verdict()).toBeNull();
  });

  it("never fires on repeated plain-text results that merely look like errors", () => {
    const guard = createTurnCostGuard();
    for (let i = 0; i < 10; i++) {
      step(guard, `c${i}`, "agent_run_get", { id: "r1" }, "Error: the run has not started yet");
    }
    expect(guard.verdict()).toBeNull();
  });

  it("does not fire on a long multi-tool research turn with no text until the end", () => {
    const guard = createTurnCostGuard();
    step(guard, "c1", "crm_account_search", { q: "acme" }, '[{"id":"a1"}]');
    step(guard, "c2", "crm_account_get", { id: "a1" }, '{"id":"a1"}');
    step(guard, "c3", "crm_contact_search", { account: "a1" }, '[{"id":"p1"}]');
    step(guard, "c4", "crm_contact_get", { id: "p1" }, '{"id":"p1"}');
    step(guard, "c5", "objects_list", { type: "note" }, "[]");
    step(guard, "c6", "projects_list", {}, "[]");
    expect(guard.verdict()).toBeNull();
    expect(guard.steps).toBe(6);
  });

  it("does not fire when the same tool comes back empty for DIFFERENT arguments", () => {
    const guard = createTurnCostGuard();
    for (let i = 0; i < 8; i++) step(guard, `c${i}`, "objects_list", { type: `t${i}` }, "");
    expect(guard.verdict()).toBeNull();
  });

  it("does not fire when the empty call alternates between MCP servers", () => {
    const guard = createTurnCostGuard();
    for (let i = 0; i < 8; i++) {
      step(guard, `c${i}`, "search", { q: "x" }, "", i % 2 === 0 ? "cinatra" : "wordpress");
    }
    expect(guard.verdict()).toBeNull();
  });

  it("user-visible text in a step disqualifies that step from the streak", () => {
    const guard = createTurnCostGuard();
    stall(guard, 3);
    guard.observeToolCall({ id: "x", name: "agent_list", arguments: { limit: 10 } });
    guard.observeToolResult({ id: "x", name: "agent_list", result: "" });
    guard.observeTextDelta("Here is what I found so far.");
    guard.observeStepEnd();
    stall(guard, 3);
    expect(guard.verdict()).toBeNull();
  });

  it("an empty text delta is not progress (adapters emit them) and does not disqualify", () => {
    const guard = createTurnCostGuard();
    for (let i = 0; i < DEFAULT_NO_PROGRESS_REPEAT_LIMIT; i++) {
      guard.observeTextDelta("");
      step(guard, `c${i}`, "agent_list", { limit: 10 }, "");
    }
    expect(guard.verdict()).not.toBeNull();
  });
});

describe("turn cost guard — the streak advances per STEP, never per result", () => {
  it("four identical empty calls inside ONE step count as one step, not a stop", () => {
    // Only one full-context envelope was billed; the guard must not stop after
    // a single step just because the model fanned out duplicates in it.
    const guard = createTurnCostGuard();
    for (let i = 0; i < 4; i++) {
      guard.observeToolCall({ id: `p${i}`, name: "agent_list", arguments: { limit: 10 } });
      guard.observeToolResult({ id: `p${i}`, name: "agent_list", result: "" });
    }
    guard.observeStepEnd();
    expect(guard.verdict()).toBeNull();
    expect(guard.steps).toBe(1);
  });

  it("a step whose calls came back empty AND with data is progress, not a stall", () => {
    const guard = createTurnCostGuard();
    for (let i = 0; i < DEFAULT_NO_PROGRESS_REPEAT_LIMIT; i++) {
      guard.observeToolCall({ id: `a${i}`, name: "agent_list", arguments: { limit: 10 } });
      guard.observeToolResult({ id: `a${i}`, name: "agent_list", result: "" });
      guard.observeToolCall({ id: `b${i}`, name: "objects_list", arguments: {} });
      guard.observeToolResult({ id: `b${i}`, name: "objects_list", result: '[{"id":1}]' });
      guard.observeStepEnd();
    }
    expect(guard.verdict()).toBeNull();
  });

  it("a step whose empty calls span TWO identities is ambiguous — no count", () => {
    const guard = createTurnCostGuard();
    for (let i = 0; i < DEFAULT_NO_PROGRESS_REPEAT_LIMIT; i++) {
      guard.observeToolCall({ id: `a${i}`, name: "agent_list", arguments: {} });
      guard.observeToolResult({ id: `a${i}`, name: "agent_list", result: "" });
      guard.observeToolCall({ id: `b${i}`, name: "projects_list", arguments: {} });
      guard.observeToolResult({ id: `b${i}`, name: "projects_list", result: "" });
      guard.observeStepEnd();
    }
    expect(guard.verdict()).toBeNull();
  });

  it("a step with no tool results at all breaks the streak", () => {
    const guard = createTurnCostGuard();
    stall(guard, 3);
    guard.observeStepEnd(); // a reasoning-only step
    stall(guard, 3);
    expect(guard.verdict()).toBeNull();
  });
});

describe("turn cost guard — fails OPEN on anything it cannot read with certainty", () => {
  it("never fires when the adapter emits no call id (the result cannot be joined)", () => {
    const guard = createTurnCostGuard();
    for (let i = 0; i < 10; i++) step(guard, undefined, "agent_list", { limit: 10 }, "");
    expect(guard.verdict()).toBeNull();
  });

  it("never fires on a result whose id was never announced as a call", () => {
    const guard = createTurnCostGuard();
    for (let i = 0; i < 10; i++) {
      guard.observeToolResult({ id: `ghost-${i}`, name: "agent_list", result: "" });
      guard.observeStepEnd();
    }
    expect(guard.verdict()).toBeNull();
  });

  it("never fires on arguments that cannot be serialized (a cycle)", () => {
    const guard = createTurnCostGuard();
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;
    for (let i = 0; i < 10; i++) step(guard, `c${i}`, "agent_list", cyclic, "");
    expect(guard.verdict()).toBeNull();
  });
});

describe("turn cost guard — fires on the measured stalled shape", () => {
  it("stops the turn on the 4th consecutive all-empty step", () => {
    const guard = createTurnCostGuard();
    stall(guard, DEFAULT_NO_PROGRESS_REPEAT_LIMIT - 1);
    expect(guard.verdict()).toBeNull();
    stall(guard, 1);
    expect(guard.verdict()).toEqual({ toolName: "agent_list", repeats: 4 });
    expect(guard.steps).toBe(DEFAULT_NO_PROGRESS_REPEAT_LIMIT);
  });

  it("treats argument objects as equal regardless of key order, at any depth", () => {
    const guard = createTurnCostGuard();
    const shapes = [
      { agent: "a", opts: { x: 1, y: 2 } },
      { opts: { y: 2, x: 1 }, agent: "a" },
      { agent: "a", opts: { x: 1, y: 2 } },
      { opts: { x: 1, y: 2 }, agent: "a" },
    ];
    shapes.forEach((args, i) => step(guard, `c${i}`, "agent_run", args, ""));
    expect(guard.verdict()?.repeats).toBe(4);
  });

  it("does NOT treat a reordered array argument as the same call", () => {
    const guard = createTurnCostGuard();
    step(guard, "c0", "agent_run", { ids: ["a", "b"] }, "");
    step(guard, "c1", "agent_run", { ids: ["b", "a"] }, "");
    step(guard, "c2", "agent_run", { ids: ["a", "b"] }, "");
    step(guard, "c3", "agent_run", { ids: ["b", "a"] }, "");
    expect(guard.verdict()).toBeNull();
  });

  it("the verdict latches — later progress cannot un-stop an already stopped turn", () => {
    const guard = createTurnCostGuard();
    stall(guard, DEFAULT_NO_PROGRESS_REPEAT_LIMIT);
    const stopped = guard.verdict();
    guard.observeTextDelta("recovered?");
    step(guard, "c9", "objects_list", {}, '[{"id":1}]');
    expect(guard.verdict()).toEqual(stopped);
  });

  it("honours a caller-supplied repeat limit, with a floor of 2", () => {
    const two = createTurnCostGuard({ repeatLimit: 2 });
    stall(two, 2);
    expect(two.verdict()?.repeats).toBe(2);

    // A limit of 1 would stop on the very first empty step — floored to 2.
    const floored = createTurnCostGuard({ repeatLimit: 1 });
    stall(floored, 1);
    expect(floored.verdict()).toBeNull();
  });
});

describe("turn cost guard — the stopped-turn report", () => {
  it("names the repeating tool, the repeat count and the likely remedy", () => {
    const message = noProgressMessage({ toolName: "agent_list", repeats: 4 });
    expect(message).toContain("agent_list");
    expect(message).toContain("4 times in a row");
    expect(message).toContain("unavailable");
  });

  it("carries a stable machine-readable code", () => {
    expect(TURN_STOPPED_NO_PROGRESS_CODE).toBe("turn_stopped_no_progress");
  });
});
