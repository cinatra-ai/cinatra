/**
 * cinatra#3092 — the passthrough admits `dashboards_create`, and only that
 * dashboards tool, for the run the bridge binding PROVED.
 *
 * The write runs as the proven run's owner in the run's organization, carries
 * the proven run id (so the twin names the run as the producer), and holds the
 * org-write authority minted by the SAME function the MCP transport uses for an
 * agent-run frame. Every unproven run is refused before the tool runs: a
 * binding that fails, a run with no owner, a run with no current attempt, a run
 * whose attempt changed after the binding read it, a run with no OBO ceiling, a
 * run whose stored ceiling does not contain the chain re-derived from its
 * template anchor (the model bridge's mint-time check), and a run the mint
 * refuses (not inside a live attempt). A tool error of an
 * unknown code answers a fixed sentence, never its own text.
 *
 *   npx vitest run src/__tests__/passthrough-dashboards-create-3092.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  isAuthorizedMock,
  bindBridgeRunIdMock,
  readAgentRunByIdMock,
  readAgentTemplateByIdMock,
  buildActorContextFromRunMock,
  collectAllPrimitiveHandlersMock,
  mintRunWriteAuthorityForMcpMock,
  dashboardsCreateMock,
} = vi.hoisted(() => ({
  isAuthorizedMock: vi.fn(() => true),
  bindBridgeRunIdMock: vi.fn(),
  readAgentRunByIdMock: vi.fn(),
  readAgentTemplateByIdMock: vi.fn(),
  buildActorContextFromRunMock: vi.fn(async () => ({
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-a",
    platformRole: "member",
  })),
  collectAllPrimitiveHandlersMock: vi.fn(),
  mintRunWriteAuthorityForMcpMock: vi.fn(),
  dashboardsCreateMock: vi.fn(),
}));

vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: readAgentRunByIdMock,
  readAgentTemplateById: readAgentTemplateByIdMock,
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
// The entry exports the create write only (no update, publish or archive).
vi.mock("@cinatra-ai/dashboards/mcp", () => ({
  createDashboardForRun: dashboardsCreateMock,
}));

import { POST } from "../app/api/agents/passthrough/route";

// The chain deriveOboCeilingChain gives an organization-anchored template.
const CEILING = [{ tier: "organization", id: "org-a" }];
const ORG_TEMPLATE = { id: "tpl-1", ownerLevel: "organization", ownerId: "org-a" };
const TEAM_TEMPLATE = { id: "tpl-1", ownerLevel: "team", ownerId: "team-1" };

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
  bindBridgeRunIdMock.mockResolvedValue({ ok: true, runId: "run-1", executionAttemptId: "att-1" });
  readAgentRunByIdMock.mockResolvedValue(RUN);
  readAgentTemplateByIdMock.mockResolvedValue(ORG_TEMPLATE);
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
    bindBridgeRunIdMock.mockResolvedValue({ ok: true, runId: "run-2", executionAttemptId: "att-1" });
    const res = await POST(post(createBody()));
    expect(res.status).toBe(403);
    expect(mintRunWriteAuthorityForMcpMock).not.toHaveBeenCalled();
    expect(dashboardsCreateMock).not.toHaveBeenCalled();
  });

  it("refuses a callback bound under one attempt when the run row is on another (rollover)", async () => {
    // The binding read attempt att-1; by the time the run row is read, the run
    // has moved to att-2. The claim is the binding's attempt, so it is stale.
    readAgentRunByIdMock.mockResolvedValue({ ...RUN, executionAttemptId: "att-2" });
    const res = await POST(post(createBody()));
    expect(res.status).toBe(403);
    expect(mintRunWriteAuthorityForMcpMock).not.toHaveBeenCalled();
    expect(dashboardsCreateMock).not.toHaveBeenCalled();
  });

  it("refuses a binding that read no attempt, before the mint", async () => {
    bindBridgeRunIdMock.mockResolvedValue({ ok: true, runId: "run-1", executionAttemptId: null });
    const res = await POST(post(createBody()));
    expect(res.status).toBe(403);
    expect(mintRunWriteAuthorityForMcpMock).not.toHaveBeenCalled();
    expect(dashboardsCreateMock).not.toHaveBeenCalled();
  });

  it.each([null, undefined, []])(
    "refuses a run with no OBO ceiling (%s), before the mint",
    async (oboCeiling) => {
      readAgentRunByIdMock.mockResolvedValue({ ...RUN, oboCeiling });
      const res = await POST(post(createBody()));
      expect(res.status).toBe(403);
      expect(mintRunWriteAuthorityForMcpMock).not.toHaveBeenCalled();
      expect(dashboardsCreateMock).not.toHaveBeenCalled();
    },
  );

  it("refuses a team-anchored run whose stored ceiling holds only the organization, before the mint", async () => {
    // The model bridge re-derives team-1 + org-a and refuses a chain without team-1.
    readAgentTemplateByIdMock.mockResolvedValue(TEAM_TEMPLATE);
    const res = await POST(post(createBody()));
    expect(res.status).toBe(403);
    expect(readAgentTemplateByIdMock).toHaveBeenCalledWith("tpl-1");
    expect(mintRunWriteAuthorityForMcpMock).not.toHaveBeenCalled();
    expect(dashboardsCreateMock).not.toHaveBeenCalled();
  });

  it("admits a team-anchored run whose stored ceiling contains the re-derived chain", async () => {
    readAgentTemplateByIdMock.mockResolvedValue(TEAM_TEMPLATE);
    const ceiling = [
      { tier: "team", id: "team-1" },
      { tier: "organization", id: "org-a" },
    ];
    readAgentRunByIdMock.mockResolvedValue({ ...RUN, oboCeiling: ceiling });
    const res = await POST(post(createBody()));
    expect(res.status).toBe(200);
    expect(mintRunWriteAuthorityForMcpMock).toHaveBeenCalledTimes(1);
    expect(dashboardsCreateMock.mock.calls[0][0].actor.oboCeiling).toEqual(ceiling);
  });

  it("refuses when the template read fails, before the mint", async () => {
    readAgentTemplateByIdMock.mockRejectedValue(new Error("db down"));
    const res = await POST(post(createBody()));
    expect(res.status).toBe(403);
    expect(mintRunWriteAuthorityForMcpMock).not.toHaveBeenCalled();
  });

  it("answers the tool's own refusal with a non-2xx, so the flow step fails", async () => {
    dashboardsCreateMock.mockResolvedValue({ error: { code: "forbidden", message: "no" } });
    const res = await POST(post(createBody()));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: { code: "forbidden", message: "no" } });
  });

  it.each([
    { code: "internal_error", message: 'duplicate key value violates unique constraint "dashboards_pkey"' },
    { code: "some_new_code", message: "relation cinatra.dashboards: connection detail" },
    "a bare error text naming a table",
  ])("answers a tool error of an unknown code with a fixed sentence, never its text", async (error) => {
    dashboardsCreateMock.mockResolvedValue({ error });
    const res = await POST(post(createBody()));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: { code: "internal_error", message: "dashboards_create failed" } });
    expect(JSON.stringify(body)).not.toMatch(/duplicate|relation|table|connection/);
  });

  it.each(["dashboards_update", "dashboards_publish", "dashboards_archive", "dashboards_get"])(
    "keeps %s off the allowlist",
    async (tool) => {
      const res = await POST(post({ ...createBody(), tool }));
      expect(res.status).toBe(403);
      expect(dashboardsCreateMock).not.toHaveBeenCalled();
      expect(mintRunWriteAuthorityForMcpMock).not.toHaveBeenCalled();
    },
  );
});
