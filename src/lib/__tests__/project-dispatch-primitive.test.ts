import { describe, it, expect, vi, beforeEach } from "vitest";

// Pure unit tests for the dynamic dispatch primitive (cinatra#1032
// deliverables 2 + 3). The agents store, the dispatch ledger, the enqueue
// chokepoint, the project-instance store, and the installed-payload RESOLVERS
// are mocked; the DETERMINISTIC POLICY layer — the template-task worker
// binding, the allowlist, the shared ready-item validator from
// @cinatra-ai/sdk-extensions, AND the PM-seat consumes predicate — runs REAL,
// so the tests prove the acceptance properties directly: a pick or worker
// failing the deterministic validators NEVER reaches createAgentRun, and a
// caller that is not the instance's PM seat (or targets an un-instantiated /
// template-swapped project) is refused before the ledger is touched. The
// lease-fenced ledger + CAS settle behavior against real Postgres is covered
// by the DB-gated integration test in packages/agents
// (project-dispatch-ledger-lease.integration.test.ts).

const mocks = vi.hoisted(() => ({
  createAgentRun: vi.fn(),
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readAgentTemplateByPackageName: vi.fn(),
  readAgentVersionsByTemplate: vi.fn(async () => [{ id: "v1" }]),
  readProjectInstance: vi.fn(),
  enqueueAgentRun: vi.fn(),
  readEffectiveStatusByPackageNames: vi.fn(
    async () => new Map<string, "active" | "archived">(),
  ),
  beginDispatchAttempt: vi.fn(),
  settleDispatchAttempt: vi.fn(),
  resolveInstalledAgentManifest: vi.fn(),
  resolveInstalledProjectTemplate: vi.fn(),
}));

vi.mock("@cinatra-ai/agents", () => ({
  createAgentRun: mocks.createAgentRun,
  readAgentRunById: mocks.readAgentRunById,
  readAgentTemplateById: mocks.readAgentTemplateById,
  readAgentTemplateByPackageName: mocks.readAgentTemplateByPackageName,
  readAgentVersionsByTemplate: mocks.readAgentVersionsByTemplate,
  // The REAL terminal-status vocabulary (a pure constant) — the terminal-run
  // seat refusal is proven against the store's own set, not a stub.
  TERMINAL_RUN_STATUSES: new Set(["completed", "failed", "stopped"]),
}));
vi.mock("@cinatra-ai/agents/project-instance-store", () => ({
  readProjectInstance: mocks.readProjectInstance,
}));
// The PURE runtime-lifecycle decision is used UNMOCKED (no IO); only the
// canonical-store READ (the IO boundary) is mocked — the workflow-agent-executor
// test's exact split.
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readEffectiveStatusByPackageNames: mocks.readEffectiveStatusByPackageNames,
}));
vi.mock("@cinatra-ai/agents/project-dispatch-ledger-store", () => ({
  beginDispatchAttempt: mocks.beginDispatchAttempt,
  settleDispatchAttempt: mocks.settleDispatchAttempt,
}));
vi.mock("@/lib/agent-run-enqueue", () => ({
  enqueueAgentRun: mocks.enqueueAgentRun,
  enqueueDepsForTemplate: (t: { packageName?: string | null; packageVersion?: string | null } | null | undefined) => ({
    agentPackage: t?.packageName ? { name: t.packageName, version: t.packageVersion ?? null } : undefined,
  }),
}));
// PARTIAL mock: the finalized-store RESOLVERS (filesystem/anchor IO) are
// mocked; `agentManifestDeclaresPmSeat` stays REAL so the seat predicate is
// proven against real manifests, not a stubbed boolean.
vi.mock("@/lib/project-template-resolve", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-template-resolve")>();
  return {
    ...actual,
    resolveInstalledAgentManifest: mocks.resolveInstalledAgentManifest,
    resolveInstalledProjectTemplate: mocks.resolveInstalledProjectTemplate,
  };
});

import { OboCeilingCompositionError } from "@cinatra-ai/mcp-server/obo-ceiling";
import {
  PROJECT_TEMPLATE_FORMAT_VERSION,
  type ProjectTemplate,
  type ReadyItemView,
} from "@cinatra-ai/sdk-extensions/project-template-contract";
import { dispatchProjectWorker } from "@/lib/project-dispatch";

