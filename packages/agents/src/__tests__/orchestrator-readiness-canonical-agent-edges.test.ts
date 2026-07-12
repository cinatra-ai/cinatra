// cinatra#1056 — orchestrator readiness gate fires on canonical-only agent edges.
//
// The install projection lands REQUIRED canonical `kind:"agent"` edges into
// `agent_templates.agent_dependencies`; the WORKER-side `assertOrchestratorReady`
// gate reads that map and hard-fails (naming the package) when a declared
// sub-agent is not installed. This proves the composition end-to-end for a
// canonical-only orchestrator (no legacy `agentDependencies` map). Reuses the
// execution.ts import scaffold from execution-enrichment.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readAgentTemplates: vi.fn(
    async (_q: { packageName: string }): Promise<{ items: { packageVersion: string }[] }> => ({ items: [] }),
  ),
  readAgentTemplateVersionBySemver: vi.fn(async () => null),
  readAgentTemplateVersionById: vi.fn(async () => null),
  transitionRunStatus: vi.fn(async () => undefined),
  RunTransitionError: class RunTransitionError extends Error {
    code: string;
    constructor(code: string, msg: string) {
      super(msg);
      this.code = code;
    }
  },
  findSavedConnectionForAgentUrl: vi.fn(async () => null),
  updateAgentRunA2ATaskId: vi.fn(async () => undefined),
  updateAgentRunA2AContextId: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);
vi.mock("../trigger-gate", () => ({ isTriggerReleased: vi.fn(async () => true) }));
vi.mock("../skill-autosave", () => ({
  runSkillAutosaveOnRunCompletion: vi.fn(async () => undefined),
}));
vi.mock("../wayflow-url", () => ({
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
}));
vi.mock("@cinatra-ai/agent-ui-protocol/server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    enrichSchemaWithResolvedData: vi.fn(async (s: unknown) => s),
    DualAdapterDispatch: class {
      onInterrupt = vi.fn();
      onText = vi.fn();
      onTextChunk = vi.fn();
      onToolCall = vi.fn();
      onState = vi.fn();
      onError = vi.fn();
      onFinish = vi.fn();
      onResume = vi.fn();
    },
  };
});

import { assertOrchestratorReady } from "../execution";

function orchestrator(agentDependencies: Record<string, string>) {
  return {
    id: "orch-1",
    type: "orchestrator",
    name: "Orchestrator",
    // Only the fields assertOrchestratorReady reads matter; the rest are cast away.
    agentDependencies,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("assertOrchestratorReady — canonical-only agent edges (cinatra#1056)", () => {
  it("throws NAMING the missing sub-agent when a required canonical agent edge is not installed", async () => {
    storeMock.readAgentTemplates.mockImplementation(async (q: { packageName: string }) =>
      q.packageName === "@cinatra-ai/present-sub"
        ? { items: [{ packageVersion: "1.0.0" }] }
        : { items: [] },
    );
    await expect(
      assertOrchestratorReady(
        orchestrator({
          "@cinatra-ai/present-sub": "*",
          "@cinatra-ai/missing-sub": "*",
        }),
      ),
    ).rejects.toThrow("@cinatra-ai/missing-sub");
  });

  it("resolves when every canonical agent edge resolves to an installed published sub-agent", async () => {
    storeMock.readAgentTemplates.mockResolvedValue({ items: [{ packageVersion: "1.0.0" }] });
    await expect(
      assertOrchestratorReady(orchestrator({ "@cinatra-ai/sub-a": "*", "@cinatra-ai/sub-b": "*" })),
    ).resolves.toBeUndefined();
  });

  it("short-circuits a leaf template (no DB read, no gate)", async () => {
    await assertOrchestratorReady({ id: "leaf", type: "leaf", agentDependencies: {} } as never);
    expect(storeMock.readAgentTemplates).not.toHaveBeenCalled();
  });
});
