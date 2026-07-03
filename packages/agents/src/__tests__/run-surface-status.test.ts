/**
 * Shared run-surface status/HITL-context reducers (cinatra#853).
 *
 * Pins the poll/SSE "resolve effective status" reduction previously inlined
 * in agentic-run-panel.tsx: SSE wins when the stream is enabled AND has
 * delivered a value; the just-submitted suppression hides the stale gate
 * until a DIFFERENT renderer arrives.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/run-surface-status.test.ts
 */
import { describe, it, expect } from "vitest";

import {
  applyJustSubmittedSuppression,
  mapInterruptToHitlContext,
  resolveStreamFirst,
  statusBadgeVariant,
  type HitlGateContext,
} from "../run-surface-status";

describe("resolveStreamFirst", () => {
  it("SSE wins when enabled and delivered", () => {
    expect(resolveStreamFirst(true, "running", "queued")).toBe("running");
  });
  it("falls back to poll when the stream has not delivered", () => {
    expect(resolveStreamFirst<string>(true, null, "queued")).toBe("queued");
  });
  it("ignores the stream entirely when disabled", () => {
    expect(resolveStreamFirst(false, "running", "queued")).toBe("queued");
  });
  it("works for nullable error channels", () => {
    expect(resolveStreamFirst<string | null>(true, "boom", null)).toBe("boom");
    expect(resolveStreamFirst<string | null>(false, "boom", null)).toBeNull();
  });
});

describe("statusBadgeVariant", () => {
  it("maps the shared statuses identically for both surfaces", () => {
    expect(statusBadgeVariant("completed")).toBe("default");
    expect(statusBadgeVariant("failed")).toBe("destructive");
    expect(statusBadgeVariant("pending_approval")).toBe("outline");
    expect(statusBadgeVariant("running")).toBe("secondary");
    expect(statusBadgeVariant("queued")).toBe("secondary");
    expect(statusBadgeVariant("pending_input")).toBe("secondary");
    expect(statusBadgeVariant("stopped")).toBe("secondary");
  });
  it("maps the trigger-run statuses (AgenticRunPanel surface)", () => {
    expect(statusBadgeVariant("pending_trigger")).toBe("outline");
    expect(statusBadgeVariant("armed")).toBe("secondary");
  });
});

describe("mapInterruptToHitlContext", () => {
  it("maps the SSE interrupt shape onto the panel gate shape (childRunId null, fieldName propagated)", () => {
    const mapped = mapInterruptToHitlContext({
      xRenderer: "@cinatra-ai/x:output",
      reviewTaskId: "rt-1",
      schema: { type: "object" },
      values: { a: 1 },
      fieldName: "postTitle",
    });
    expect(mapped).toEqual({
      xRenderer: "@cinatra-ai/x:output",
      childRunId: null,
      reviewTaskId: "rt-1",
      inputSchema: { type: "object" },
      currentValues: { a: 1 },
      fieldName: "postTitle",
    });
  });
  it("returns null for null", () => {
    expect(mapInterruptToHitlContext(null)).toBeNull();
  });
});

describe("applyJustSubmittedSuppression", () => {
  const gate: HitlGateContext = {
    xRenderer: "@cinatra-ai/x:output",
    childRunId: null,
    reviewTaskId: "rt-1",
    inputSchema: {},
    currentValues: {},
  };

  it("suppresses the just-submitted renderer's stale gate", () => {
    expect(applyJustSubmittedSuppression(gate, "@cinatra-ai/x:output")).toEqual({
      context: null,
      clearSuppression: false,
    });
  });

  it("lets a DIFFERENT renderer through and signals the caller to clear", () => {
    expect(applyJustSubmittedSuppression(gate, "@cinatra-ai/x:other")).toEqual({
      context: gate,
      clearSuppression: true,
    });
  });

  it("passes through unsuppressed contexts and null contexts", () => {
    expect(applyJustSubmittedSuppression(gate, null)).toEqual({
      context: gate,
      clearSuppression: false,
    });
    expect(applyJustSubmittedSuppression(null, "@cinatra-ai/x:output")).toEqual({
      context: null,
      clearSuppression: false,
    });
  });
});
