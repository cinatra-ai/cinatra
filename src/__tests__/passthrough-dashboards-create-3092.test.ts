/**
 * cinatra#3092 — the passthrough admits `dashboards_create`, and only that
 * dashboards tool, for the run the bridge binding PROVED.
 *
 * The write runs as the proven run's owner in the run's organization, carries
 * the proven run id (so the twin names the run as the producer), and holds the
 * org-write authority minted by the SAME function the MCP transport uses for an
 * agent-run frame. Every unproven run is refused before the tool runs: a
 * binding that fails, a run with no owner, a run with no current attempt, and a
 * run the mint refuses (not inside a live attempt).
 *
 *   npx vitest run src/__tests__/passthrough-dashboards-create-3092.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  isAuthorizedMock,
  bindBridgeRunIdMock,
  readAgentRunByIdMock,
  buildActorContextFromRunMock,
  collectAllPrimitiveHandlersMock,
  mintRunWriteAuthorityForMcpMock,
  dashboardsCreateMock,
  otherDashboardsHandlerMock,
} = vi.hoisted(() => ({
  isAuthorizedMock: vi.fn(() => true),
  bindBridgeRunIdMock: vi.fn(),
  readAgentRunByIdMock: vi.fn(),
  buildActorContextFromRunMock: vi.fn(async () => ({
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-a",
    platformRole: "member",
  })),
  collectAllPrimitiveHandlersMock: vi.fn(),
  mintRunWriteAuthorityForMcpMock: vi.fn(),
  dashboardsCreateMock: vi.fn(),
  otherDashboardsHandlerMock: vi.fn(),
}));

vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: readAgentRunByIdMock,
}));
vi.mock("@/lib/primitive-handlers", () => ({
  collectAllPrimitiveHandlers: collectAllPrimitiveHandlersMock,
}));
vi.mock("@/lib/wayflow-bridge-auth", () => ({
  isAuthorizedBridgeRequest: isAuthorizedMock,
}));
vi.mock("@/lib/authz/bridge-run-binding", () => ({
  bindBridgeRunId: bindBridgeRunIdMock,
}));
vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  buildActorContextFromRun: buildActorContextFromRunMock,
}));
vi.mock("@cinatra-ai/llm/actor-context", () => ({
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/org-write/run-authority-mint", () => ({
  mintRunWriteAuthorityForMcp: mintRunWriteAuthorityForMcpMock,
}));
vi.mock("@cinatra-ai/dashboards/mcp", () => ({
  createDashboardPrimitiveHandlers: () => ({
    dashboards_create: dashboardsCreateMock,
    dashboards_update: otherDashboardsHandlerMock,
    dashboards_publish: otherDashboardsHandlerMock,
    dashboards_archive: otherDashboardsHandlerMock,
  }),
}));

import { POST } from "../app/api/agents/passthrough/route";

const CEILING = [{ kind: "template-anchor", scope: "org-a" }];

const RUN = {
  id: "run-1",
  runBy: "user-1",
  orgId: "org-a",
  templateId: "tpl-1",
  packageVersion: "0.0.0",
  executionAttemptId: "att-1",
  oboCeiling: CEILING,
};

const AUTHORITY = { orgId: "org-a", can: (c: string) => c === "content.write" };

const DC = {
  portlets: [] as unknown[],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

function post(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/agents/passthrough", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    tool: "dashboards_create",
    agent_run_id: "run-1",
    input: { name: "Run board", config: DC, ownerLevel: "user", ownerId: "me", ...overrides },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isAuthorizedMock.mockReturnValue(true);
  bindBridgeRunIdMock.mockResolvedValue({ ok: true, runId: "run-1" });
  readAgentRunByIdMock.mockResolvedValue(RUN);
  mintRunWriteAuthorityForMcpMock.mockResolvedValue(AUTHORITY);
  collectAllPrimitiveHandlersMock.mockResolvedValue({});
  dashboardsCreateMock.mockResolvedValue({ dashboard: { id: "dash-1", name: "Run board" } });
});

describe("POST /api/agents/passthrough — dashboards_create (cinatra#3092)", () => {
  it("admits dashboards_create and answers the new dashboard's id", async () => {
    const res = await POST(post(createBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      dashboardId: "dash-1",
      dashboard: { id: "dash-1", name: "Run board" },
    });
  });

  it("writes as the proven run's owner, with the proven run id and the run authority", async () => {
    await POST(post(createBody()));
    // The authority is minted by the MCP transport's agent-run mint, for the
    // proven run and the run row's own org and current attempt.
    expect(mintRunWriteAuthorityForMcpMock).toHaveBeenCalledWith({
      runId: "run-1",
      orgId: "org-a",
      executionAttemptId: "att-1",
    });
    expect(dashboardsCreateMock).toHaveBeenCalledTimes(1);
    const request = dashboardsCreateMock.mock.calls[0][0];
    expect(request.primitiveName).toBe("dashboards_create");
    expect(request.input).toEqual(createBody().input);
    expect(request.actor).toEqual({
      actorType: "model",
      source: "agent",
      userId: "user-1",
      orgId: "org-a",
      runId: "run-1",
      orgWriteAuthority: AUTHORITY,
      oboCeiling: CEILING,
    });
  });

  it("takes no identity from the body: the actor and the authority stay the run's", async () => {
    await POST(
      post(
        createBody({
          ownerLevel: "organization",
          ownerId: "org-b",
          orgId: "org-b",
          userId: "user-9",
          runId: "run-9",
          orgWriteAuthority: { orgId: "org-b" },
        }),
      ),
    );
    const request = dashboardsCreateMock.mock.calls[0][0];
    expect(request.actor.orgId).toBe("org-a");
    expect(request.actor.userId).toBe("user-1");
    expect(request.actor.runId).toBe("run-1");
    expect(request.actor.orgWriteAuthority).toBe(AUTHORITY);
    expect(mintRunWriteAuthorityForMcpMock.mock.calls[0][0].orgId).toBe("org-a");
  });

  it("refuses a body run id the binding does not prove, before any mint or write", async () => {
    bindBridgeRunIdMock.mockResolvedValue({
      ok: false,
      status: 403,
      error: "bridge run-binding failed: agent_run_id does not match the executing run",
    });
    const res = await POST(post({ ...createBody(), agent_run_id: "run-of-another-org" }));
    expect(res.status).toBe(403);
    expect(mintRunWriteAuthorityForMcpMock).not.toHaveBeenCalled();
    expect(dashboardsCreateMock).not.toHaveBeenCalled();
  });

  it("refuses a run outside a live attempt (the mint gives no authority)", async () => {
    mintRunWriteAuthorityForMcpMock.mockResolvedValue(undefined);
    const res = await POST(post(createBody()));
    expect(res.status).toBe(403);
    // The fixed refusal of ./run-dashboard-create (no import: on the base tree
    // this file loads and its admission cases fail on the 403 allowlist answer).
    expect((await res.json()).error).toMatch(/cannot write a dashboard: .*no live attempt/);
    expect(dashboardsCreateMock).not.toHaveBeenCalled();
  });

  it("refuses a run with no current attempt, before the mint", async () => {
    readAgentRunByIdMock.mockResolvedValue({ ...RUN, executionAttemptId: null });
    const res = await POST(post(createBody()));
    expect(res.status).toBe(403);
    expect(mintRunWriteAuthorityForMcpMock).not.toHaveBeenCalled();
    expect(dashboardsCreateMock).not.toHaveBeenCalled();
  });

  it("refuses a run with no owner, before the mint", async () => {
    readAgentRunByIdMock.mockResolvedValue({ ...RUN, runBy: null });
    const res = await POST(post(createBody()));
    expect(res.status).toBe(403);
    expect(mintRunWriteAuthorityForMcpMock).not.toHaveBeenCalled();
    expect(dashboardsCreateMock).not.toHaveBeenCalled();
  });

  it("refuses when the bound run is not the run row read", async () => {
    bindBridgeRunIdMock.mockResolvedValue({ ok: true, runId: "run-2" });
    const res = await POST(post(createBody()));
    expect(res.status).toBe(403);
    expect(mintRunWriteAuthorityForMcpMock).not.toHaveBeenCalled();
    expect(dashboardsCreateMock).not.toHaveBeenCalled();
  });

  it("answers the tool's own refusal with a non-2xx, so the flow step fails", async () => {
    dashboardsCreateMock.mockResolvedValue({ error: { code: "forbidden", message: "no" } });
    const res = await POST(post(createBody()));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: { code: "forbidden", message: "no" } });
  });

  it("forwards no ceiling when the run has none", async () => {
    readAgentRunByIdMock.mockResolvedValue({ ...RUN, oboCeiling: null });
    await POST(post(createBody()));
    expect(dashboardsCreateMock.mock.calls[0][0].actor).not.toHaveProperty("oboCeiling");
  });

  it.each(["dashboards_update", "dashboards_publish", "dashboards_archive", "dashboards_get"])(
    "keeps %s off the allowlist",
    async (tool) => {
      const res = await POST(post({ ...createBody(), tool }));
      expect(res.status).toBe(403);
      expect(otherDashboardsHandlerMock).not.toHaveBeenCalled();
      expect(mintRunWriteAuthorityForMcpMock).not.toHaveBeenCalled();
    },
  );
});
