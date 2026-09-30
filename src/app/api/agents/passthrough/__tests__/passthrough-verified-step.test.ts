/**
 * cinatra#3745 — the deterministic passthrough road stamps the verified step
 * of the calling flow step on the run-scoped frame it opens.
 *
 * After the run binding proves the run from the context-id header, the runtime's
 * signed step pair is verified with that context id, and the frame the road
 * opens for a run-scoped tool carries `verifiedStepId`. A tool the road serves
 * without a frame keeps that path. A call without a valid pair is served
 * exactly as before and carries no step.
 *
 * Drives the real route and the real run binding; the run store, the handler
 * registry, the bridge-auth check and the actor builder are test doubles.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const h = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByContextId: vi.fn(),
  resolveLatestWayflowGateTaskId: vi.fn(async () => null as string | null),
  observed: [] as Array<{ tool: string; frame: unknown }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: h.readAgentRunById,
  readAgentRunByContextId: h.readAgentRunByContextId,
}));
vi.mock("@cinatra-ai/a2a", () => ({
  resolveLatestWayflowGateTaskId: h.resolveLatestWayflowGateTaskId,
}));
vi.mock("@cinatra-ai/mcp-server", async () => {
  const actual = await vi.importActual<typeof import("@cinatra-ai/mcp-server/request-context")>(
    "@cinatra-ai/mcp-server/request-context",
  );
  return { mcpRequestContextStorage: actual.mcpRequestContextStorage };
});
vi.mock("@cinatra-ai/llm/actor-context", () => ({
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/wayflow-bridge-auth", () => ({
  isAuthorizedBridgeRequest: () => true,
}));
vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  buildActorContextFromRun: vi.fn(async () => ({
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-1",
    platformRole: "member",
  })),
}));
vi.mock("@/lib/extension-scoped-tools", () => ({ EXTENSION_SCOPED_TOOLS: new Set<string>() }));
vi.mock("@/lib/run-folder-tools", () => ({ RUN_FOLDER_TOOLS: new Set<string>() }));
vi.mock("@/lib/primitive-handlers", async () => {
  const { mcpRequestContextStorage } = await vi.importActual<
    typeof import("@cinatra-ai/mcp-server/request-context")
  >("@cinatra-ai/mcp-server/request-context");
  const handler = (tool: string) => async () => {
    h.observed.push({ tool, frame: mcpRequestContextStorage.getStore() });
    return { ok: true };
  };
  return {
    collectAllPrimitiveHandlers: async () => ({
      agent_run_hitl_prompts_list: handler("agent_run_hitl_prompts_list"),
      trigger_config_set: handler("trigger_config_set"),
    }),
  };
});

import { POST } from "@/app/api/agents/passthrough/route";

const ATTEST_KEY = "step-attest-key-under-test";
const CTX = "ctx-run-1";
const NODE = "flow-step-node-1";
const RUN = {
  id: "run-1",
  orgId: "org-1",
  runBy: "user-1",
  templateId: "tpl-1",
  packageVersion: null,
  oboCeiling: null,
};
// A frameless tool and a run-scoped tool on the road's allowlist.
const FRAMELESS_TOOL = "trigger_config_set";
const RUN_SCOPED_TOOL = "agent_run_hitl_prompts_list";

const ATTEST_BEFORE = process.env.CINATRA_CONTEXT_ATTEST_KEY;

function stepHeaders(opts: { ctx?: string; node?: string; key?: string } = {}) {
  const ctx = opts.ctx ?? CTX;
  const node = opts.node ?? NODE;
  const key = opts.key ?? ATTEST_KEY;
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const sig = createHmac("sha256", key).update(`s1\n${ctx}\n${node}\n${expiry}`).digest("hex");
  return { "x-cinatra-step-node": node, "x-cinatra-step-attestation": `s1:${expiry}:${sig}` };
}

function makeReq(tool: string, headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/api/agents/passthrough", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cinatra-a2a-context-id": CTX,
      ...headers,
    },
    body: JSON.stringify({ tool, input: {}, agent_run_id: RUN.id }),
  });
}

beforeEach(() => {
  h.observed.length = 0;
  h.readAgentRunById.mockReset().mockResolvedValue(RUN);
  h.readAgentRunByContextId.mockReset().mockImplementation(async (ctx: string) =>
    ctx === CTX ? RUN : null,
  );
  h.resolveLatestWayflowGateTaskId.mockReset().mockResolvedValue(null);
  process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_KEY;
});

afterEach(() => {
  if (ATTEST_BEFORE === undefined) delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
  else process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_BEFORE;
});

describe("the passthrough road's verified step", () => {
  // (t1)
  it("a run-scoped tool called with a valid step pair sees the step on its frame", async () => {
    const res = await POST(makeReq(RUN_SCOPED_TOOL, stepHeaders()));
    expect(res.status).toBe(200);
    expect(h.observed).toHaveLength(1);
    const frame = h.observed[0]!.frame as Record<string, unknown>;
    expect(frame.verifiedRunScopeId).toBe(RUN.id);
    expect(frame.verifiedStepId).toBe(NODE);
  });

  // (t2)
  it("an invalid or absent pair leaves the run-scoped frame as before, with no step", async () => {
    const valid = stepHeaders();
    const variants: Array<Record<string, string>> = [
      {},
      stepHeaders({ ctx: "ctx-run-2" }),
      stepHeaders({ key: "another-key-under-test" }),
      { ...valid, "x-cinatra-step-node": "other-node" },
      { "x-cinatra-step-node": NODE, "x-cinatra-step-id": NODE },
    ];
    for (const headers of variants) {
      h.observed.length = 0;
      const res = await POST(makeReq(RUN_SCOPED_TOOL, headers));
      expect(res.status).toBe(200);
      expect(h.observed).toHaveLength(1);
      const frame = h.observed[0]!.frame as Record<string, unknown>;
      expect(frame).toEqual({
        runId: RUN.id,
        verifiedRunScopeId: RUN.id,
        userId: RUN.runBy,
        orgId: RUN.orgId,
      });
    }
  });

  // (t3)
  it("a tool served without a frame is invoked as before and no frame is opened", async () => {
    const res = await POST(makeReq(FRAMELESS_TOOL, stepHeaders()));
    expect(res.status).toBe(200);
    expect(h.observed).toHaveLength(1);
    expect(h.observed[0]!.tool).toBe(FRAMELESS_TOOL);
    expect(h.observed[0]!.frame).toBeUndefined();
  });
});

// Leave the module registry as this file found it.
afterAll(() => {
  vi.doUnmock("server-only");
  vi.doUnmock("@cinatra-ai/agents");
  vi.doUnmock("@cinatra-ai/a2a");
  vi.doUnmock("@cinatra-ai/mcp-server");
  vi.doUnmock("@cinatra-ai/llm/actor-context");
  vi.doUnmock("@/lib/wayflow-bridge-auth");
  vi.doUnmock("@/lib/authz/build-actor-context-from-run");
  vi.doUnmock("@/lib/extension-scoped-tools");
  vi.doUnmock("@/lib/run-folder-tools");
  vi.doUnmock("@/lib/primitive-handlers");
  vi.resetModules();
});
