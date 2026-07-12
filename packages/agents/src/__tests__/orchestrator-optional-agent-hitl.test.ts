// cinatra#1058 — orchestrator readiness gate routes a missing OPTIONAL sub-agent
// to STOP-RUN-HITL, while a missing REQUIRED sub-agent still hard-fails (required
// wins when both are missing). Mirrors the execution.ts import scaffold from
// orchestrator-readiness-canonical-agent-edges.test.ts (cinatra#1056).
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

import {
  assertOrchestratorReady,
  OrchestratorOptionalDepsUnavailableError,
} from "../execution";
import type { AgentDependencyMap } from "../schema";

function orchestrator(agentDependencies: AgentDependencyMap) {
  return {
    id: "orch-1",
    type: "orchestrator",
    name: "Orchestrator",
    agentDependencies,
  } as never;
}

const installed = { items: [{ packageVersion: "1.0.0" }] };
const absent = { items: [] as { packageVersion: string }[] };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("assertOrchestratorReady — optional-agent stop-run-hitl (cinatra#1058)", () => {
  it("throws OrchestratorOptionalDepsUnavailableError (naming the sub-agent) when ONLY an optional sub-agent is missing", async () => {
    storeMock.readAgentTemplates.mockImplementation(async (q: { packageName: string }) =>
      q.packageName === "@cinatra-ai/present-sub" ? installed : absent,
    );
    const err = await assertOrchestratorReady(
      orchestrator({
        "@cinatra-ai/present-sub": "*",
        "@cinatra-ai/optional-sub": { range: "*", requirement: "optional" },
      }),
    ).then(
      () => null,
      (e) => e as unknown,
    );
    expect(err).toBeInstanceOf(OrchestratorOptionalDepsUnavailableError);
    expect((err as OrchestratorOptionalDepsUnavailableError).missingOptional).toEqual([
      "@cinatra-ai/optional-sub",
    ]);
    expect((err as Error).message).toContain("@cinatra-ai/optional-sub");
    expect((err as Error).message).toMatch(/paused for input/i);
  });

  it("REQUIRED missing hard-fails (NOT the HITL error) even when an optional dep is also missing — required wins", async () => {
    storeMock.readAgentTemplates.mockResolvedValue(absent);
    const err = await assertOrchestratorReady(
      orchestrator({
        "@cinatra-ai/required-sub": "*",
        "@cinatra-ai/optional-sub": { range: "*", requirement: "optional" },
      }),
    ).then(
      () => null,
      (e) => e as unknown,
    );
    expect(err).not.toBeInstanceOf(OrchestratorOptionalDepsUnavailableError);
    expect((err as Error).message).toContain("Orchestrator cannot run");
    expect((err as Error).message).toContain("@cinatra-ai/required-sub");
    // The optional one is not named in the hard-fail copy.
    expect((err as Error).message).not.toContain("@cinatra-ai/optional-sub");
  });

  it("a bare-string (legacy/required) value that is missing hard-fails, unchanged", async () => {
    storeMock.readAgentTemplates.mockResolvedValue(absent);
    await expect(
      assertOrchestratorReady(orchestrator({ "@cinatra-ai/legacy-sub": "*" })),
    ).rejects.toThrow("Orchestrator cannot run");
  });

  it("resolves clean when the optional sub-agent IS installed", async () => {
    storeMock.readAgentTemplates.mockResolvedValue(installed);
    await expect(
      assertOrchestratorReady(
        orchestrator({ "@cinatra-ai/optional-sub": { range: "*", requirement: "optional" } }),
      ),
    ).resolves.toBeUndefined();
  });

  it("resolves clean with NO deps (fast path)", async () => {
    await assertOrchestratorReady(orchestrator({}));
    expect(storeMock.readAgentTemplates).not.toHaveBeenCalled();
  });
});
