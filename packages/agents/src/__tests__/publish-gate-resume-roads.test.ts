// cinatra#4150 (A5): before a publish decision is released, no road sends a message into
// the run's held context. This file pins the road list against every product
// `.sendTask(` call site (so a new send cannot land without a decision about it), pins the
// hold before the send on every resume road, drives the stopped-orchestrator resume,
// and pins the two facts the rest of the change rests on: the gate prefix matches the
// compiler's, and the expiry rides a loop that no feature fence switches off.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

function at(haystack: string, needle: string, from = 0): number {
  const i = haystack.indexOf(needle, from);
  expect(i, `anchor not found: ${JSON.stringify(needle)}`).toBeGreaterThan(-1);
  return i;
}

/**
 * Every product `.sendTask(` call, by file. A comment line is not a call. The road list
 * below must equal this reading exactly, one call per file.
 */
function productSendTaskCalls(): Record<string, number> {
  const out = execFileSync(
    "git",
    ["grep", "-n", "-F", ".sendTask(", "--", "src", "packages",
      ":(exclude)**/__tests__/**", ":(exclude)**/*.test.*", ":(exclude)**/*.spec.*", ":(exclude)**/tests/**"],
    { cwd: REPO, encoding: "utf8" },
  );
  const calls: Record<string, number> = {};
  for (const line of out.split("\n").filter(Boolean)) {
    const [file, , ...rest] = line.split(":");
    const code = rest.join(":").trim();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;
    calls[file!] = (calls[file!] ?? 0) + 1;
  }
  return calls;
}

/** The decision taken for each send. A resume road reads the hold before it sends. */
const ROADS: Record<string, "resume" | "initial-dispatch" | "new-conversation"> = {
  // the generic `wayflow-` approve
  "packages/agents/src/review-task-actions.ts": "resume",
  // agent_run_resume
  "packages/agents/src/mcp/handlers.ts": "resume",
  // the artifact-review resume delivery
  "packages/agents/src/artifact-review-resume-delivery.ts": "resume",
  // the stopped-orchestrator resume
  "packages/agents/src/orchestrator-actions.ts": "resume",
  // the run's first message; the publish gate is reached only after it
  "packages/agents/src/execution.ts": "initial-dispatch",
  // the content-editor dispatch: a NEW carrier run, sent with no context id, so it
  // starts a new conversation and can never reach a held gate
  "src/lib/host-content-editor-dispatch.ts": "new-conversation",
};

/** Where each resume road claims or moves the run; the hold comes before it. */
const RESUME_ROAD_ANCHORS: Record<string, { from: string; claim: string | null }> = {
  "packages/agents/src/review-task-actions.ts": {
    from: 'if (reviewTaskId.startsWith("wayflow-"))',
    claim: "THE GATE IS DECIDED ONCE",
  },
  "packages/agents/src/mcp/handlers.ts": {
    from: "async function handleAgentBuilderRunResume(",
    claim: "await writeHitlPrompt(",
  },
  "packages/agents/src/artifact-review-resume-delivery.ts": {
    from: "export async function deliverArtifactReviewResumeIntent(",
    claim: null,
  },
  "packages/agents/src/orchestrator-actions.ts": {
    from: "export async function resumeStoppedOrchestratorAction(",
    claim: 'transitionRunStatus(runId, "stopped", "queued"',
  },
};

describe("the road list equals the product sendTask call sites", () => {
  it("every send is a decided road, and every decided road has exactly one send", () => {
    expect(productSendTaskCalls()).toEqual(Object.fromEntries(Object.keys(ROADS).map((f) => [f, 1])));
  });

  it.each(Object.keys(RESUME_ROAD_ANCHORS))("%s reads the hold before it claims the run or sends", (file) => {
    const src = read(file);
    const { from, claim } = RESUME_ROAD_ANCHORS[file]!;
    const start = at(src, from);
    const send = at(src, ".sendTask(", start);
    const hold = at(src, "assertNoOpenPublishDecision(", start);
    expect(hold).toBeLessThan(send);
    if (claim) expect(hold).toBeLessThan(at(src, claim, start));
  });

  it("the content-editor send carries no context id", () => {
    const src = read("src/lib/host-content-editor-dispatch.ts");
    const send = at(src, ".sendTask(");
    const message = src.slice(send, at(src, "configuration:", send));
    expect(message).not.toContain("contextId");
  });
});

