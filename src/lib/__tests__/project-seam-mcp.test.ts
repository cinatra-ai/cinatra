import { describe, it, expect, vi, beforeEach } from "vitest";

// Unit tests for the project-manager host tool seam (cinatra#1033 W3). The W2
// PRIMITIVES (instantiateProject / dispatchProjectWorker), the agents store, the
// instance + lease stores, the provider selection, and the template resolver are
// mocked — their own behavior is proven by the #1032 tests. What these tests
// prove is the SEAM's own contract:
//   * run-token authentication is FAIL-CLOSED (no run id / no OBO ceiling / a run
//     id that does not resolve to a run in the token's org → rejected), on every
//     tool;
//   * OBO scope-ceiling containment confines a run to its anchored project;
//   * the host binds every trust operand server-side (orgId, pmAgentPackage,
//     items, lease, parentRunId) and the advertised schema is the reciprocal pin
//     of the agent-suppliable field split (a smuggled trust operand is refused);
//   * the happy instantiate / tick / dispatch paths compose the primitives with
//     the host-derived operands.
// The REAL pure functions (resourceWithinCeiling, materializeProjectTemplate,
// readyItems) run unmocked, and the REAL mcpRequestContextStorage carries the
// run frame — the same run-identity spine production uses.

const mocks = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readProjectInstance: vi.fn(),
  acquireProjectLease: vi.fn(),
  instantiateProject: vi.fn(),
  dispatchProjectWorker: vi.fn(),
  resolvePersistedPmWorkStore: vi.fn(),
  resolveInstalledProjectTemplate: vi.fn(),
}));

vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: mocks.readAgentRunById,
  readAgentTemplateById: mocks.readAgentTemplateById,
}));
vi.mock("@cinatra-ai/agents/project-instance-store", () => ({
  readProjectInstance: mocks.readProjectInstance,
}));
vi.mock("@cinatra-ai/agents/project-lease-store", () => ({
  acquireProjectLease: mocks.acquireProjectLease,
}));
vi.mock("@/lib/project-instantiation", () => ({
  instantiateProject: mocks.instantiateProject,
}));
vi.mock("@/lib/project-dispatch", () => ({
  dispatchProjectWorker: mocks.dispatchProjectWorker,
}));
vi.mock("@/lib/pm-work-store-selection", () => ({
  resolvePersistedPmWorkStore: mocks.resolvePersistedPmWorkStore,
}));
vi.mock("@/lib/project-template-resolve", () => ({
  resolveInstalledProjectTemplate: mocks.resolveInstalledProjectTemplate,
}));

import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import type { OboCeilingChain } from "@cinatra-ai/mcp-server/obo-ceiling";
import {
  PROJECT_TEMPLATE_FORMAT_VERSION,
  type ProjectTemplate,
} from "@cinatra-ai/sdk-extensions/project-template-contract";
import {
  registerProjectSeamPrimitives,
  PROJECT_SEAM_AGENT_SUPPLIED,
  PROJECT_SEAM_FORBIDDEN_FIELDS,
} from "@/lib/project-seam-mcp";

// ── fixtures ─────────────────────────────────────────────────────────────────

const ORG = "org-1";
const RUN = "run-tick-1";
const PM_PKG = "@cinatra-ai/project-manager-agent";
const TEMPLATE_PKG = "@cinatra-ai/release-announcement-agent";
const WORKER_PKG = "@cinatra-ai/draft-writer-agent";
const PROJECT_REF = "proj";

const orgCeiling: OboCeilingChain = [{ tier: "organization", id: ORG }];
const projectCeiling = (pid: string): OboCeilingChain => [
  { tier: "organization", id: ORG },
  { tier: "project", id: pid },
];

const template: ProjectTemplate = {
  formatVersion: PROJECT_TEMPLATE_FORMAT_VERSION,
  id: "launch-plan",
  name: "Launch plan",
  anchor: { id: "launch" },
  tasks: [
    {
      id: "draft",
      title: "Write the draft",
      worker: {
        role: "draft-writer",
        packageName: WORKER_PKG,
        versionConstraint: { kind: "exact", version: "1.0.0" },
      },
    },
    { id: "review", title: "Human review", approval: { id: "gate-review", assigneeRole: "editor" } },
  ],
};

