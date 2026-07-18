/**
 * Unit tests for the run-scoped HITL prompt primitives (#1794):
 *   agent_run_hitl_prompts_list
 *   agent_run_hitl_prompts_exclude
 *
 * Contract under test (handler level; the store-level (run, agent) predicate is
 * proven against a real DB in the sibling .integration.test.ts):
 *   - the run id is derived from a VERIFIED channel only — the OBO
 *     `delegation:"agent_run"` actor or the seam-stamped `verifiedRunScopeId` —
 *     NEVER from caller input NOR from the forgeable ambient `runId` (which the
 *     transport also fills from the `x-cinatra-run-id` header);
 *   - the declaring agent package is derived from the run's template, not input;
 *   - cross-run / cross-agent / unknown-id are rejected;
 *   - exclude is idempotent and batch-bounded;
 *   - no verified run context ⇒ fail closed;
 *   - a run-access denial surfaces a denial audit + a safe error.
 *
 * Uses the REAL mcpRequestContextStorage ALS (not mocked) to establish the
 * run-bound invocation frame, exactly as the deterministic passthrough seam and
 * the agent-run OBO transport do in production.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";

// ---------------------------------------------------------------------------
// Auth-session mock (resolveRoleHintsFromSession reads getAuthSession)
// ---------------------------------------------------------------------------
const authSessionMock = vi.hoisted(() => ({
  getAuthSession: vi.fn(async (): Promise<unknown> => null),
  isPlatformAdmin: vi.fn(() => false),
  requireAuthSession: vi.fn(),
}));
vi.mock("@/lib/auth-session", () => authSessionMock);

// ---------------------------------------------------------------------------
// Store mock
// ---------------------------------------------------------------------------
const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readAllHitlPromptsForRun: vi.fn(),
  updateHitlPromptsExcludedForRunAgent: vi.fn(),
  // referenced while the handler map is constructed (never called here)
  createAgentTemplate: vi.fn(),
  createAgentVersion: vi.fn(),
  readAgentVersionsByTemplate: vi.fn(),
  createAgentRun: vi.fn(),
  readAgentTemplates: vi.fn(),
  readAgentRuns: vi.fn(),
  readAgentRunsByTemplate: vi.fn(),
  readAgentRunsByTemplateRaw: vi.fn(),
  readAgentRunMessages: vi.fn(),
  appendAgentRunMessage: vi.fn(),
  transitionRunStatus: vi.fn(),
  RunTransitionError: class extends Error {},
  updateAgentTemplate: vi.fn(),
  deleteAgentTemplate: vi.fn(),
  resolveDefaultOrgId: vi.fn(async () => "org-1"),
  readAgentTemplateVersions: vi.fn(),
  readAgentTemplateVersionById: vi.fn(),
  diffSnapshots: vi.fn(),
  createAgentTemplateVersionIfChanged: vi.fn(),
  rollbackAgentTemplateToVersion: vi.fn(),
  setAgentTemplatePackageName: vi.fn(),
  bulkStopAgentRuns: vi.fn(),
  bulkStopAgentRunsByTemplate: vi.fn(),
  readAgentTemplateByPackageName: vi.fn(),
  updateAgentTemplatePackageVersion: vi.fn(),
  writeHitlPrompt: vi.fn(),
  readRunCoOwners: vi.fn(async () => []),
  resolveRunCoOwnerUserIds: vi.fn(async () => []),
}));
vi.mock("../store", () => storeMock);

// ---------------------------------------------------------------------------
// auth-policy mock
// ---------------------------------------------------------------------------
const authPolicyMock = vi.hoisted(() => ({
  enforceRunAccess: vi.fn(async () => undefined) as ReturnType<typeof vi.fn>,
}));
vi.mock("../auth-policy", () => authPolicyMock);

// ---------------------------------------------------------------------------
// authz mock — logAuditEvent + AuthzError + POLICY_VERSION + can
// ---------------------------------------------------------------------------
const authzMock = vi.hoisted(() => ({
  logAuditEvent: vi.fn(async () => undefined),
  POLICY_VERSION: "1.0",
  can: vi.fn(async () => true),
  AuthzError: class extends Error {
    statusCode: number;
    reason: string;
    constructor({ statusCode, reason, message }: { statusCode: number; reason: string; message: string }) {
      super(message);
      this.statusCode = statusCode;
      this.reason = reason;
    }
  },
}));
vi.mock("@/lib/authz", () => authzMock);

// ---------------------------------------------------------------------------
// Transitive dep mocks — keep the handlers.ts import graph light (mirrors
// mcp-run-read-policy.test.ts).
// ---------------------------------------------------------------------------
vi.mock("../compiler", () => ({ compileWorkflow: vi.fn() }));
vi.mock("../wayflow-url", () => ({ resolveWayflowUrl: vi.fn(), AGENT_RUN_TIMEOUT_MAX_SECONDS: 3600 }));
vi.mock("../verdaccio/client", () => ({
  deleteAgentPackageVersion: vi.fn(),
  deprecateAgentPackageVersion: vi.fn(),
  publishAgentPackage: vi.fn(),
  publishAgentPackageFromGitDir: vi.fn(),
}));
vi.mock("../verdaccio/publish-metadata", () => ({ derivePublishMetadataFromSnapshot: vi.fn() }));
vi.mock("../install-from-package", () => ({ installAgentFromPackage: vi.fn() }));
vi.mock("@cinatra-ai/registries", () => ({
  isSafePathSegment: (s: unknown): boolean => typeof s === "string",
  assertSafePathSegment: (): void => undefined,
  listAgentPackages: vi.fn(),
}));
vi.mock("@cinatra-ai/skills", () => ({ upsertSkill: vi.fn(), parseFrontmatter: vi.fn() }));
vi.mock("../review-task-actions", () => ({ approveReviewTaskInternal: vi.fn() }));
vi.mock("../trigger-service", () => ({
  setRunTriggerForActor: vi.fn(),
  getRunTriggerForActor: vi.fn(),
  deleteRunTriggerForActor: vi.fn(),
}));
vi.mock("@cinatra-ai/objects", () => ({ createDeterministicObjectsClient: vi.fn(() => ({})) }));
vi.mock("../agent-runtime-mount", () => ({ resolveAgentRuntimeMountDir: vi.fn(), resolveDevExtensionSourceRoot: vi.fn() }));
vi.mock("../zip-helpers", () => ({ createZipBuffer: vi.fn() }));
vi.mock("../validate-agent-json", () => ({ validateOasAgentJson: vi.fn() }));
vi.mock("../oas-compiler", () => ({ compileOasAgentJson: vi.fn() }));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(async () => undefined),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent_builder_execution" },
}));
vi.mock("@/lib/primitive-handlers", () => ({ collectAllPrimitiveHandlers: vi.fn(() => ({})) }));
vi.mock("@/lib/mcp-pagination", () => ({
  decodeCursor: vi.fn(() => 0),
  buildListPage: vi.fn((items: unknown[], total: number) => ({ items, total, nextCursor: null })),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  readUserById: vi.fn(async () => ({ id: "u" })),
}));

// ---------------------------------------------------------------------------
type HandlerMap = Record<string, (req: Record<string, unknown>) => Promise<unknown>>;

async function getHandlers(): Promise<HandlerMap> {
  const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
  return createAgentBuilderPrimitiveHandlers() as HandlerMap;
}

const RUN_ID = "run-ctx-1";
const ORG_ID = "org-1";
const OWNER_ID = "owner-1";
const PKG = "@cinatra-ai/auditor-agent";

const RUN = {
  id: RUN_ID,
  templateId: "tpl-1",
  runBy: OWNER_ID,
  orgId: ORG_ID,
  status: "pending_approval",
  oboCeiling: null,
};

const OWNER_ACTOR = { userId: OWNER_ID, actorType: "human", source: "mcp" } as const;

function prompt(id: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    runId: RUN_ID,
    agentId: PKG,
    stepKey: `step-${id}`,
    message: `msg-${id}`,
    capturedAt: new Date("2026-07-18T00:00:00.000Z"),
    excluded: false,
    submittedValues: { field: id },
    schemaSnapshot: null,
    ...over,
  };
}

/**
 * The deterministic bridge seam (/api/agents/passthrough) stamps a VERIFIED
 * run scope (`verifiedRunScopeId`). We also set the ambient `runId` to a
 * DIFFERENT value to prove the handler trusts the verified field, not the
 * forgeable `runId`.
 */