const WORKER_PKG = "@cinatra-ai/draft-writer-agent";
const TEMPLATE_PKG = "@cinatra-ai/release-announcement-agent";
const PM_PKG = "@cinatra-ai/project-manager-agent";

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
    {
      id: "review",
      title: "Human review",
      dependsOn: ["draft"],
      worker: null,
      approval: { id: "sign-off" },
    },
  ],
};

/** The template package's manifest with the worker declared as a REAL
 *  cinatra.dependencies edge — the dispatch-side exact-match re-assertion
 *  parses this with the real parser. */
const templatePkgManifest = (edges: unknown[] = [
  {
    packageName: WORKER_PKG,
    kind: "agent",
    edgeType: "runtime",
    versionConstraint: { kind: "exact", version: "1.0.0" },
    requirement: "required",
  },
]) => ({ name: TEMPLATE_PKG, cinatra: { dependencies: edges } });

const items: ReadyItemView[] = [
  { naturalKey: "proj-1/draft", status: "todo", assigneeIds: [], dependsOn: [] },
  { naturalKey: "proj-1/review", status: "backlog", assigneeIds: [], dependsOn: ["proj-1/draft"] },
];

const instance = (over: Partial<Record<string, unknown>> = {}) => ({
  orgId: "org-A",
  projectRef: "proj-1",
  projectId: null,
  templatePackage: TEMPLATE_PKG,
  templateId: "launch-plan",
  pmAgentPackage: PM_PKG,
  providerId: "plane",
  providerMode: "auto",
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

/** A REAL pm-seat manifest — judged by the real predicate. */
const pmSeatManifest = (consumes: unknown = [
  { primitive: "pm-work-store", requirement: "required" },
]) => ({
  manifest: { name: PM_PKG, cinatra: { consumes } },
  storeDir: "/store/pm",
  digest: "digest-pm",
});

const parentRun = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "run_parent",
  templateId: "tmpl-pm",
  orgId: "org-A",
  projectId: null,
  oboCeiling: null,
  status: "running",
  ...over,
});

const attempt = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "pda_1",
  orgId: "org-A",
  projectRef: "proj-1",
  itemNaturalKey: "proj-1/draft",
  actionVersion: 0,
  workerRole: "draft-writer",
  workerPackage: WORKER_PKG,
  workerVersionConstraint: "exact:1.0.0",
  idempotencyKey: "project:org-A:proj-1/draft:0",
  runId: null,
  status: "pending",
  error: null,
  version: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const baseInput = () => ({
  orgId: "org-A",
  projectRef: "proj-1",
  items,
  pick: "proj-1/draft",
  asOf: "2026-07-10",
  actionVersion: 0,
  role: "draft-writer",
  runInput: { topic: "x" },
  runBy: "u1",
  lease: { holderId: "run_parent", version: 3 },
  parentRunId: "run_parent",
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readAgentVersionsByTemplate.mockResolvedValue([{ id: "v1" }]);
  mocks.readEffectiveStatusByPackageNames.mockResolvedValue(new Map());
  mocks.readProjectInstance.mockResolvedValue(instance());
  // The parent (PM tick) run is read server-side by id; other ids (an
  // attempt's dispatched run) default to null unless a test overrides.
  mocks.readAgentRunById.mockImplementation(async (id: string) =>
    id === "run_parent" ? parentRun() : null,
  );
  mocks.readAgentTemplateById.mockResolvedValue({
    id: "tmpl-pm",
    orgId: "org-A",
    packageName: PM_PKG,
  });
  mocks.resolveInstalledAgentManifest.mockResolvedValue(pmSeatManifest());
  mocks.resolveInstalledProjectTemplate.mockResolvedValue({
    ok: true,
    template,
    digest: "digest-t",
    manifest: templatePkgManifest(),
  });
  mocks.readAgentTemplateByPackageName.mockResolvedValue({
    id: "tmpl-1",
    orgId: null,
    packageName: WORKER_PKG,
    packageVersion: "1.0.0",
  });
  mocks.beginDispatchAttempt.mockResolvedValue({ kind: "inserted", attempt: attempt() });
  mocks.settleDispatchAttempt.mockImplementation(async (input: { status: string; runId?: string | null }) => ({
    kind: "settled",
    attempt: attempt({ status: input.status, runId: input.runId ?? null, version: 1 }),
  }));
  mocks.createAgentRun.mockImplementation(async (input: { id: string }) => ({
    id: input.id,
    status: "queued",
  }));
});