function instance(overrides: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    projectRef: PROJECT_REF,
    projectId: null,
    templatePackage: TEMPLATE_PKG,
    templateId: "launch-plan",
    templateDigest: "sha256:x",
    pmAgentPackage: PM_PKG,
    providerId: "plane",
    providerMode: "auto",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

type EnvelopeResult = { structuredContent: Record<string, unknown> };
type ToolConfig = { inputSchema: { shape: Record<string, unknown> } };
type CapturedHandler = (input: unknown) => Promise<EnvelopeResult>;
type Frame = {
  runId?: string;
  orgId?: string | null;
  oboCeiling?: OboCeilingChain;
  delegatedRestricted?: boolean;
  delegatedActor?:
    | { delegation: "chat"; userId: string; orgId: string | null; platformRole: "platform_admin" | "member" }
    | {
        delegation: "agent_run";
        userId: string;
        orgId: string;
        runId: string;
        platformRole: "platform_admin" | "member";
        oboCeiling: OboCeilingChain;
      };
};

/** Register the seam against a capturing fake server and return the tool table. */
function captureTools() {
  const tools = new Map<string, { config: ToolConfig; handler: CapturedHandler }>();
  const server = {
    registerTool: (name: string, config: ToolConfig, handler: CapturedHandler) => {
      tools.set(name, { config, handler });
    },
  } as unknown as McpRuntimeToolServer;
  registerProjectSeamPrimitives(server);
  return tools;
}

const TOOLS = captureTools();

/** Invoke a tool's handler inside a run-context frame (or none). */
async function call(name: string, input: unknown, frame?: Frame): Promise<Record<string, unknown>> {
  const entry = TOOLS.get(name)!;
  const run = () => entry.handler(input);
  const result = frame ? await mcpRequestContextStorage.run(frame, run) : await run();
  return result.structuredContent;
}

function validFrame(oboCeiling: OboCeilingChain = orgCeiling) {
  return { runId: RUN, orgId: ORG, oboCeiling };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the calling run resolves to a live run in ORG whose agent is the PM seat.
  mocks.readAgentRunById.mockResolvedValue({ id: RUN, orgId: ORG, templateId: "tpl-pm", runBy: "user-1" });
  mocks.readAgentTemplateById.mockResolvedValue({ packageName: PM_PKG });
});

// ── the reciprocal contract pin ──────────────────────────────────────────────

describe("registration + advertised schema (the reciprocal host-side pin)", () => {
  it("registers exactly the three project host tools", () => {
    expect([...TOOLS.keys()].sort()).toEqual([
      "project_dispatch_worker",
      "project_instantiate",
      "project_tick_context",
    ]);
  });

  it("advertises EXACTLY the pinned agent-suppliable fields per tool", () => {
    for (const [name, expected] of Object.entries(PROJECT_SEAM_AGENT_SUPPLIED)) {
      const shape = TOOLS.get(name)!.config.inputSchema.shape;
      expect(Object.keys(shape).sort()).toEqual([...expected].sort());
    }
  });

  it("never advertises a trust operand, and .strict() refuses a smuggled one", async () => {
    for (const name of Object.keys(PROJECT_SEAM_AGENT_SUPPLIED)) {
      const shape = TOOLS.get(name)!.config.inputSchema.shape;
      for (const forbidden of PROJECT_SEAM_FORBIDDEN_FIELDS) {
        expect(Object.keys(shape)).not.toContain(forbidden);
      }
    }
    // A dispatch call smuggling parentRunId is refused at the strict parse.
    const out = await call(
      "project_dispatch_worker",
      { projectRef: PROJECT_REF, pick: "proj/draft", role: "draft-writer", asOf: "2026-07-14", actionVersion: 0, runInput: {}, parentRunId: "attacker" },
      validFrame(),
    );
    expect(out.status).toBe("rejected");
    expect(out.code).toBe("INVALID_INPUT");
  });
});

// ── fail-closed run-token authentication ─────────────────────────────────────