async function withVerifiedRunContext<T>(
  runId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return mcpRequestContextStorage.run(
    { verifiedRunScopeId: runId, runId: "run-HEADER-FORGED", userId: OWNER_ID, orgId: ORG_ID },
    fn,
  );
}

/** An OBO agent-run delegated actor — its runId is a signed token claim. */
async function withOboRunContext<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  return mcpRequestContextStorage.run(
    {
      runId,
      userId: OWNER_ID,
      orgId: ORG_ID,
      delegatedActor: {
        delegation: "agent_run",
        userId: OWNER_ID,
        orgId: ORG_ID,
        runId,
        platformRole: "member",
        oboCeiling: [{ tier: "user", id: OWNER_ID }],
      },
    },
    fn,
  );
}

/** A bare/forged ambient runId with NO verified channel — must fail closed. */
async function withForgedHeaderRunId<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  return mcpRequestContextStorage.run({ runId, userId: OWNER_ID, orgId: ORG_ID }, fn);
}

beforeEach(() => {
  vi.clearAllMocks();
  authSessionMock.getAuthSession.mockResolvedValue(null);
  authPolicyMock.enforceRunAccess.mockResolvedValue(undefined);
  storeMock.readAgentRunById.mockResolvedValue({ ...RUN });
  storeMock.readAgentTemplateById.mockResolvedValue({ id: "tpl-1", packageName: PKG });
});