describe("instance + PM-seat kind gate (deliverable 3 — never reach the ledger)", () => {
  it("rejects an un-instantiated project (PROJECT_NOT_INSTANTIATED)", async () => {
    mocks.readProjectInstance.mockResolvedValue(null);
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "PROJECT_NOT_INSTANTIATED" });
    expect(mocks.beginDispatchAttempt).not.toHaveBeenCalled();
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
  });

  it("rejects a missing parentRunId up front (INVALID_INPUT)", async () => {
    const out = await dispatchProjectWorker({ ...baseInput(), parentRunId: "  " });
    expect(out).toMatchObject({ status: "rejected", code: "INVALID_INPUT" });
    expect(mocks.readProjectInstance).not.toHaveBeenCalled();
  });

  it("NOT_PM_SEAT when the parent run does not exist", async () => {
    mocks.readAgentRunById.mockResolvedValue(null);
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "NOT_PM_SEAT" });
    expect(mocks.beginDispatchAttempt).not.toHaveBeenCalled();
  });

  it("NOT_PM_SEAT on a cross-org parent run (org is read server-side, never from input)", async () => {
    mocks.readAgentRunById.mockImplementation(async (id: string) =>
      id === "run_parent" ? parentRun({ orgId: "org-B" }) : null,
    );
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "NOT_PM_SEAT" });
  });

  it("NOT_PM_SEAT when the nominated parent run is TERMINAL (an old run cannot dispatch)", async () => {
    for (const status of ["completed", "failed", "stopped"]) {
      mocks.readAgentRunById.mockImplementation(async (id: string) =>
        id === "run_parent" ? parentRun({ status }) : null,
      );
      const out = await dispatchProjectWorker(baseInput());
      expect(out).toMatchObject({ status: "rejected", code: "NOT_PM_SEAT" });
    }
    expect(mocks.beginDispatchAttempt).not.toHaveBeenCalled();
  });

  it("NOT_PM_SEAT when the lease is held under a DIFFERENT identity than the parent run", async () => {
    const out = await dispatchProjectWorker({
      ...baseInput(),
      lease: { holderId: "some-other-holder", version: 3 },
    });
    expect(out).toMatchObject({ status: "rejected", code: "NOT_PM_SEAT" });
    expect(mocks.beginDispatchAttempt).not.toHaveBeenCalled();
  });

  it("NOT_PM_SEAT when the parent run's agent is not the instance's persisted seat", async () => {
    mocks.readAgentTemplateById.mockResolvedValue({
      id: "tmpl-other",
      orgId: "org-A",
      packageName: "@cinatra-ai/some-other-agent",
    });
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "NOT_PM_SEAT" });
    expect(mocks.beginDispatchAttempt).not.toHaveBeenCalled();
  });

  it("NOT_PM_SEAT when the parent run is outside the instance's cinatra project", async () => {
    mocks.readProjectInstance.mockResolvedValue(instance({ projectId: "cin-proj-7" }));
    // Parent run carries a different (null) projectId.
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "NOT_PM_SEAT" });
  });

  it("NOT_PM_SEAT (fail-closed) when the seat package no longer resolves to an installed manifest", async () => {
    mocks.resolveInstalledAgentManifest.mockResolvedValue(null);
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "NOT_PM_SEAT" });
  });

  it("NOT_PM_SEAT when the seat's REINSTALLED manifest dropped the required pm-work-store binding (real predicate)", async () => {
    // requirement "optional" does NOT confer the seat.
    mocks.resolveInstalledAgentManifest.mockResolvedValue(
      pmSeatManifest([{ primitive: "pm-work-store", requirement: "optional" }]),
    );
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "NOT_PM_SEAT" });

    // No consumes at all (an absent key means "not declared").
    mocks.resolveInstalledAgentManifest.mockResolvedValue({
      manifest: { name: PM_PKG, cinatra: {} },
      storeDir: "/store/pm",
      digest: "digest-pm",
    });
    const out2 = await dispatchProjectWorker(baseInput());
    expect(out2).toMatchObject({ status: "rejected", code: "NOT_PM_SEAT" });
    expect(mocks.beginDispatchAttempt).not.toHaveBeenCalled();
  });

  it("TEMPLATE_UNRESOLVED when the instance's pinned template package stops resolving", async () => {
    mocks.resolveInstalledProjectTemplate.mockResolvedValue({
      ok: false,
      reason: "not_installed",
    });
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "failed", code: "TEMPLATE_UNRESOLVED" });
    expect(mocks.beginDispatchAttempt).not.toHaveBeenCalled();
  });

  it("PROJECT_TEMPLATE_MISMATCH refuses a template swap under the same project ref", async () => {
    mocks.resolveInstalledProjectTemplate.mockResolvedValue({
      ok: true,
      template: { ...template, id: "different-template" },
      digest: "digest-x",
      manifest: templatePkgManifest(),
    });
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "PROJECT_TEMPLATE_MISMATCH" });
    expect(mocks.beginDispatchAttempt).not.toHaveBeenCalled();
  });

  it("same template id, CHANGED worker (reinstalled package): policy runs against the CURRENT installed template — the old role is refused, and the ledger's immutable identity refuses the old attempt", async () => {
    // The reinstalled template rebinds the draft task to a different worker,
    // and the reinstalled manifest DECLARES that worker (a gate-valid update).
    const swappedTemplate = {
      ...template,
      tasks: [
        {
          id: "draft",
          title: "Write the draft",
          worker: {
            role: "ghost-writer",
            packageName: "@cinatra-ai/ghost-writer-agent",
            versionConstraint: { kind: "exact", version: "1.0.0" },
          },
        },
        template.tasks[1],
      ],
    };
    mocks.resolveInstalledProjectTemplate.mockResolvedValue({
      ok: true,
      template: swappedTemplate,
      digest: "digest-CHANGED",
      manifest: templatePkgManifest([
        {
          packageName: "@cinatra-ai/ghost-writer-agent",
          kind: "agent",
          edgeType: "runtime",
          versionConstraint: { kind: "exact", version: "1.0.0" },
          requirement: "required",
        },
      ]),
    });
    // A pick proposing the OLD role no longer matches the current binding.
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "WORKER_NOT_ALLOWLISTED" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();

    // And a recovery of a PRE-CHANGE ledgered attempt under the NEW binding is
    // refused by the immutable attempt identity (binding drift, same action
    // version) — covered again in the crash-window suite below.
    mocks.beginDispatchAttempt.mockResolvedValue({
      kind: "existing",
      attempt: attempt(), // old binding: draft-writer @ WORKER_PKG
    });
    const recovered = await dispatchProjectWorker({ ...baseInput(), role: "ghost-writer" });
    expect(recovered).toMatchObject({ status: "rejected", code: "DISPATCH_ATTEMPT_CONFLICT" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
  });

  it("TEMPLATE_WORKER_REFS_INVALID: a finalized payload whose template names an UNDECLARED worker never allowlists it (the finalize-before-native-gate race window)", async () => {
    // The shared install pipeline finalizes the store payload BEFORE the
    // native agent handler's template gate runs. A dispatch racing that
    // window must re-assert the exact-match rule itself: the swapped-in
    // worker is NOT among the manifest's dependency edges, so even a pick
    // proposing the CURRENT (swapped) binding is refused before the ledger.
    mocks.resolveInstalledProjectTemplate.mockResolvedValue({
      ok: true,
      template: {
        ...template,
        tasks: [
          {
            id: "draft",
            title: "Write the draft",
            worker: {
              role: "draft-writer",
              packageName: "@cinatra-ai/smuggled-agent",
              versionConstraint: { kind: "exact", version: "1.0.0" },
            },
          },
          template.tasks[1],
        ],
      },
      digest: "digest-RACE",
      manifest: templatePkgManifest(), // edges still declare only WORKER_PKG
    });
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "TEMPLATE_WORKER_REFS_INVALID" });
    expect(mocks.beginDispatchAttempt).not.toHaveBeenCalled();
    expect(mocks.createAgentRun).not.toHaveBeenCalled();

    // Unreadable manifest edges fail CLOSED the same way.
    mocks.resolveInstalledProjectTemplate.mockResolvedValue({
      ok: true,
      template,
      digest: "digest-t",
      manifest: { name: TEMPLATE_PKG, cinatra: { dependencies: "not-an-array" } },
    });
    const out2 = await dispatchProjectWorker(baseInput());
    expect(out2).toMatchObject({ status: "rejected", code: "TEMPLATE_WORKER_REFS_INVALID" });
  });
});

