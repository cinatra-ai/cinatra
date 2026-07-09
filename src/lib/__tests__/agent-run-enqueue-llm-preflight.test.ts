// cinatra#1062 — enqueueAgentRun wires the LLM-provider preflight at the run
// chokepoint: when the caller supplies the agent package identity, the mount
// requirement is read and the availability gate runs before the BullMQ enqueue.
import { describe, it, expect, vi, beforeEach } from "vitest";

const enqueueBackgroundJob = vi.fn(async () => "job-1");
vi.mock("@/lib/background-jobs", () => ({
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "AGENT_BUILDER_EXECUTION" },
  enqueueBackgroundJob: (...a: unknown[]) => enqueueBackgroundJob(...(a as [])),
}));

// No connector deps in these tests → the connector preflight path is inert; stub
// the policy module so it never loads heavy deps.
vi.mock("@/lib/connector-policy", () => ({
  enforceConnectorPolicy: vi.fn(() => ({ allowed: true })),
}));

const readLlmRequirementFromMount = vi.fn();
vi.mock("@cinatra-ai/agents", () => ({
  readLlmRequirementFromMount: (...a: unknown[]) => readLlmRequirementFromMount(...(a as [])),
}));

class LlmProviderNotConfiguredError extends Error {
  override readonly name = "LlmProviderNotConfiguredError";
  readonly code = "LLM_PROVIDER_NOT_CONFIGURED" as const;
  readonly settingsHref = "/configuration/llm";
}
const assertLlmProviderAvailableForRun = vi.fn();
vi.mock("@/lib/agent-llm-preflight", () => ({
  assertLlmProviderAvailableForRun: (...a: unknown[]) =>
    assertLlmProviderAvailableForRun(...(a as [])),
  LlmProviderNotConfiguredError,
}));

import { enqueueAgentRun } from "@/lib/agent-run-enqueue";

const PKG = { name: "@cinatra-ai/media-transcript-agent", version: "0.1.3" };

beforeEach(() => {
  vi.clearAllMocks();
  enqueueBackgroundJob.mockResolvedValue("job-1");
});

describe("enqueueAgentRun — LLM-provider preflight wiring (cinatra#1062)", () => {
  it("reads the mount requirement and runs the availability gate, then enqueues", async () => {
    const requirement = { preferredProvider: "gemini", capabilityRequired: "media_input" };
    readLlmRequirementFromMount.mockResolvedValue(requirement);
    assertLlmProviderAvailableForRun.mockResolvedValue(undefined);

    await enqueueAgentRun({ runId: "run-1" }, { agentPackage: PKG });

    expect(readLlmRequirementFromMount).toHaveBeenCalledWith(PKG.name, PKG.version);
    expect(assertLlmProviderAvailableForRun).toHaveBeenCalledWith(requirement);
    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);
  });

  it("blocks the enqueue when the availability gate rejects (missing/unconfigured provider)", async () => {
    readLlmRequirementFromMount.mockResolvedValue({ capabilityRequired: "media_input" });
    assertLlmProviderAvailableForRun.mockRejectedValue(
      new LlmProviderNotConfiguredError("no configured provider"),
    );

    await expect(enqueueAgentRun({ runId: "run-2" }, { agentPackage: PKG })).rejects.toMatchObject({
      code: "LLM_PROVIDER_NOT_CONFIGURED",
      settingsHref: "/configuration/llm",
    });
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("skips the gate when the agent declares no llm requirement (no signal)", async () => {
    readLlmRequirementFromMount.mockResolvedValue(undefined);
    await enqueueAgentRun({ runId: "run-3" }, { agentPackage: { name: "@cinatra-ai/plain-agent", version: "1.0.0" } });
    expect(assertLlmProviderAvailableForRun).not.toHaveBeenCalled();
    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);
  });

  it("does not run the gate for callers that omit agentPackage", async () => {
    await enqueueAgentRun({ runId: "run-4" }, {});
    expect(readLlmRequirementFromMount).not.toHaveBeenCalled();
    expect(assertLlmProviderAvailableForRun).not.toHaveBeenCalled();
    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);
  });

  it("softPreflight: logs and proceeds instead of blocking (dev-preview)", async () => {
    readLlmRequirementFromMount.mockResolvedValue({ capabilityRequired: "media_input" });
    assertLlmProviderAvailableForRun.mockRejectedValue(
      new LlmProviderNotConfiguredError("no configured provider"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await enqueueAgentRun({ runId: "run-5" }, { softPreflight: true, agentPackage: PKG });
    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