describe("run-token authentication is fail-closed on every tool", () => {
  const validInputs: Record<string, unknown> = {
    project_instantiate: { projectRef: PROJECT_REF, templatePackage: TEMPLATE_PKG, anchorDate: "2026-07-14" },
    project_tick_context: { projectRef: PROJECT_REF, asOf: "2026-07-14" },
    project_dispatch_worker: {
      projectRef: PROJECT_REF, pick: "proj/draft", role: "draft-writer", asOf: "2026-07-14", actionVersion: 0, runInput: {},
    },
  };

  it("rejects when there is NO run context at all", async () => {
    for (const [name, input] of Object.entries(validInputs)) {
      const out = await call(name, input); // no frame
      expect(out.status).toBe("rejected");
      expect(out.code).toBe("RUN_CONTEXT_REQUIRED");
    }
  });

  it("rejects a frame carrying NO OBO scope-ceiling (not a verified agent-run token)", async () => {
    for (const [name, input] of Object.entries(validInputs)) {
      const out = await call(name, input, { runId: RUN, orgId: ORG }); // no oboCeiling
      expect(out.status).toBe("rejected");
      expect(out.code).toBe("RUN_CONTEXT_REQUIRED");
    }
  });

  it("rejects a chat-delegated caller even if a ceiling is present", async () => {
    const out = await call("project_dispatch_worker", validInputs.project_dispatch_worker, {
      runId: RUN,
      orgId: ORG,
      oboCeiling: orgCeiling,
      delegatedActor: { delegation: "chat", userId: "u", orgId: ORG, platformRole: "member" },
    });
    expect(out.status).toBe("rejected");
    expect(out.code).toBe("RUN_CONTEXT_REQUIRED");
    expect(mocks.dispatchProjectWorker).not.toHaveBeenCalled();
  });

  it("rejects a delegated-restricted (delegated-chat perimeter) caller", async () => {
    const out = await call("project_tick_context", validInputs.project_tick_context, {
      runId: RUN,
      orgId: ORG,
      oboCeiling: orgCeiling,
      delegatedRestricted: true,
    });
    expect(out.status).toBe("rejected");
    expect(out.code).toBe("RUN_CONTEXT_REQUIRED");
  });

  it("rejects when the run id does not resolve to a run in the token's org", async () => {
    mocks.readAgentRunById.mockResolvedValueOnce(null); // unknown run
    const out = await call("project_dispatch_worker", validInputs.project_dispatch_worker, validFrame());
    expect(out.status).toBe("rejected");
    expect(out.code).toBe("RUN_CONTEXT_REQUIRED");

    mocks.readAgentRunById.mockResolvedValueOnce({ id: RUN, orgId: "other-org", templateId: "t" }); // cross-org
    const out2 = await call("project_tick_context", validInputs.project_tick_context, validFrame());
    expect(out2.status).toBe("rejected");
    expect(out2.code).toBe("RUN_CONTEXT_REQUIRED");

    // The primitives were never reached.
    expect(mocks.dispatchProjectWorker).not.toHaveBeenCalled();
    expect(mocks.readProjectInstance).not.toHaveBeenCalled();
  });
});

// ── OBO scope-ceiling containment ────────────────────────────────────────────