describe("deterministic policy rejections (never reach createAgentRun)", () => {
  it("rejects a role that is not the template task's worker binding", async () => {
    const out = await dispatchProjectWorker({ ...baseInput(), role: "rogue-role" });
    expect(out).toMatchObject({ status: "rejected", code: "WORKER_NOT_ALLOWLISTED" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
    expect(mocks.beginDispatchAttempt).not.toHaveBeenCalled();
  });

  it("rejects dispatching a human/manual task (no worker binding)", async () => {
    const readyItems: ReadyItemView[] = [
      { naturalKey: "proj-1/draft", status: "done" },
      { naturalKey: "proj-1/review", status: "todo", assigneeIds: [], dependsOn: ["proj-1/draft"] },
    ];
    const out = await dispatchProjectWorker({
      ...baseInput(),
      items: readyItems,
      pick: "proj-1/review",
      role: "draft-writer",
    });
    expect(out).toMatchObject({ status: "rejected", code: "WORKER_NOT_ALLOWLISTED" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
  });

  it("rejects a pick outside the project scope / unknown to the template / absent from the items", async () => {
    for (const pick of ["other-proj/draft", "proj-1/nonexistent-task"]) {
      const out = await dispatchProjectWorker({ ...baseInput(), pick, role: "draft-writer" });
      expect(out).toMatchObject({ status: "rejected", code: "PICK_UNKNOWN" });
    }
    const out = await dispatchProjectWorker({ ...baseInput(), items: [items[1]] });
    expect(out).toMatchObject({ status: "rejected", code: "PICK_UNKNOWN" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
    expect(mocks.beginDispatchAttempt).not.toHaveBeenCalled();
  });

  it("rejects a not-ready pick with the validator's reason (deps_unmet / claimed)", async () => {
    const claimed = await dispatchProjectWorker({
      ...baseInput(),
      items: [{ ...items[0], assigneeIds: ["someone"] }, items[1]],
    });
    expect(claimed).toMatchObject({
      status: "rejected",
      code: "ITEM_NOT_READY",
      notReadyReason: "claimed",
    });

    const withDep: ReadyItemView[] = [
      { naturalKey: "proj-1/draft", status: "todo", assigneeIds: [], dependsOn: ["proj-1/other"] },
      { naturalKey: "proj-1/other", status: "in_progress" },
    ];
    const deps = await dispatchProjectWorker({ ...baseInput(), items: withDep });
    expect(deps).toMatchObject({
      status: "rejected",
      code: "ITEM_NOT_READY",
      notReadyReason: "deps_unmet",
    });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
    expect(mocks.beginDispatchAttempt).not.toHaveBeenCalled();
  });

  it("rejects invalid actionVersion / asOf shapes", async () => {
    expect(await dispatchProjectWorker({ ...baseInput(), actionVersion: -1 })).toMatchObject({
      status: "rejected",
      code: "INVALID_INPUT",
    });
    expect(await dispatchProjectWorker({ ...baseInput(), actionVersion: 1.5 })).toMatchObject({
      status: "rejected",
      code: "INVALID_INPUT",
    });
    // Above the PostgreSQL `integer` bound: rejected up front, not in SQL.
    expect(
      await dispatchProjectWorker({ ...baseInput(), actionVersion: 2_147_483_648 }),
    ).toMatchObject({ status: "rejected", code: "INVALID_INPUT" });
    expect(await dispatchProjectWorker({ ...baseInput(), asOf: "not-a-date" })).toMatchObject({
      status: "rejected",
      code: "INVALID_INPUT",
    });
    expect(mocks.beginDispatchAttempt).not.toHaveBeenCalled();
  });
});

describe("lease fencing", () => {
  it("rejects when the lease-fenced ledger claim reports the lease is not held", async () => {
    mocks.beginDispatchAttempt.mockResolvedValue({ kind: "lease_not_held" });
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "LEASE_NOT_HELD" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
  });

  it("passes the caller's lease (holder + fencing version) to the ledger claim", async () => {
    await dispatchProjectWorker(baseInput());
    expect(mocks.beginDispatchAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ lease: { holderId: "run_parent", version: 3 } }),
    );
  });
});

describe("happy path", () => {
  it("dispatches through the verbatim gate chain with the ledgered idempotency key", async () => {
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({
      status: "dispatched",
      attemptId: "pda_1",
      idempotencyKey: "project:org-A:proj-1/draft:0",
    });
    expect(mocks.createAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: "tmpl-1",
        versionId: "v1",
        orgId: "org-A",
        idempotencyKey: "project:org-A:proj-1/draft:0",
        parentRunId: "run_parent",
        parentOboCeiling: null,
      }),
      // cinatra#1940 P3: the guarded creation perimeter — the tick mints a
      // system dispatch authority scoped to the project's org.
      expect.objectContaining({ orgId: "org-A" }),
    );
    expect(mocks.enqueueAgentRun).toHaveBeenCalledWith(
      { runId: expect.stringMatching(/^run_/) },
      expect.objectContaining({ softPreflight: true }),
    );
    expect(mocks.settleDispatchAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pda_1", expectedVersion: 0, status: "dispatched" }),
    );
  });

  it("threads the parent run's PERSISTED OBO ceiling chain as the compose operand (server-read, never input)", async () => {
    const chain = [{ anchor: "org-A" }] as never;
    mocks.readAgentRunById.mockImplementation(async (id: string) =>
      id === "run_parent" ? parentRun({ oboCeiling: chain }) : null,
    );
    await dispatchProjectWorker(baseInput());
    expect(mocks.createAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ parentRunId: "run_parent", parentOboCeiling: chain }),
      expect.objectContaining({ orgId: "org-A" }), // #1940 P3 dispatch authority
    );
  });

  it("the child run inherits the INSTANCE's cinatra project refinement", async () => {
    mocks.readProjectInstance.mockResolvedValue(instance({ projectId: "cin-proj-7" }));
    mocks.readAgentRunById.mockImplementation(async (id: string) =>
      id === "run_parent" ? parentRun({ projectId: "cin-proj-7" }) : null,
    );
    await dispatchProjectWorker(baseInput());
    expect(mocks.createAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "cin-proj-7" }),
      expect.objectContaining({ orgId: "org-A" }), // #1940 P3 dispatch authority
    );
  });
});

