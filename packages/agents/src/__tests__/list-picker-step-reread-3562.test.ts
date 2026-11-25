/**
 * cinatra#3562 — THE LIST STEP'S TRY AGAIN READS THE LISTS ON THE HOST.
 *
 * `readListStepContent(runId, reviewTaskId)` is what a list step's Try again
 * calls. It sends nothing to the run. What is pinned here, in the order the
 * checks run:
 *   1. the person's read access to the run comes first: a refusal is thrown
 *      before the gate, the run's own rights or the CRM are read;
 *   2. the run must wait at a list step now (status `pending_approval`, its
 *      newest durable gate names a `:list-picker` renderer, and it is the
 *      named review task's gate); otherwise the fixed refusal
 *      `list_step_not_waiting`, with no CRM call;
 *   3. the run itself must be allowed the CRM list read: the boundary decision
 *      of the flow's own list-read tool, asked with the run's stored ceiling.
 *      The REAL boundary decides here (only its audit write is a stand-in): a
 *      ceiling narrower than the organization is refused, and the step gets
 *      the failed shape with no CRM call;
 *   4. the read itself: a failure or a missing capability is the failed shape
 *      with no error text; an answer keeps only non-blank ids and names, a
 *      repeated id once.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";

const { requireAuthSessionMock, requireActorContextMock, resolveOrgRoleForUserMock } = vi.hoisted(
  () => ({
    requireAuthSessionMock: vi.fn(async () => ({
      user: { id: "member-1", email: "member@example.com", role: "user" },
      session: { activeOrganizationId: "org-1" },
    })),
    requireActorContextMock: vi.fn(async () => ({
      principalId: "member-1",
      organizationId: "org-1",
      orgRole: "member" as const,
      platformRole: "member" as const,
    })),
    resolveOrgRoleForUserMock: vi.fn(async () => "member" as const),
  }),
);
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: requireAuthSessionMock,
  requireActorContext: requireActorContextMock,
  resolveOrgRoleForUser: resolveOrgRoleForUserMock,
}));

const { FakeAuthzError } = vi.hoisted(() => ({
  FakeAuthzError: class FakeAuthzError extends Error {
    statusCode: number;
    reason: string;
    constructor(init: { statusCode: number; reason: string; message: string }) {
      super(init.message);
      this.statusCode = init.statusCode;
      this.reason = init.reason;
    }
  },
}));

const { enforceRunAccessMock, readAgentRunByIdMock, readLatestGateMock, readTemplateMock } = vi.hoisted(() => ({
  enforceRunAccessMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
  readAgentRunByIdMock: vi.fn<(id: unknown, actor?: unknown, roles?: unknown) => Promise<unknown>>(),
  readLatestGateMock: vi.fn<(runId: unknown) => Promise<unknown>>(),
  readTemplateMock: vi.fn<(templateId: unknown) => Promise<unknown>>(),
}));
vi.mock("../auth-policy", () => ({ enforceRunAccess: enforceRunAccessMock }));
vi.mock("../store", () => ({
  readAgentRunById: readAgentRunByIdMock,
  readLatestDurableHitlGateArtifact: readLatestGateMock,
  readAgentTemplateById: readTemplateMock,
}));

// The boundary is real; only its audit write is a stand-in.
const { logAuditEventMock } = vi.hoisted(() => ({
  logAuditEventMock: vi.fn<(event: unknown) => Promise<undefined>>(async () => undefined),
}));
vi.mock("@/lib/authz/audit", () => ({ logAuditEvent: logAuditEventMock }));

vi.mock("@/lib/crm-integration-providers", () => ({ resolveCrmListReader: vi.fn() }));

// THE LIVE RUN ACTOR RESOLVER IS REAL (`resolveAgentRunMcpActor`, the one a
// live run step's tool call takes); only its database is a stand-in: the user
// rows and the membership rows it reads, keyed by the table it selects from.
const { authRows } = vi.hoisted(() => ({
  authRows: {
    users: [] as Array<{ id: string; role: string | null }>,
    members: [] as Array<{ id: string; userId: string; organizationId: string }>,
  },
}));
vi.mock("@/lib/better-auth-db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/better-auth-db")>();
  const fakeDb = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () =>
            table === real.betterAuthUsers
              ? authRows.users.filter((u) => u.id === "member-1")
              : authRows.members.filter((m) => m.userId === "member-1" && m.organizationId === "org-1"),
        }),
      }),
    }),
  };
  return { ...real, betterAuthDb: fakeDb };
});
vi.mock("@/lib/authz/build-actor-context-from-run", () => ({ buildActorContextFromRun: vi.fn() }));

// The publish hold and the latest-task key: the two readers the answer road
// and the publish hold use to tell the pause the run waits at.
const { assertNoOpenPublishDecisionMock, resolveLatestTaskMock } = vi.hoisted(() => ({
  assertNoOpenPublishDecisionMock: vi.fn<(runId: string) => Promise<boolean>>(),
  resolveLatestTaskMock: vi.fn<(runId: string) => Promise<string | null>>(),
}));
vi.mock("../publish-decision-actions", () => ({
  assertNoOpenPublishDecision: assertNoOpenPublishDecisionMock,
}));
vi.mock("@cinatra-ai/a2a", () => ({ resolveLatestWayflowGateTaskId: resolveLatestTaskMock }));

import { readListStepContent } from "../list-picker-actions";
import { resolveCrmListReader } from "@/lib/crm-integration-providers";

const RUN_ID = "run-3562";
const GATE_TASK = "flow-task-1";
const TASK_ID = `wayflow-${GATE_TASK}`;
const LIST_RENDERER = "@cinatra-test/pack-agent:list-picker";
const ORG_ONLY_CEILING = [{ tier: "organization" as const, id: "org-1" }];
const TEAM_CEILING = [
  { tier: "organization" as const, id: "org-1" },
  { tier: "team" as const, id: "team-9" },
];

const searchMock = vi.fn();

// The run's template anchor: the ceiling is derived from it as the live tool
// mint derives it (an organization-owned template here unless a case says so).
const TEMPLATE_ID = "tmpl-3562";
const ORG_TEMPLATE = { id: TEMPLATE_ID, ownerLevel: "organization", ownerId: "org-1" };
const TEAM_TEMPLATE = { id: TEMPLATE_ID, ownerLevel: "team", ownerId: "team-9" };

function waitingRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    status: "pending_approval",
    runBy: "member-1",
    orgId: "org-1",
    templateId: TEMPLATE_ID,
    projectId: null,
    a2aTaskId: GATE_TASK,
    oboCeiling: ORG_ONLY_CEILING,
    ...overrides,
  };
}

function listGate(overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    reviewTaskId: TASK_ID,
    xRenderer: LIST_RENDERER,
    inputSchema: {},
    values: {},
    ...overrides,
  };
}

let warnSpy: MockInstance<typeof console.warn>;
let infoSpy: MockInstance<typeof console.info>;

function everythingLogged(): string {
  return [...warnSpy.mock.calls, ...infoSpy.mock.calls]
    .map((args) => args.map((a) => String(a)).join(" "))
    .join("\n");
}

async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  try {
    const resolved = await pending;
    throw new Error(`resolved instead of rejecting: ${JSON.stringify(resolved)}`);
  } catch (rejection) {
    return rejection;
  }
}

beforeEach(() => {
  vi.mocked(resolveCrmListReader).mockReset();
  vi.mocked(resolveCrmListReader).mockImplementation(() => ({ searchLists: searchMock }));
  searchMock.mockReset();
  searchMock.mockResolvedValue([
    { id: "l-1", name: "Customers", objectType: "contact" },
    { id: "l-2", name: "Prospects", objectType: "contact" },
  ]);
  readAgentRunByIdMock.mockReset();
  readAgentRunByIdMock.mockResolvedValue(waitingRun());
  readLatestGateMock.mockReset();
  readLatestGateMock.mockResolvedValue(listGate());
  readTemplateMock.mockReset();
  readTemplateMock.mockResolvedValue(ORG_TEMPLATE);
  enforceRunAccessMock.mockReset();
  enforceRunAccessMock.mockRejectedValue(
    new FakeAuthzError({ statusCode: 404, reason: "hidden", message: "Not found." }),
  );
  logAuditEventMock.mockClear();
  assertNoOpenPublishDecisionMock.mockReset();
  assertNoOpenPublishDecisionMock.mockResolvedValue(false);
  resolveLatestTaskMock.mockReset();
  resolveLatestTaskMock.mockResolvedValue(GATE_TASK);
  resolveOrgRoleForUserMock.mockClear();
  resolveOrgRoleForUserMock.mockResolvedValue("member");
  authRows.users = [{ id: "member-1", role: "user" }];
  authRows.members = [{ id: "m-1", userId: "member-1", organizationId: "org-1" }];
  requireActorContextMock.mockClear();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  infoSpy.mockRestore();
});

describe("readListStepContent — the person's access to the run comes first", () => {
  // red-first-expect: readListStepContent is not a function
  it("a refusal of the run read is thrown before the gate, the run's rights or the CRM are read", async () => {
    readAgentRunByIdMock.mockRejectedValueOnce(
      new FakeAuthzError({ statusCode: 403, reason: "forbidden", message: "Access denied." }),
    );
    const rejection = await rejectionOf(readListStepContent(RUN_ID, TASK_ID));
    expect((rejection as { statusCode?: number }).statusCode).toBe(403);
    expect(readAgentRunByIdMock).toHaveBeenCalledWith(RUN_ID, expect.anything(), expect.anything());
    expect(readLatestGateMock).not.toHaveBeenCalled();
    expect(logAuditEventMock).not.toHaveBeenCalled();
    expect(resolveCrmListReader).not.toHaveBeenCalled();
    expect(searchMock).not.toHaveBeenCalled();
  });

  // red-first-expect: readListStepContent is not a function
  it("a blank run id takes the hidden-run refusal and reads nothing", async () => {
    const rejection = await rejectionOf(readListStepContent("  ", TASK_ID));
    expect((rejection as { statusCode?: number }).statusCode).toBe(404);
    expect(enforceRunAccessMock).toHaveBeenCalledWith(null, expect.anything(), "read", expect.anything());
    expect(readAgentRunByIdMock).not.toHaveBeenCalled();
    expect(searchMock).not.toHaveBeenCalled();
  });
});

describe("readListStepContent — only for the list step the run waits at", () => {
  const notWaiting: Array<[string, () => void]> = [
    ["a run that is not waiting", () => readAgentRunByIdMock.mockResolvedValueOnce(waitingRun({ status: "running" }))],
    ["a run with no durable gate", () => readLatestGateMock.mockResolvedValueOnce(null)],
    ["a gate read that fails", () => readLatestGateMock.mockRejectedValueOnce(new Error("db down"))],
    [
      "a gate of another renderer",
      () => readLatestGateMock.mockResolvedValueOnce(listGate({ xRenderer: "@cinatra-test/pack-agent:output" })),
    ],
    ["a gate of another review task", () => readLatestGateMock.mockResolvedValueOnce(listGate({ reviewTaskId: "task-other" }))],
    [
      "a run parked on a publish decision after the list step",
      () =>
        assertNoOpenPublishDecisionMock.mockRejectedValueOnce(
          Object.assign(new Error("held"), { code: "publish_decision_required" }),
        ),
    ],
    ["a publish hold that cannot be read", () => assertNoOpenPublishDecisionMock.mockRejectedValueOnce(new Error("db down"))],
    [
      "an answered list gate (the run went on and paused at another task: row and key name it)",
      () => {
        readAgentRunByIdMock.mockResolvedValueOnce(waitingRun({ a2aTaskId: "flow-task-2" }));
        resolveLatestTaskMock.mockResolvedValueOnce("flow-task-2");
      },
    ],
    [
      "a run row naming another task with no latest-task key to prove this one",
      () => {
        readAgentRunByIdMock.mockResolvedValueOnce(waitingRun({ a2aTaskId: "flow-task-2" }));
        resolveLatestTaskMock.mockResolvedValueOnce(null);
      },
    ],
    ["a stale task (the latest-task key names a later pause)", () => resolveLatestTaskMock.mockResolvedValueOnce("flow-task-2")],
    [
      "a setup gate, which names no flow task",
      () => readLatestGateMock.mockResolvedValueOnce(listGate({ reviewTaskId: `setup-${RUN_ID}` })),
    ],
  ];

  for (const [name, arrange] of notWaiting) {
    // red-first-expect: readListStepContent is not a function
    it(`${name} is refused with the fixed code and no CRM call`, async () => {
      arrange();
      const rejection = await rejectionOf(readListStepContent(RUN_ID, TASK_ID));
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toBe("list_step_not_waiting");
      expect(resolveCrmListReader).not.toHaveBeenCalled();
      expect(searchMock).not.toHaveBeenCalled();
    });
  }

  // red-first-expect: readListStepContent is not a function
  it("reads the newest gate of the run the person may read", async () => {
    await readListStepContent(RUN_ID, TASK_ID);
    expect(readLatestGateMock).toHaveBeenCalledWith(RUN_ID);
  });

  // red-first-expect: readListStepContent is not a function
  it("the list gate the run waits at reads, after the publish hold and the latest-task key are asked", async () => {
    await expect(readListStepContent(RUN_ID, TASK_ID)).resolves.toMatchObject({ listsRead: "ok" });
    expect(assertNoOpenPublishDecisionMock).toHaveBeenCalledWith(RUN_ID);
    expect(resolveLatestTaskMock).toHaveBeenCalledWith(RUN_ID);
    expect(searchMock).toHaveBeenCalledTimes(1);
  });

  // red-first-expect: readListStepContent is not a function
  it("a stale run row whose latest-task key names this gate reads, as answering the gate would", async () => {
    // The row's task-id write lost its race and still names the earlier task;
    // the key, written when the gate was shown, names this one.
    readAgentRunByIdMock.mockResolvedValueOnce(waitingRun({ a2aTaskId: "flow-task-0" }));
    resolveLatestTaskMock.mockResolvedValueOnce(GATE_TASK);
    await expect(readListStepContent(RUN_ID, TASK_ID)).resolves.toMatchObject({ listsRead: "ok" });
    expect(searchMock).toHaveBeenCalledTimes(1);
  });

  // red-first-expect: readListStepContent is not a function
  it("a stale run row whose latest-task key names a later task is refused", async () => {
    readAgentRunByIdMock.mockResolvedValueOnce(waitingRun({ a2aTaskId: "flow-task-0" }));
    resolveLatestTaskMock.mockResolvedValueOnce("flow-task-2");
    const rejection = await rejectionOf(readListStepContent(RUN_ID, TASK_ID));
    expect((rejection as Error).message).toBe("list_step_not_waiting");
    expect(searchMock).not.toHaveBeenCalled();
  });

  // red-first-expect: readListStepContent is not a function
  it("a latest-task key that cannot be read leaves the run row's word, as on the answer road", async () => {
    resolveLatestTaskMock.mockRejectedValueOnce(new Error("redis down"));
    await expect(readListStepContent(RUN_ID, TASK_ID)).resolves.toMatchObject({ listsRead: "ok" });
  });
});

describe("readListStepContent — the run itself must be allowed the CRM list read", () => {
  // red-first-expect: readListStepContent is not a function
  it("a ceiling narrower than the organization answers the failed shape with no CRM call", async () => {
    // A team-owned run whose stored ceiling carries the team: the derivation
    // agrees, and the boundary itself refuses the narrower ceiling.
    readTemplateMock.mockResolvedValueOnce(TEAM_TEMPLATE);
    readAgentRunByIdMock.mockResolvedValueOnce(waitingRun({ oboCeiling: TEAM_CEILING }));
    await expect(readListStepContent(RUN_ID, TASK_ID)).resolves.toEqual({ lists: [], listsRead: "failed" });
    expect(resolveCrmListReader).not.toHaveBeenCalled();
    expect(searchMock).not.toHaveBeenCalled();
    // The boundary's own refusal of the flow's list-read tool, recorded for the run.
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "crm_list_search",
        decision: "denied",
        runId: RUN_ID,
        metadata: expect.objectContaining({ reason: "agent_run_obo_scope_unsupported" }),
      }),
    );
  });

  // red-first-expect: readListStepContent is not a function
  it("a team-owned run with an organization-only stored ceiling answers the failed shape with no CRM call", async () => {
    // The stored chain does not contain the team the template anchors the run
    // to, so the live tool mint would refuse its token; the re-read refuses too.
    readTemplateMock.mockResolvedValueOnce(TEAM_TEMPLATE);
    await expect(readListStepContent(RUN_ID, TASK_ID)).resolves.toEqual({ lists: [], listsRead: "failed" });
    expect(readTemplateMock).toHaveBeenCalledWith(TEMPLATE_ID);
    expect(resolveCrmListReader).not.toHaveBeenCalled();
    expect(searchMock).not.toHaveBeenCalled();
  });

  // red-first-expect: readListStepContent is not a function
  it("a corrupt template anchor (nothing derived) answers the failed shape with no CRM call", async () => {
    readTemplateMock.mockResolvedValueOnce({ id: TEMPLATE_ID, ownerLevel: "team", ownerId: "" });
    await expect(readListStepContent(RUN_ID, TASK_ID)).resolves.toEqual({ lists: [], listsRead: "failed" });
    expect(searchMock).not.toHaveBeenCalled();
  });

  // red-first-expect: readListStepContent is not a function
  it("a run without a stored ceiling answers the failed shape with no CRM call", async () => {
    readAgentRunByIdMock.mockResolvedValueOnce(waitingRun({ oboCeiling: null }));
    await expect(readListStepContent(RUN_ID, TASK_ID)).resolves.toEqual({ lists: [], listsRead: "failed" });
    expect(searchMock).not.toHaveBeenCalled();
  });

  // red-first-expect: readListStepContent is not a function
  it("a run without a person answers the failed shape with no CRM call", async () => {
    readAgentRunByIdMock.mockResolvedValueOnce(waitingRun({ runBy: null }));
    await expect(readListStepContent(RUN_ID, TASK_ID)).resolves.toEqual({ lists: [], listsRead: "failed" });
    expect(searchMock).not.toHaveBeenCalled();
  });

  // red-first-expect: readListStepContent is not a function
  it("an organization-only ceiling for a member passes the boundary, which records the allowed list read", async () => {
    await expect(readListStepContent(RUN_ID, TASK_ID)).resolves.toEqual({
      lists: [
        { id: "l-1", name: "Customers" },
        { id: "l-2", name: "Prospects" },
      ],
      listsRead: "ok",
    });
    expect(resolveOrgRoleForUserMock).toHaveBeenCalledWith("org-1", "member-1");
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "crm_list_search", decision: "allowed", runId: RUN_ID }),
    );
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock).toHaveBeenCalledWith({ query: "", objectType: "contact" });
  });
});

describe("readListStepContent — the run's actor is resolved as a live run step resolves it", () => {
  const noActor: Array<[string, () => void]> = [
    [
      "a person removed from the run's organization",
      () => {
        authRows.members = [];
        resolveOrgRoleForUserMock.mockResolvedValue(undefined as never);
      },
    ],
    [
      "a person whose account is gone (no user row)",
      () => {
        authRows.users = [];
      },
    ],
  ];
  for (const [name, arrange] of noActor) {
    // red-first-expect: readListStepContent is not a function
    it(`${name} gets the failed shape, with no CRM call`, async () => {
      arrange();
      await expect(readListStepContent(RUN_ID, TASK_ID)).resolves.toEqual({ lists: [], listsRead: "failed" });
      expect(resolveCrmListReader).not.toHaveBeenCalled();
      expect(searchMock).not.toHaveBeenCalled();
    });
  }

  // red-first-expect: readListStepContent is not a function
  it("a person who acts in another organization than the run's gets the failed shape, with no CRM call", async () => {
    requireActorContextMock.mockResolvedValueOnce({
      principalId: "member-1",
      organizationId: "org-2",
      orgRole: "member" as const,
      platformRole: "member" as const,
    });
    await expect(readListStepContent(RUN_ID, TASK_ID)).resolves.toEqual({ lists: [], listsRead: "failed" });
    expect(resolveCrmListReader).not.toHaveBeenCalled();
    expect(searchMock).not.toHaveBeenCalled();
  });
});

describe("readListStepContent — the read and what it answers", () => {
  // red-first-expect: readListStepContent is not a function
  it("a failed search answers the failed shape, and no error text leaves or is logged", async () => {
    const marker = "upstream-message-must-not-leave";
    searchMock.mockRejectedValueOnce(new Error(marker));
    const answer = await readListStepContent(RUN_ID, TASK_ID);
    expect(answer).toEqual({ lists: [], listsRead: "failed" });
    expect(JSON.stringify(answer)).not.toContain(marker);
    expect(everythingLogged()).not.toContain(marker);
    expect(warnSpy).toHaveBeenCalledWith(
      "[list-picker] the CRM list search failed (Error); the step shows the failed read",
    );
  });

  // red-first-expect: readListStepContent is not a function
  it("a missing CRM capability answers the failed shape", async () => {
    vi.mocked(resolveCrmListReader).mockImplementationOnce(() => null as never);
    await expect(readListStepContent(RUN_ID, TASK_ID)).resolves.toEqual({ lists: [], listsRead: "failed" });
  });

  // red-first-expect: readListStepContent is not a function
  it("drops blank ids and names and keeps a repeated id once", async () => {
    searchMock.mockResolvedValueOnce([
      { id: "l-1", name: "Customers", objectType: "contact" },
      { id: " ", name: "Blank id", objectType: "contact" },
      { id: "l-3", name: "  ", objectType: "contact" },
      { id: "l-1", name: "Customers again", objectType: "contact" },
      { id: "l-4", name: "Partners", objectType: "contact" },
    ]);
    await expect(readListStepContent(RUN_ID, TASK_ID)).resolves.toEqual({
      lists: [
        { id: "l-1", name: "Customers" },
        { id: "l-4", name: "Partners" },
      ],
      listsRead: "ok",
    });
  });

  // red-first-expect: readListStepContent is not a function
  it("writes one log line per read with the run and the review task, and no list", async () => {
    await readListStepContent(RUN_ID, TASK_ID);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      `[list-picker] the list step is read again (run ${RUN_ID}, review task ${TASK_ID})`,
    );
    expect(everythingLogged()).not.toContain("Customers");
  });
});