describe("OBO scope-ceiling containment confines a run to its anchored project", () => {
  it("instantiate: refuses a projectId outside the calling run's ceiling", async () => {
    const out = await call(
      "project_instantiate",
      { projectRef: PROJECT_REF, templatePackage: TEMPLATE_PKG, anchorDate: "2026-07-14", projectId: "proj-Q" },
      validFrame(projectCeiling("proj-P")),
    );
    expect(out.status).toBe("rejected");
    expect(out.code).toBe("CEILING_VIOLATION");
    expect(mocks.instantiateProject).not.toHaveBeenCalled();
  });

  it("dispatch: refuses when the instance's project is outside the ceiling", async () => {
    mocks.readProjectInstance.mockResolvedValue(instance({ projectId: "proj-Q" }));
    const out = await call(
      "project_dispatch_worker",
      { projectRef: PROJECT_REF, pick: "proj/draft", role: "draft-writer", asOf: "2026-07-14", actionVersion: 0, runInput: {} },
      validFrame(projectCeiling("proj-P")),
    );
    expect(out.status).toBe("rejected");
    expect(out.code).toBe("CEILING_VIOLATION");
    expect(mocks.acquireProjectLease).not.toHaveBeenCalled();
    expect(mocks.dispatchProjectWorker).not.toHaveBeenCalled();
  });

  it("dispatch: ALLOWS a project-anchored run onto its OWN project", async () => {
    mocks.readProjectInstance.mockResolvedValue(instance({ projectId: "proj-P" }));
    mocks.resolvePersistedPmWorkStore.mockReturnValue({
      ok: true,
      store: { listWorkItems: vi.fn(async () => []), createWorkItem: vi.fn() },
    });
    mocks.acquireProjectLease.mockResolvedValue({ orgId: ORG, projectRef: PROJECT_REF, holderId: RUN, version: 2 });
    mocks.dispatchProjectWorker.mockResolvedValue({ status: "dispatched", runId: "child-1", attemptId: "a1", idempotencyKey: "k1" });

    const out = await call(
      "project_dispatch_worker",
      { projectRef: PROJECT_REF, pick: "proj/draft", role: "draft-writer", asOf: "2026-07-14", actionVersion: 0, runInput: {} },
      validFrame(projectCeiling("proj-P")),
    );
    expect(out.status).toBe("dispatched");
  });
});

// ── happy paths compose the primitives with host-derived operands ────────────

describe("project_dispatch_worker happy path (host-derived items/lease/parentRunId)", () => {
  it("binds parentRunId, the lease held AS the run, and the live items", async () => {
    const liveItems = [{ naturalKey: "proj/draft", title: "Write the draft", status: "todo", assigneeIds: [], dependsOn: [] }];
    mocks.readProjectInstance.mockResolvedValue(instance());
    mocks.resolvePersistedPmWorkStore.mockReturnValue({
      ok: true,
      store: { listWorkItems: vi.fn(async () => liveItems), createWorkItem: vi.fn() },
    });
    mocks.acquireProjectLease.mockResolvedValue({ orgId: ORG, projectRef: PROJECT_REF, holderId: RUN, version: 7 });
    mocks.dispatchProjectWorker.mockResolvedValue({ status: "dispatched", runId: "child-1", attemptId: "a1", idempotencyKey: "k1" });

    const out = await call(
      "project_dispatch_worker",
      { projectRef: PROJECT_REF, pick: "proj/draft", role: "draft-writer", asOf: "2026-07-14", actionVersion: 0, runInput: { brief: "x" } },
      validFrame(),
    );

    expect(out.status).toBe("dispatched");
    expect(out.runId).toBe("child-1");

    // The lease was acquired AS the calling run.
    expect(mocks.acquireProjectLease).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, projectRef: PROJECT_REF, holderId: RUN }),
    );
    // The primitive received the host-derived trust operands, never the model's.
    const passed = mocks.dispatchProjectWorker.mock.calls[0][0];
    expect(passed.orgId).toBe(ORG);
    expect(passed.parentRunId).toBe(RUN);
    expect(passed.lease).toEqual({ holderId: RUN, version: 7 });
    expect(passed.items).toEqual(liveItems); // this project's items, host-read
    expect(passed.pick).toBe("proj/draft");
    expect(passed.role).toBe("draft-writer");
  });

  it("maps LEASE_NOT_HELD when the lease cannot be acquired", async () => {
    mocks.readProjectInstance.mockResolvedValue(instance());
    mocks.resolvePersistedPmWorkStore.mockReturnValue({
      ok: true,
      store: { listWorkItems: vi.fn(async () => []), createWorkItem: vi.fn() },
    });
    mocks.acquireProjectLease.mockResolvedValue(null); // stolen / held elsewhere

    const out = await call(
      "project_dispatch_worker",
      { projectRef: PROJECT_REF, pick: "proj/draft", role: "draft-writer", asOf: "2026-07-14", actionVersion: 0, runInput: {} },
      validFrame(),
    );
    expect(out.status).toBe("rejected");
    expect(out.code).toBe("LEASE_NOT_HELD");
    expect(mocks.dispatchProjectWorker).not.toHaveBeenCalled();
  });

  it("rejects an un-instantiated project before touching the lease", async () => {
    mocks.readProjectInstance.mockResolvedValue(null);
    const out = await call(
      "project_dispatch_worker",
      { projectRef: PROJECT_REF, pick: "proj/draft", role: "draft-writer", asOf: "2026-07-14", actionVersion: 0, runInput: {} },
      validFrame(),
    );
    expect(out.status).toBe("rejected");
    expect(out.code).toBe("PROJECT_NOT_INSTANTIATED");
    expect(mocks.acquireProjectLease).not.toHaveBeenCalled();
  });
});