describe("the facts the hold rests on", () => {
  it("the host's publish-gate prefix is the compiler's reserved prefix", () => {
    const compiler = read("packages/agents/src/oas-compiler.ts");
    const actions = read("packages/agents/src/publish-decision-actions.ts");
    const reserved = /const PUBLISH_GATE_ID_PREFIX = "([^"]+)";/.exec(compiler)?.[1];
    const host = /export const PUBLISH_GATE_NODE_PREFIX = "([^"]+)";/.exec(actions)?.[1];
    expect(reserved).toBe("cinatra_publish_gate__");
    expect(host).toBe(reserved);
  });

  it("the input-required branch classifies the publish gate before any renderer or review is offered", () => {
    const src = read("packages/agents/src/execution.ts");
    const branch = at(src, 'if (taskState === "input-required") {');
    const hold = at(src, "await holdRunAtPublishGate(", branch);
    expect(hold).toBeLessThan(at(src, "new DualAdapterDispatch(", branch));
    expect(hold).toBeLessThan(at(src, "resolveWayflowXRenderer(", branch));
  });

  it("the expiry rides the resume-delivery loop, which reads no feature fence", () => {
    const src = read("src/lib/boot/phases/system-loops.ts");
    const start = at(src, 'name: "seed-artifact-review-resume-delivery"');
    const end = at(src, 'name: "', start + 10);
    const phase = src.slice(start, end);
    expect(phase).toContain("sweepExpiredPublishDecisionsOnce()");
    expect(phase.indexOf("sweepExpiredPublishDecisionsOnce()")).toBeLessThan(
      phase.indexOf("sweepArtifactReviewResumeIntents()"),
    );
    expect(phase).not.toMatch(/isLifecycleReviewOrchestrationActive|isReviewActive|Fence\(|fence\(/);
    const delivery = read("packages/agents/src/artifact-review-resume-delivery.ts");
    expect(delivery).not.toMatch(/isLifecycleReviewOrchestrationActive|lifecycle-activation/);
    expect(delivery).toContain("sweepExpiredPublishDecisions({ authorityFor: mintAgentRunExecutionAuthority })");
  });

  it("no lifecycle moment is written for a publish gate in this part", () => {
    const actions = read("packages/agents/src/publish-decision-actions.ts");
    expect(actions).not.toMatch(/onPublishGate|lifecycle-coordinator|lifecycleMoment/);
  });
});

// ---------------------------------------------------------------------------
// The stopped-orchestrator resume, driven. A declined or expired run is stopped while
// its context still holds the publish gate, so this road is the one that would send
// "[Resumed by operator after stop]" into it.
// ---------------------------------------------------------------------------

const session = vi.hoisted(() => ({
  getAuthSession: vi.fn(async () => ({ user: { id: "user-a" } }) as unknown),
  isPlatformAdmin: vi.fn(() => false),
  resolveOrgRoleForUser: vi.fn(async () => "member" as string | undefined),
}));
vi.mock("@/lib/auth-session", () => session);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunsByParent: vi.fn(async () => []),
  readAgentTemplateById: vi.fn(),
  readRunCoOwners: vi.fn(async () => []),
  transitionRunStatus: vi.fn(async () => undefined),
  RunTransitionError: class RunTransitionError extends Error {
    code = "stale_from_status";
  },
}));
vi.mock("../store", () => storeMock);
vi.mock("../orchestrator-execution", () => ({ cancelOrchestratorRun: vi.fn() }));
vi.mock("../wayflow-run-token-carrier", () => ({ mintResumeRunTokenMetadata: vi.fn(async () => ({ token: "t" })) }));
vi.mock("../wayflow-url", () => ({
  WAYFLOW_A2A_TIMEOUT_MS: 86_400_000,
  createWayflowFetch: vi.fn(() => globalThis.fetch),
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
}));
vi.mock("@cinatra-ai/agent-ui-protocol/server", () => ({ publishAgUiEvent: vi.fn(async () => undefined) }));
const sendTask = vi.hoisted(() => vi.fn(async () => ({ id: "task-2", status: { state: "working" } })));
vi.mock("@cinatra-ai/a2a", () => ({ createExternalA2AClient: vi.fn(async () => ({ sendTask })) }));

const decisions = vi.hoisted(() => ({
  readLatestDecisionForRun: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("../publish-decision-store", () => ({
  readLatestDecisionForRun: decisions.readLatestDecisionForRun,
  readOpenDecisionForRun: vi.fn(async () => null),
  insertParkedDecision: vi.fn(),
  decide: vi.fn(),
  listDueParked: vi.fn(async () => []),
  listSettledWithWaitingRun: vi.fn(async () => []),
}));

import { resumeStoppedOrchestratorAction } from "../orchestrator-actions";

describe("the stopped-orchestrator resume and a publish decision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-1", templateId: "tmpl-1", orgId: "org-1", runBy: "user-a", status: "stopped", a2aContextId: "ctx-1",
    });
    storeMock.readAgentTemplateById.mockResolvedValue({ id: "tmpl-1", packageName: "@cinatra-ai/web-research-agent" });
    decisions.readLatestDecisionForRun.mockResolvedValue(null);
  });

  it.each(["declined", "expired", "run_ended", "parked"])(
    "a run whose newest decision is %s is refused publish_decision_required and is sent nothing",
    async (status) => {
      decisions.readLatestDecisionForRun.mockResolvedValue({ id: "d1", runId: "run-1", status });
      expect(await resumeStoppedOrchestratorAction("run-1")).toEqual({ ok: false, error: "publish_decision_required" });
      expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
      expect(sendTask).not.toHaveBeenCalled();
    },
  );

  it("an unreadable decision record refuses too", async () => {
    decisions.readLatestDecisionForRun.mockRejectedValue(new Error("db down"));
    await expect(resumeStoppedOrchestratorAction("run-1")).rejects.toThrow("db down");
    expect(sendTask).not.toHaveBeenCalled();
  });

  it("a run with no decision, or a released one, is resumed as before", async () => {
    expect(await resumeStoppedOrchestratorAction("run-1")).toEqual({ ok: true });
    decisions.readLatestDecisionForRun.mockResolvedValue({ id: "d1", runId: "run-1", status: "released" });
    expect(await resumeStoppedOrchestratorAction("run-1")).toEqual({ ok: true });
    expect(sendTask).toHaveBeenCalledTimes(2);
  });
});
