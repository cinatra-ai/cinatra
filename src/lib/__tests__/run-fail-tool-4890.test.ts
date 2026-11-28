/**
 * cinatra#4890 (item D): a generic flow tool ends the run as failed with a stated sentence.
 *
 * `run_fail` is one more extension-scoped tool. It always refuses: a fixed step
 * of the run's own flow that names it ends the run as failed, and the run's
 * error is the caller's sentence. The step must be proven and must call this
 * tool itself; the sentence must be one plain line within the module-refusal
 * bounds. The run's extension context, the proven step's tool reading and the
 * audit sink are test doubles; the dispatch is the real one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  stepTool: vi.fn<() => Promise<string | null>>(),
  logAuditEvent: vi.fn(async () => {}),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/extension-run-package", () => ({
  resolveRunExtensionContext: async () => ({
    packageName: "@example-org/fixture-agent",
    packageVersion: "1.0.0",
    cinatra: {},
  }),
}));
vi.mock("@/lib/extension-host-context", () => ({
  readProvenStepPassthroughTool: () => h.stepTool(),
  runActionRefusalClassCode: () => null,
}));
vi.mock("@/lib/authz/audit", () => ({ logAuditEvent: h.logAuditEvent }));

import { EXTENSION_SCOPED_TOOLS, dispatchExtensionScopedTool } from "@/lib/extension-scoped-tools";

const RUN = {
  id: "run-4890",
  orgId: "org-1",
  runBy: "user-1",
  templateId: "tmpl-1",
  packageVersion: "1.0.0",
  verifiedStepId: "stop_step",
};
const SENTENCE = "The reviewed proposal and the written page differ, so the run stops here.";

const call = (input: Record<string, unknown>, run: Record<string, unknown> = RUN) =>
  dispatchExtensionScopedTool({ tool: "run_fail", input, run: run as typeof RUN });

afterEach(() => {
  h.stepTool.mockReset();
  h.logAuditEvent.mockClear();
});

describe("run_fail ends the run as failed with the caller's sentence", () => {
  it("is admitted on the passthrough by name, as a scoped tool", () => {
    expect(EXTENSION_SCOPED_TOOLS.has("run_fail")).toBe(true);
  });

  it("refuses with the caller's sentence, unchanged, under the proven run and step", async () => {
    h.stepTool.mockResolvedValue("run_fail");
    const outcome = await call({ sentence: SENTENCE });
    expect(outcome).toEqual({ ok: false, status: 403, error: SENTENCE, code: "run_fail_stated" });
    const event = h.logAuditEvent.mock.calls.at(0)?.at(0) as unknown as Record<string, unknown>;
    expect(event).toMatchObject({
      operation: "run_fail.dispatch",
      runId: "run-4890",
      organizationId: "org-1",
      decision: "denied",
      metadata: { verifiedStepId: "stop_step", runPackage: "@example-org/fixture-agent", reason: "refused" },
    });
    expect(JSON.stringify(event)).not.toContain(SENTENCE);
  });

  it("answers the same refusal again on a second call and writes nothing else", async () => {
    h.stepTool.mockResolvedValue("run_fail");
    const first = await call({ sentence: SENTENCE });
    const second = await call({ sentence: SENTENCE });
    expect(second).toEqual(first);
    expect(second).toEqual({ ok: false, status: 403, error: SENTENCE, code: "run_fail_stated" });
    expect(h.logAuditEvent).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an empty sentence", "   ", "the sentence is empty"],
    ["a sentence on two lines", "First line.\nSecond line.", "the sentence holds a line break"],
    ["an over-long sentence", "a ".repeat(201) + "b", "the sentence is longer than 400 characters"],
    ["a sentence with a control character", "Stop\u0007 here.", "the sentence holds a control character"],
    ["a sentence that is no text", 42, "the sentence is not a string"],
  ])("refuses %s with its own message, never passing it on", async (_label, sentence, issue) => {
    h.stepTool.mockResolvedValue("run_fail");
    const outcome = await call({ sentence });
    expect(outcome).toEqual({ ok: false, status: 403, error: `run_fail: the sentence is refused (${issue})` });
  });

  it("refuses an input with another field than the sentence", async () => {
    h.stepTool.mockResolvedValue("run_fail");
    const outcome = await call({ sentence: SENTENCE, agent_run_id: "run-other" });
    expect(outcome).toEqual({ ok: false, status: 403, error: "run_fail: the input takes one field, `sentence`" });
  });

  it("refuses a caller without a proven step, before it reads the step", async () => {
    const outcome = await call({ sentence: SENTENCE }, { ...RUN, verifiedStepId: null });
    expect(outcome).toEqual({
      ok: false,
      status: 403,
      error: "run_fail: the calling step is not proven, so the run is not ended by it",
    });
    expect(h.stepTool).not.toHaveBeenCalled();
  });

  it.each([
    ["calls another tool", "extension_data"],
    ["is no fixed passthrough step of the bound flow", null],
  ])("refuses a step that %s", async (_label, tool) => {
    h.stepTool.mockResolvedValue(tool);
    const outcome = await call({ sentence: SENTENCE });
    expect(outcome).toEqual({
      ok: false,
      status: 403,
      error: "run_fail: the calling step does not call this tool, so the run is not ended by it",
    });
  });
});
