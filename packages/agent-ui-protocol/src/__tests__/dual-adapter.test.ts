/**
 * Unit tests for DualAdapterDispatch composite adapter.
 *
 * These cases verify fan-out ordering, complete interrupt argument forwarding,
 * omitted field handling, lifecycle coverage, and throw propagation.
 *
 * Run: pnpm --filter @cinatra-ai/agent-ui-protocol test -- dual-adapter
 */
import { describe, expect, it } from "vitest";
import { DualAdapterDispatch } from "../dual-adapter";
import type { AgentUIAdapter } from "../adapter";

// ---------------------------------------------------------------------------
// Test harness -- shared-buffer recorder factory. Both children share one
// `calls[]` buffer so relative call ordering is observable across children.
// ---------------------------------------------------------------------------
function makeRecorder(label: string, calls: string[]): AgentUIAdapter {
  const push = (method: string, args: unknown[]) =>
    calls.push(`${label}.${method}(${JSON.stringify(args)})`);
  return {
    onRunStarted: () => push("onRunStarted", []),
    onRunFinished: (status, error) => push("onRunFinished", [status, error]),
    onTextDelta: (id, delta) => push("onTextDelta", [id, delta]),
    onToolCallStart: (id, name, args) =>
      push("onToolCallStart", [id, name, args]),
    onToolCallEnd: (id, name, result) =>
      push("onToolCallEnd", [id, name, result]),
    onStateSnapshot: (snap) => push("onStateSnapshot", [snap]),
    onInterrupt: (schema, xr, values, rt, field) =>
      push("onInterrupt", [schema, xr, values, rt, field]),
    onResume: () => push("onResume", []),
  };
}

describe("DualAdapterDispatch", () => {
  it("fans out onRunStarted to AG-UI first, then A2UI", () => {
    const calls: string[] = [];
    const d = new DualAdapterDispatch(
      makeRecorder("agUi", calls),
      makeRecorder("a2ui", calls),
    );
    d.onRunStarted();
    expect(calls).toEqual(["agUi.onRunStarted([])", "a2ui.onRunStarted([])"]);
  });

  it("forwards all 5 onInterrupt args including optional fieldName", () => {
    const calls: string[] = [];
    const d = new DualAdapterDispatch(
      makeRecorder("agUi", calls),
      makeRecorder("a2ui", calls),
    );
    d.onInterrupt({ type: "object" }, "xr-id", { foo: 1 }, "rt-1", "myField");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("agUi.onInterrupt");
    expect(calls[0]).toContain('"myField"');
    expect(calls[1]).toContain("a2ui.onInterrupt");
    expect(calls[1]).toContain('"myField"');
  });

  it("forwards onInterrupt without fieldName when omitted", () => {
    const calls: string[] = [];
    const d = new DualAdapterDispatch(
      makeRecorder("agUi", calls),
      makeRecorder("a2ui", calls),
    );
    d.onInterrupt({}, "xr", {}, "rt");
    // Both children see undefined as the 5th arg. Ordering preserved.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^agUi\.onInterrupt/);
    expect(calls[1]).toMatch(/^a2ui\.onInterrupt/);
  });

  it("fans out all 8 lifecycle methods in AG-UI-first order", () => {
    const calls: string[] = [];
    const d = new DualAdapterDispatch(
      makeRecorder("agUi", calls),
      makeRecorder("a2ui", calls),
    );
    d.onRunStarted();
    d.onTextDelta("m1", "hi");
    d.onToolCallStart("tc1", "foo", {});
    d.onToolCallEnd("tc1", "foo", "ok");
    d.onStateSnapshot({ type: "x" });
    d.onInterrupt({}, "xr", {}, "rt");
    d.onResume();
    d.onRunFinished("completed");

    // Every pair is AG-UI then A2UI: 8 methods x 2 children = 16 entries.
    expect(calls).toHaveLength(16);
    for (let i = 0; i < calls.length; i += 2) {
      expect(calls[i]).toMatch(/^agUi\./);
      expect(calls[i + 1]).toMatch(/^a2ui\./);
    }
  });

  it("does not isolate children -- propagates throws from AG-UI child (documents trust contract)", () => {
    // Children are contracted to never throw from lifecycle methods (all
    // publish calls are `void ....catch(() => {})` internally). The composite
    // intentionally propagates any accidental throw so bugs surface in logs
    // rather than being masked.
    const calls: string[] = [];
    const thrower: AgentUIAdapter = {
      ...makeRecorder("thrower", calls),
      onRunStarted: () => {
        throw new Error("bug");
      },
    };
    const a2uiCalls: string[] = [];
    const d = new DualAdapterDispatch(thrower, makeRecorder("a2ui", a2uiCalls));
    expect(() => d.onRunStarted()).toThrow("bug");
    // A2UI never received the call -- by design. Children are trusted.
    expect(a2uiCalls).toHaveLength(0);
  });
});