describe("host gate chain failures (attempt settled 'failed')", () => {
  it("AGENT_UNRESOLVED when the worker package resolves to no template", async () => {
    mocks.readAgentTemplateByPackageName.mockResolvedValue(null);
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "failed", code: "AGENT_UNRESOLVED" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
    expect(mocks.settleDispatchAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("AGENT_CROSS_ORG fail-closed on a foreign-org template", async () => {
    mocks.readAgentTemplateByPackageName.mockResolvedValue({
      id: "tmpl-1",
      orgId: "org-B",
      packageName: WORKER_PKG,
    });
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "failed", code: "AGENT_CROSS_ORG" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
  });

  it("AGENT_NOT_INSTALLED fail-closed when the canonical store reports the agent archived", async () => {
    mocks.readEffectiveStatusByPackageNames.mockResolvedValue(
      new Map([[WORKER_PKG, "archived" as const]]),
    );
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "failed", code: "AGENT_NOT_INSTALLED" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
  });

  it("stays runnable (fail-open) on a canonical-store outage", async () => {
    mocks.readEffectiveStatusByPackageNames.mockRejectedValue(new Error("status store down"));
    const out = await dispatchProjectWorker(baseInput());
    expect(out.status).toBe("dispatched");
  });

  it("OBO_CEILING_DISJOINT fails closed when the child ceiling composition throws", async () => {
    mocks.createAgentRun.mockRejectedValue(
      new OboCeilingCompositionError({
        reason: "cross_org",
        tier: "organization",
        ids: ["org-A", "org-B"],
      }),
    );
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "failed", code: "OBO_CEILING_DISJOINT" });
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("never throws — an unexpected error resolves to PROJECT_DISPATCH_FAILED", async () => {
    mocks.createAgentRun.mockRejectedValue(new Error("connection reset"));
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "failed", code: "PROJECT_DISPATCH_FAILED" });
  });
});

describe("crash-window recovery (Acceptance 2: no duplicate, no lost item)", () => {
  it("recovers a crashed tick: existing 'pending' attempt re-dispatches with the SAME key and converges on the SAME run", async () => {
    // Tick 1 crashed after createAgentRun, before settle. Tick 2's begin
    // returns the existing pending row; the idempotent createAgentRun hit
    // returns the ALREADY-CREATED run (different id from this pass's fresh
    // run id, still queued) → enqueue repaired, ledger settled to that run.
    mocks.beginDispatchAttempt.mockResolvedValue({ kind: "existing", attempt: attempt() });
    mocks.createAgentRun.mockResolvedValue({ id: "run_original", status: "queued" });
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "dispatched", runId: "run_original" });
    expect(mocks.createAgentRun).toHaveBeenCalledTimes(1);
    expect(mocks.createAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "project:org-A:proj-1/draft:0" }),
      expect.objectContaining({ orgId: "org-A" }), // #1940 P3 dispatch authority
    );
    expect(mocks.enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(mocks.settleDispatchAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ status: "dispatched", runId: "run_original" }),
    );
  });

  it("short-circuits an already-dispatched attempt, repairing the enqueue of a still-queued run", async () => {
    mocks.beginDispatchAttempt.mockResolvedValue({
      kind: "existing",
      attempt: attempt({ status: "dispatched", runId: "run_done", version: 1 }),
    });
    mocks.readAgentRunById.mockImplementation(async (id: string) => {
      if (id === "run_parent") return parentRun();
      if (id === "run_done") return { id: "run_done", status: "queued" };
      return null;
    });
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toEqual({ status: "already_dispatched", runId: "run_done", attemptId: "pda_1" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
    expect(mocks.enqueueAgentRun).toHaveBeenCalledWith(
      { runId: "run_done" },
      expect.objectContaining({ softPreflight: true }),
    );
  });

  it("does NOT re-enqueue an already-running dispatched run", async () => {
    mocks.beginDispatchAttempt.mockResolvedValue({
      kind: "existing",
      attempt: attempt({ status: "dispatched", runId: "run_done", version: 1 }),
    });
    mocks.readAgentRunById.mockImplementation(async (id: string) => {
      if (id === "run_parent") return parentRun();
      if (id === "run_done") return { id: "run_done", status: "running" };
      return null;
    });
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "already_dispatched", runId: "run_done" });
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("DISPATCH_RUN_MISSING when a dispatched attempt's run no longer exists — never re-dispatches", async () => {
    mocks.beginDispatchAttempt.mockResolvedValue({
      kind: "existing",
      attempt: attempt({ status: "dispatched", runId: "run_gone", version: 1 }),
    });
    // run_parent still resolves; run_gone does not (the default impl).
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "failed", code: "DISPATCH_RUN_MISSING" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
  });

  it("DISPATCH_ATTEMPT_CONFLICT on immutable-binding drift — a template change needs a new actionVersion", async () => {
    mocks.beginDispatchAttempt.mockResolvedValue({
      kind: "existing",
      attempt: attempt({ workerPackage: "@cinatra-ai/other-agent" }),
    });
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "DISPATCH_ATTEMPT_CONFLICT" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
  });

  it("DISPATCH_ATTEMPT_CONFLICT when only the VERSION CONSTRAINT drifted (same role + package)", async () => {
    mocks.beginDispatchAttempt.mockResolvedValue({
      kind: "existing",
      attempt: attempt({ workerVersionConstraint: "exact:2.0.0" }),
    });
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "DISPATCH_ATTEMPT_CONFLICT" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("gates the enqueue-REPAIR of an already-dispatched run: an archived agent is refused (no revival)", async () => {
    mocks.beginDispatchAttempt.mockResolvedValue({
      kind: "existing",
      attempt: attempt({ status: "dispatched", runId: "run_done", version: 1 }),
    });
    mocks.readAgentRunById.mockImplementation(async (id: string) => {
      if (id === "run_parent") return parentRun();
      if (id === "run_done") return { id: "run_done", status: "queued" };
      return null;
    });
    mocks.readEffectiveStatusByPackageNames.mockResolvedValue(
      new Map([[WORKER_PKG, "archived" as const]]),
    );
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "failed", code: "AGENT_NOT_INSTALLED" });
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
    // The attempt is already settled 'dispatched' — the gate failure must NOT re-settle it.
    expect(mocks.settleDispatchAttempt).not.toHaveBeenCalled();
  });

  it("surfaces (never overwrites) a concurrent different settle as DISPATCH_ATTEMPT_CONFLICT", async () => {
    mocks.settleDispatchAttempt.mockResolvedValue({
      kind: "conflict",
      attempt: attempt({ status: "failed", version: 2 }),
    });
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "failed", code: "DISPATCH_ATTEMPT_CONFLICT" });
  });
});
