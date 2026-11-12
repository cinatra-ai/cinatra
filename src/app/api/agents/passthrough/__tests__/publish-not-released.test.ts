/**
 * cinatra#4150 part 5a (A6) — the deterministic passthrough road refuses a call
 * that the publish decision does not let through, before any tool runs.
 *
 * After the run binding proves the run, the road asks `publishCallAllowed` (its
 * decision matrix is pinned in
 * packages/agents/src/__tests__/publish-call-guard.test.ts) with that run and the
 * verified step of the calling flow step, or with no step when the call carries
 * no valid signed pair. A refused call answers 403 with code
 * `publish_not_released` and a text that names no run or step.
 *
 * Drives the real route and the real run binding; the run store, the handler
 * registry, the bridge-auth check and the actor builder are test doubles.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const h = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByContextId: vi.fn(),
  publishCallAllowed: vi.fn<(run: unknown, step: unknown) => Promise<boolean>>(async () => true),
  resolveLatestWayflowGateTaskId: vi.fn(async () => null as string | null),
  observed: [] as Array<{ tool: string; frame: unknown }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/agents", () => ({
  publishCallAllowed: h.publishCallAllowed,
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
  h.publishCallAllowed.mockReset().mockResolvedValue(true);
  process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_KEY;
});

afterEach(() => {
  if (ATTEST_BEFORE === undefined) delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
  else process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_BEFORE;
});

describe("the passthrough road refuses a publish the decision does not let through", () => {
  it("asks with the proved run and the verified step, and refuses before any tool runs", async () => {
    h.publishCallAllowed.mockResolvedValue(false);
    const res = await POST(makeReq(RUN_SCOPED_TOOL, stepHeaders()));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("publish_not_released");
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`${RUN.id}|${NODE}|${CTX}`));
    expect(h.publishCallAllowed).toHaveBeenCalledTimes(1);
    const [run, step] = h.publishCallAllowed.mock.calls[0] as unknown as [{ id: string; templateId: string }, unknown];
    expect(run).toMatchObject({ id: RUN.id, templateId: RUN.templateId });
    expect(step).toBe(NODE);
    expect(h.observed).toHaveLength(0);
  });

  it("a call with no valid step pair asks with no step, and is refused the same way", async () => {
    const valid = stepHeaders();
    for (const headers of [{}, stepHeaders({ key: "another-key-under-test" }), { ...valid, "x-cinatra-step-node": "other-node" }]) {
      h.publishCallAllowed.mockReset().mockResolvedValue(false);
      h.observed.length = 0;
      for (const tool of [RUN_SCOPED_TOOL, FRAMELESS_TOOL]) {
        const res = await POST(makeReq(tool, headers));
        expect(res.status).toBe(403);
        expect(((await res.json()) as { code?: string }).code).toBe("publish_not_released");
      }
      for (const call of h.publishCallAllowed.mock.calls) expect(call[1]).toBeUndefined();
      expect(h.observed).toHaveLength(0);
    }
  });

  it("a call the decision lets through is served as before", async () => {
    const res = await POST(makeReq(RUN_SCOPED_TOOL, stepHeaders()));
    expect(res.status).toBe(200);
    expect(h.publishCallAllowed).toHaveBeenCalledTimes(1);
    expect(h.observed).toHaveLength(1);
  });

  it("a call whose run binding fails is refused by the binding and not asked", async () => {
    const res = await POST(makeReq(RUN_SCOPED_TOOL, { "x-cinatra-a2a-context-id": "ctx-unknown" }));
    expect(res.status).not.toBe(200);
    expect(h.publishCallAllowed).not.toHaveBeenCalled();
    expect(h.observed).toHaveLength(0);
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