// ===========================================================================
// agent_run_hitl_prompts_list
// ===========================================================================
describe("agent_run_hitl_prompts_list", () => {
  it("returns a run-scoped snapshot (ISO capturedAt) for the declaring agent package", async () => {
    const handlers = await getHandlers();
    storeMock.readAllHitlPromptsForRun.mockResolvedValueOnce([prompt("p1"), prompt("p2", { excluded: true })]);

    const result = (await withVerifiedRunContext(RUN_ID, () =>
      handlers["agent_run_hitl_prompts_list"]({
        primitiveName: "agent_run_hitl_prompts_list",
        input: {},
        actor: OWNER_ACTOR,
        mode: "deterministic",
      }),
    )) as { runId: string; agentPackageName: string; prompts: Array<Record<string, unknown>> };

    expect(result.runId).toBe(RUN_ID);
    expect(result.agentPackageName).toBe(PKG);
    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0]).toEqual({
      id: "p1",
      stepKey: "step-p1",
      message: "msg-p1",
      excluded: false,
      submittedValues: { field: "p1" },
      schemaSnapshot: null,
      capturedAt: "2026-07-18T00:00:00.000Z",
    });
    // scoped to the CONTEXT run + declaring package
    expect(storeMock.readAllHitlPromptsForRun).toHaveBeenCalledWith(RUN_ID, PKG);
  });

  it("derives the run id from context and IGNORES a caller-supplied runId", async () => {
    const handlers = await getHandlers();
    storeMock.readAllHitlPromptsForRun.mockResolvedValueOnce([]);

    await withVerifiedRunContext(RUN_ID, () =>
      handlers["agent_run_hitl_prompts_list"]({
        primitiveName: "agent_run_hitl_prompts_list",
        input: { runId: "run-EVIL", agentPackageName: "@evil/pkg" },
        actor: OWNER_ACTOR,
        mode: "deterministic",
      }),
    );

    expect(storeMock.readAgentRunById.mock.calls[0][0]).toBe(RUN_ID);
    expect(storeMock.readAllHitlPromptsForRun).toHaveBeenCalledWith(RUN_ID, PKG);
  });

  it("fails closed when there is no run context on the frame", async () => {
    const handlers = await getHandlers();
    const result = (await withVerifiedRunContext(undefined, () =>
      handlers["agent_run_hitl_prompts_list"]({
        primitiveName: "agent_run_hitl_prompts_list",
        input: {},
        actor: OWNER_ACTOR,
        mode: "deterministic",
      }),
    )) as { error?: string };

    expect(result.error).toMatch(/verified run context/i);
    expect(storeMock.readAgentRunById).not.toHaveBeenCalled();
    expect(storeMock.readAllHitlPromptsForRun).not.toHaveBeenCalled();
  });

  it("surfaces a denial (safe error + denial audit) when run access is denied", async () => {
    const handlers = await getHandlers();
    storeMock.readAgentRunById.mockRejectedValueOnce(
      new authzMock.AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." }),
    );

    const result = (await withVerifiedRunContext(RUN_ID, () =>
      handlers["agent_run_hitl_prompts_list"]({
        primitiveName: "agent_run_hitl_prompts_list",
        input: {},
        actor: { userId: "intruder", actorType: "human", source: "mcp" },
        mode: "deterministic",
      }),
    )) as { error?: string };

    expect(result.error).toBe("Run access denied.");
    expect(storeMock.readAllHitlPromptsForRun).not.toHaveBeenCalled();
    expect(authzMock.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "denied", operation: "read", resourceType: "agent_run", resourceId: RUN_ID }),
    );
  });

  it("returns an empty snapshot when the run's template has no declaring package", async () => {
    const handlers = await getHandlers();
    storeMock.readAgentTemplateById.mockResolvedValueOnce({ id: "tpl-1", packageName: null });

    const result = (await withVerifiedRunContext(RUN_ID, () =>
      handlers["agent_run_hitl_prompts_list"]({
        primitiveName: "agent_run_hitl_prompts_list",
        input: {},
        actor: OWNER_ACTOR,
        mode: "deterministic",
      }),
    )) as { agentPackageName: string | null; prompts: unknown[] };

    expect(result.agentPackageName).toBeNull();
    expect(result.prompts).toEqual([]);
    expect(storeMock.readAllHitlPromptsForRun).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// agent_run_hitl_prompts_exclude
// ===========================================================================
describe("agent_run_hitl_prompts_exclude", () => {
  it("excludes scoped ids and reports applied vs requested", async () => {
    const handlers = await getHandlers();
    storeMock.readAllHitlPromptsForRun.mockResolvedValueOnce([prompt("p1"), prompt("p2"), prompt("p3")]);
    storeMock.updateHitlPromptsExcludedForRunAgent.mockResolvedValueOnce(["p1", "p2"]);

    const result = (await withVerifiedRunContext(RUN_ID, () =>
      handlers["agent_run_hitl_prompts_exclude"]({
        primitiveName: "agent_run_hitl_prompts_exclude",
        input: { ids: ["p1", "p2"] },
        actor: OWNER_ACTOR,
        mode: "deterministic",
      }),
    )) as Record<string, unknown>;

    expect(result).toEqual({
      runId: RUN_ID,
      agentPackageName: PKG,
      excluded: true,
      requested: 2,
      applied: 2,
      ids: ["p1", "p2"],
    });
    expect(storeMock.updateHitlPromptsExcludedForRunAgent).toHaveBeenCalledWith(RUN_ID, PKG, ["p1", "p2"], true);
    const [runArg, , opArg] = authPolicyMock.enforceRunAccess.mock.calls[0] as [
      { id: string },
      unknown,
      string,
    ];
    expect(runArg.id).toBe(RUN_ID);
    expect(opArg).toBe("respondToHitl");
  });

  it("is idempotent — re-excluding an already-excluded id still reports it applied", async () => {
    const handlers = await getHandlers();
    storeMock.readAllHitlPromptsForRun.mockResolvedValue([prompt("p1", { excluded: true })]);
    storeMock.updateHitlPromptsExcludedForRunAgent.mockResolvedValue(["p1"]);

    const call = () =>
      withVerifiedRunContext(RUN_ID, () =>
        handlers["agent_run_hitl_prompts_exclude"]({
          primitiveName: "agent_run_hitl_prompts_exclude",
          input: { ids: ["p1"] },
          actor: OWNER_ACTOR,
          mode: "deterministic",
        }),
      );

    const first = (await call()) as { applied: number; ids: string[] };
    const second = (await call()) as { applied: number; ids: string[] };
    expect(first.ids).toEqual(["p1"]);
    expect(second.ids).toEqual(["p1"]);
    expect(second.applied).toBe(1);
  });

  it("rejects the whole batch when any id is unknown for this run + agent (no mutation)", async () => {
    const handlers = await getHandlers();
    // The scoped snapshot has only p1/p2 — a cross-agent / cross-run / stale id
    // is simply not in the set.
    storeMock.readAllHitlPromptsForRun.mockResolvedValueOnce([prompt("p1"), prompt("p2")]);

    const result = (await withVerifiedRunContext(RUN_ID, () =>
      handlers["agent_run_hitl_prompts_exclude"]({
        primitiveName: "agent_run_hitl_prompts_exclude",
        input: { ids: ["p1", "foreign-id"] },
        actor: OWNER_ACTOR,
        mode: "deterministic",
      }),
    )) as { error?: string; unknownIds?: string[] };

    expect(result.error).toMatch(/unknown hitl prompt id/i);
    expect(result.unknownIds).toEqual(["foreign-id"]);
    expect(storeMock.updateHitlPromptsExcludedForRunAgent).not.toHaveBeenCalled();
  });

  it("rejects a batch larger than the bound without touching the store", async () => {
    const handlers = await getHandlers();
    const ids = Array.from({ length: 501 }, (_, i) => `p${i}`);

    const result = (await withVerifiedRunContext(RUN_ID, () =>
      handlers["agent_run_hitl_prompts_exclude"]({
        primitiveName: "agent_run_hitl_prompts_exclude",
        input: { ids },
        actor: OWNER_ACTOR,
        mode: "deterministic",
      }),
    )) as { error?: string };

    expect(result.error).toMatch(/too many ids/i);
    expect(storeMock.readAgentRunById).not.toHaveBeenCalled();
    expect(storeMock.updateHitlPromptsExcludedForRunAgent).not.toHaveBeenCalled();
  });

  it("re-includes when excluded:false is passed", async () => {
    const handlers = await getHandlers();
    storeMock.readAllHitlPromptsForRun.mockResolvedValueOnce([prompt("p1", { excluded: true })]);
    storeMock.updateHitlPromptsExcludedForRunAgent.mockResolvedValueOnce(["p1"]);

    const result = (await withVerifiedRunContext(RUN_ID, () =>
      handlers["agent_run_hitl_prompts_exclude"]({
        primitiveName: "agent_run_hitl_prompts_exclude",
        input: { ids: ["p1"], excluded: false },
        actor: OWNER_ACTOR,
        mode: "deterministic",
      }),
    )) as { excluded: boolean };

    expect(result.excluded).toBe(false);
    expect(storeMock.updateHitlPromptsExcludedForRunAgent).toHaveBeenCalledWith(RUN_ID, PKG, ["p1"], false);
  });

  it("rejects invalid ids input", async () => {
    const handlers = await getHandlers();
    for (const bad of [undefined, [], "p1", [1, 2], [""]]) {
      const result = (await withVerifiedRunContext(RUN_ID, () =>
        handlers["agent_run_hitl_prompts_exclude"]({
          primitiveName: "agent_run_hitl_prompts_exclude",
          input: { ids: bad },
          actor: OWNER_ACTOR,
          mode: "deterministic",
        }),
      )) as { error?: string };
      expect(result.error).toBeTruthy();
    }
    expect(storeMock.updateHitlPromptsExcludedForRunAgent).not.toHaveBeenCalled();
  });

  it("surfaces a denial (safe error + audit) when respondToHitl is denied, without mutating", async () => {
    const handlers = await getHandlers();
    authPolicyMock.enforceRunAccess.mockRejectedValueOnce(
      new authzMock.AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." }),
    );

    const result = (await withVerifiedRunContext(RUN_ID, () =>
      handlers["agent_run_hitl_prompts_exclude"]({
        primitiveName: "agent_run_hitl_prompts_exclude",
        input: { ids: ["p1"] },
        actor: { userId: "intruder", actorType: "human", source: "mcp" },
        mode: "deterministic",
      }),
    )) as { error?: string };

    expect(result.error).toBe("Run access denied.");
    expect(storeMock.updateHitlPromptsExcludedForRunAgent).not.toHaveBeenCalled();
    expect(authzMock.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "denied", resourceId: RUN_ID }),
    );
  });

  it("derives the run id from context and ignores a caller-supplied runId", async () => {
    const handlers = await getHandlers();
    storeMock.readAllHitlPromptsForRun.mockResolvedValueOnce([prompt("p1")]);
    storeMock.updateHitlPromptsExcludedForRunAgent.mockResolvedValueOnce(["p1"]);

    await withVerifiedRunContext(RUN_ID, () =>
      handlers["agent_run_hitl_prompts_exclude"]({
        primitiveName: "agent_run_hitl_prompts_exclude",
        input: { ids: ["p1"], runId: "run-EVIL" },
        actor: OWNER_ACTOR,
        mode: "deterministic",
      }),
    );

    expect(storeMock.updateHitlPromptsExcludedForRunAgent).toHaveBeenCalledWith(RUN_ID, PKG, ["p1"], true);
  });

  it("fails closed when there is no run context", async () => {
    const handlers = await getHandlers();
    const result = (await withVerifiedRunContext(undefined, () =>
      handlers["agent_run_hitl_prompts_exclude"]({
        primitiveName: "agent_run_hitl_prompts_exclude",
        input: { ids: ["p1"] },
        actor: OWNER_ACTOR,
        mode: "deterministic",
      }),
    )) as { error?: string };
    expect(result.error).toMatch(/verified run context/i);
    expect(storeMock.updateHitlPromptsExcludedForRunAgent).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Run-scope verification — the forgeable ambient runId is NEVER trusted.
// ===========================================================================
describe("run-scope verification (never trust the forgeable ambient runId)", () => {
  it("list works under an OBO agent-run delegated actor (signed runId claim)", async () => {
    const handlers = await getHandlers();
    storeMock.readAllHitlPromptsForRun.mockResolvedValueOnce([prompt("p1")]);

    const result = (await withOboRunContext(RUN_ID, () =>
      handlers["agent_run_hitl_prompts_list"]({
        primitiveName: "agent_run_hitl_prompts_list",
        input: {},
        actor: OWNER_ACTOR,
        mode: "agentic",
      }),
    )) as { runId: string; prompts: unknown[] };

    expect(result.runId).toBe(RUN_ID);
    expect(storeMock.readAllHitlPromptsForRun).toHaveBeenCalledWith(RUN_ID, PKG);
  });

  it("list fails closed on a forged ambient runId with no verified channel", async () => {
    const handlers = await getHandlers();
    const result = (await withForgedHeaderRunId(RUN_ID, () =>
      handlers["agent_run_hitl_prompts_list"]({
        primitiveName: "agent_run_hitl_prompts_list",
        input: {},
        actor: OWNER_ACTOR,
        mode: "agentic",
      }),
    )) as { error?: string };

    expect(result.error).toMatch(/verified run context/i);
    expect(storeMock.readAgentRunById).not.toHaveBeenCalled();
    expect(storeMock.readAllHitlPromptsForRun).not.toHaveBeenCalled();
  });

  it("exclude fails closed on a forged ambient runId with no verified channel", async () => {
    const handlers = await getHandlers();
    const result = (await withForgedHeaderRunId(RUN_ID, () =>
      handlers["agent_run_hitl_prompts_exclude"]({
        primitiveName: "agent_run_hitl_prompts_exclude",
        input: { ids: ["p1"] },
        actor: OWNER_ACTOR,
        mode: "agentic",
      }),
    )) as { error?: string };

    expect(result.error).toMatch(/verified run context/i);
    expect(storeMock.updateHitlPromptsExcludedForRunAgent).not.toHaveBeenCalled();
  });

  it("exclude rejects an oversized RAW batch even when duplicates would dedupe under the bound", async () => {
    const handlers = await getHandlers();
    // 600 copies of one id — dedupes to 1, but the RAW length exceeds the bound.
    const ids = Array.from({ length: 600 }, () => "dup");
    const result = (await withVerifiedRunContext(RUN_ID, () =>
      handlers["agent_run_hitl_prompts_exclude"]({
        primitiveName: "agent_run_hitl_prompts_exclude",
        input: { ids },
        actor: OWNER_ACTOR,
        mode: "deterministic",
      }),
    )) as { error?: string };

    expect(result.error).toMatch(/too many ids/i);
    expect(storeMock.readAgentRunById).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Seam demonstration — deterministic pre-interrupt call → gate payload.
//
// Mirrors the production seam (`/api/agents/passthrough`): establish a
// run-bound context frame, invoke the primitive DETERMINISTICALLY (mode:
// "deterministic") via the shared handler map, then wire its output into the
// object a downstream DataFlowEdge would route into the interrupt (gate) node.
// ===========================================================================
describe("seam: deterministic pre-interrupt invocation wires prompts into a gate payload", () => {
  it("a prep-node call yields a gate payload carrying only the run's own, non-excluded prompts", async () => {
    const handlers = await getHandlers();
    storeMock.readAllHitlPromptsForRun
      // list snapshot
      .mockResolvedValueOnce([prompt("p1"), prompt("p2"), prompt("bare", { excluded: false })])
      // exclude membership check
      .mockResolvedValueOnce([prompt("p1"), prompt("p2"), prompt("bare")]);
    storeMock.updateHitlPromptsExcludedForRunAgent.mockResolvedValueOnce(["bare"]);

    // The prep node runs entirely inside ONE run-bound frame (as the seam does).
    const gatePayload = await withVerifiedRunContext(RUN_ID, async () => {
      // 1. deterministic list call (pre-interrupt payload assembly)
      const listed = (await handlers["agent_run_hitl_prompts_list"]({
        primitiveName: "agent_run_hitl_prompts_list",
        input: {},
        actor: OWNER_ACTOR,
        mode: "deterministic",
      })) as { prompts: Array<{ id: string }> };

      // 2. deterministic exclude call (drop the bare-approval row pre-interrupt)
      const excluded = (await handlers["agent_run_hitl_prompts_exclude"]({
        primitiveName: "agent_run_hitl_prompts_exclude",
        input: { ids: ["bare"] },
        actor: OWNER_ACTOR,
        mode: "deterministic",
      })) as { ids: string[] };

      // 3. wire the outputs into the gate input (what a DataFlowEdge routes)
      const excludedSet = new Set(excluded.ids);
      return {
        promptsForReview: listed.prompts.filter((p) => !excludedSet.has(p.id)).map((p) => p.id),
        droppedIds: excluded.ids,
      };
    });

    expect(gatePayload.promptsForReview).toEqual(["p1", "p2"]);
    expect(gatePayload.droppedIds).toEqual(["bare"]);
  });
});