describe("the never-throws guard sanitizes an unexpected fault", () => {
  it("maps a thrown store read to a sanitized failed envelope (no raw message)", async () => {
    // Credential-free stub DSN (house test idiom, e.g. "postgres://stub") — the
    // SECRET sentinel is what the sanitization assertion keys on.
    mocks.readProjectInstance.mockRejectedValue(new Error("SECRET dsn=postgres://stub/db"));
    const out = await call(
      "project_dispatch_worker",
      { projectRef: PROJECT_REF, pick: "proj/draft", role: "draft-writer", asOf: "2026-07-14", actionVersion: 0, runInput: {} },
      validFrame(),
    );
    expect(out.status).toBe("failed");
    expect(out.code).toBe("PROJECT_SEAM_ERROR");
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });
});

describe("project_instantiate happy path (host-derived pmAgentPackage + materialization)", () => {
  it("derives the PM seat from the calling run and materializes the template", async () => {
    mocks.instantiateProject.mockResolvedValue({ status: "instantiated", instance: instance() });
    const createWorkItem = vi.fn(async ({ item }) => item);
    mocks.resolvePersistedPmWorkStore.mockReturnValue({ ok: true, store: { listWorkItems: vi.fn(), createWorkItem } });
    mocks.resolveInstalledProjectTemplate.mockResolvedValue({ ok: true, template, manifest: {} });

    const out = await call(
      "project_instantiate",
      { projectRef: PROJECT_REF, templatePackage: TEMPLATE_PKG, anchorDate: "2026-07-14" },
      validFrame(),
    );

    expect(out.status).toBe("instantiated");
    expect(out.providerId).toBe("plane");
    // Two tasks materialized (find-or-create per natural key).
    expect(out.materializedCount).toBe(2);
    expect(createWorkItem).toHaveBeenCalledTimes(2);
    // pmAgentPackage (host-derived) came from the run's own agent template.
    const passed = mocks.instantiateProject.mock.calls[0][0];
    expect(passed.orgId).toBe(ORG);
    expect(passed.pmAgentPackage).toBe(PM_PKG);
  });

  it("passes a primitive rejection CODE through without leaking its raw message", async () => {
    mocks.instantiateProject.mockResolvedValue({
      status: "failed",
      code: "PROJECT_INSTANTIATION_FAILED",
      message: "SECRET dsn=postgres://stub/db", // the primitive embeds raw err.message (credential-free stub DSN, house test idiom)
    });
    const out = await call(
      "project_instantiate",
      { projectRef: PROJECT_REF, templatePackage: TEMPLATE_PKG, anchorDate: "2026-07-14" },
      validFrame(),
    );
    expect(out.status).toBe("failed");
    expect(out.code).toBe("PROJECT_INSTANTIATION_FAILED");
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  it("re-checks the AUTHORITATIVE resolved instance against the ceiling before materializing", async () => {
    // The supplied projectId clears the pre-check, but a sticky
    // already_instantiated resolves an instance bound to a DIFFERENT project
    // outside the ceiling — materialization must never proceed.
    const createWorkItem = vi.fn();
    mocks.instantiateProject.mockResolvedValue({ status: "already_instantiated", instance: instance({ projectId: "proj-Q" }) });
    mocks.resolvePersistedPmWorkStore.mockReturnValue({ ok: true, store: { listWorkItems: vi.fn(), createWorkItem } });
    mocks.resolveInstalledProjectTemplate.mockResolvedValue({ ok: true, template, manifest: {} });

    const out = await call(
      "project_instantiate",
      { projectRef: PROJECT_REF, templatePackage: TEMPLATE_PKG, anchorDate: "2026-07-14", projectId: "proj-P" },
      validFrame(projectCeiling("proj-P")),
    );
    expect(out.status).toBe("rejected");
    expect(out.code).toBe("CEILING_VIOLATION");
    expect(createWorkItem).not.toHaveBeenCalled();
  });
});

describe("project_tick_context happy path (host-derived items + ready set)", () => {
  it("returns the deterministic ready set with the template role binding", async () => {
    const liveItems = [
      { naturalKey: "proj/draft", title: "Write the draft", status: "todo", assigneeIds: [], dependsOn: [], startDate: null },
      { naturalKey: "proj/review", title: "Human review", status: "blocked", assigneeIds: [], dependsOn: [], startDate: null },
    ];
    mocks.readProjectInstance.mockResolvedValue(instance());
    mocks.resolvePersistedPmWorkStore.mockReturnValue({
      ok: true,
      store: { listWorkItems: vi.fn(async () => liveItems), createWorkItem: vi.fn() },
    });
    mocks.resolveInstalledProjectTemplate.mockResolvedValue({ ok: true, template, manifest: {} });

    const out = await call("project_tick_context", { projectRef: PROJECT_REF, asOf: "2026-07-14" }, validFrame());

    expect(out.status).toBe("context");
    expect(out.asOf).toBe("2026-07-14");
    expect(out.items).toHaveLength(2);
    // Only the todo, dependency-free item is ready; it carries the worker role.
    expect(out.readySet).toEqual([
      expect.objectContaining({ pick: "proj/draft", role: "draft-writer", requiresApproval: false }),
    ]);
    expect((out.instance as { pmAgentPackage: string }).pmAgentPackage).toBe(PM_PKG);
  });
});

describe("work items are scoped to the caller's project (shared-provider isolation)", () => {
  const mixedItems = [
    { naturalKey: "proj/draft", title: "MINE", status: "todo", assigneeIds: [], dependsOn: [], startDate: null },
    { naturalKey: "other-proj/secret", title: "SIBLING", status: "todo", assigneeIds: [], dependsOn: [], startDate: null },
  ];

  it("tick_context excludes a sibling project's items from context + ready set", async () => {
    mocks.readProjectInstance.mockResolvedValue(instance());
    mocks.resolvePersistedPmWorkStore.mockReturnValue({
      ok: true,
      store: { listWorkItems: vi.fn(async () => mixedItems), createWorkItem: vi.fn() },
    });
    mocks.resolveInstalledProjectTemplate.mockResolvedValue({ ok: true, template, manifest: {} });

    const out = await call("project_tick_context", { projectRef: PROJECT_REF, asOf: "2026-07-14" }, validFrame());
    expect(out.status).toBe("context");
    expect(out.items).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain("SIBLING");
    expect(JSON.stringify(out)).not.toContain("other-proj/secret");
  });

  it("dispatch passes ONLY this project's items into the readiness evaluation", async () => {
    mocks.readProjectInstance.mockResolvedValue(instance());
    mocks.resolvePersistedPmWorkStore.mockReturnValue({
      ok: true,
      store: { listWorkItems: vi.fn(async () => mixedItems), createWorkItem: vi.fn() },
    });
    mocks.acquireProjectLease.mockResolvedValue({ orgId: ORG, projectRef: PROJECT_REF, holderId: RUN, version: 1 });
    mocks.dispatchProjectWorker.mockResolvedValue({ status: "dispatched", runId: "c", attemptId: "a", idempotencyKey: "k" });

    await call(
      "project_dispatch_worker",
      { projectRef: PROJECT_REF, pick: "proj/draft", role: "draft-writer", asOf: "2026-07-14", actionVersion: 0, runInput: {} },
      validFrame(),
    );
    const passed = mocks.dispatchProjectWorker.mock.calls[0][0];
    expect(passed.items.map((i: { naturalKey: string }) => i.naturalKey)).toEqual(["proj/draft"]);
  });
});
