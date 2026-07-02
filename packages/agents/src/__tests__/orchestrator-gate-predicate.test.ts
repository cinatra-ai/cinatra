import { describe, it, expect } from "vitest";
import { stepFiresRendererGate } from "../orchestrator-gate-predicate";

describe("stepFiresRendererGate (#839)", () => {
  it("includes a real renderer gate (xRenderer set, flag unset)", () => {
    expect(stepFiresRendererGate({ xRenderer: "@cinatra-ai/reviewer-agent:output" })).toBe(true);
  });
  it("includes a real renderer gate even when firesRendererGate is explicitly true", () => {
    expect(
      stepFiresRendererGate({ xRenderer: "@cinatra-ai/reviewer-agent:output", firesRendererGate: true }),
    ).toBe(true);
  });
  it("excludes a metadata-only phantom gateStep (firesRendererGate:false)", () => {
    expect(
      stepFiresRendererGate({ xRenderer: "@cinatra-ai/reviewer-agent:output", firesRendererGate: false }),
    ).toBe(false);
  });
  it("excludes a non-renderer step (no xRenderer) regardless of flag", () => {
    expect(stepFiresRendererGate({})).toBe(false);
    expect(stepFiresRendererGate({ firesRendererGate: true })).toBe(false);
  });
});
