/**
 * cinatra#3089: the passthrough road uses the person's decision through the REAL single-use consumption
 * (`consumeRunActionDecision`, cinatra#3745) for a direct passthrough publishing step: the run's bound source is the
 * publishing-step fixture of this pull request (a top-level `/api/agents/passthrough` ApiNode with `publishes: true`
 * whose request names `email_outreach_send_initial_start`), read by the host's real step-tool reader. The first signed
 * call reaches the send; the same call again answers the fixed 409 and never reaches it.
 *
 * Drives the real route, the real run binding and source-bound step proof, the real declaration reader, the real
 * consumption and the owning package's real metadata, handlers and argument schema. The run store reads, the guarded
 * transaction (a stand-in that keeps each table's rows in memory; the consumption table behaves as its primary key
 * does), the authority mint, the bridge-auth check, the actor builder and the send's use cases are test doubles.
 */
// red-first-expect: expected 403 to be 200
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  agentRunOutwardActionPolicies,
  agentRunPublishDecisions,
  agentRuns,
  artifactReviewActionConsumptions,
} from "../../../../../../packages/agents/src/schema";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByContextId: vi.fn(),
  publishCallAllowed: vi.fn(),
  publishingStepCallReleased: vi.fn(),
  verifyRunExecutedSource: vi.fn(),
  tables: new Map<unknown, Record<string, unknown>[]>(),
  sendFails: 0,
  sends: [] as Array<{ input: unknown; actor: unknown; frame: unknown }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/agents", () => ({
  publishCallAllowed: h.publishCallAllowed,
  publishingStepCallReleased: h.publishingStepCallReleased,
  readAgentRunById: h.readAgentRunById,
  readAgentRunByContextId: h.readAgentRunByContextId,
}));
vi.mock("@cinatra-ai/agents/store", async () => ({
  verifyRunExecutedSource: h.verifyRunExecutedSource,
  RunStepToolPolicyRefusal: (await vi.importActual<typeof import("../../../../../../packages/agents/src/agent-run-serde")>("../../../../../../packages/agents/src/agent-run-serde"))
    .RunStepToolPolicyRefusal,
}));
vi.mock("../../../../../../packages/agents/src/db", () => ({ db: { transaction: () => { throw Error("must use the guarded seam"); } } }));
vi.mock("../../../../../../packages/agents/src/org-write-run-seam", () => ({
  guardedRunWrite: async (authority: unknown, _opts: unknown, body: (tx: object) => Promise<unknown>) => {
    if (!authority) throw Error("org write refused");
    const tx = {
      select: (columns?: Record<string, unknown>) => ({
        from: (table: unknown) => {
          const chain = {
            where: () => chain, orderBy: () => chain, limit: () => chain, for: () => chain,
            then: (resolve: (v: unknown) => unknown) => {
              const rows = (h.tables.get(table) ?? []).map((r) => ({ ...r }));
              return resolve(columns ? rows.map((r) => ({ gateId: r.gateId })) : rows);
            },
          };
          return chain;
        },
      }),
      insert: (table: unknown) => ({
        values: (value: Row) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              const rows = h.tables.get(table) ?? [];
              h.tables.set(table, rows);
              if (rows.some((r) => r.gateId === value.gateId)) return [];
              rows.push({ ...value });
              return [{ gateId: value.gateId }];
            },
          }),
        }),
      }),
    };
    return body(tx);
  },
}));
vi.mock("@/lib/org-write/run-authority-mint", () => ({
  mintRunWriteAuthorityForMcp: vi.fn(async () => Object.freeze({ orgId: "org-1", authority: "run-authority-under-test" })),
}));
vi.mock("@cinatra-ai/a2a", () => ({ resolveLatestWayflowGateTaskId: vi.fn(async () => null) }));
vi.mock("@cinatra-ai/mcp-server", async () => {
  const actual = await vi.importActual<typeof import("@cinatra-ai/mcp-server/request-context")>(
    "@cinatra-ai/mcp-server/request-context",
  );
  return { mcpRequestContextStorage: actual.mcpRequestContextStorage };
});
vi.mock("@cinatra-ai/llm/actor-context", () => ({
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/wayflow-bridge-auth", () => ({ isAuthorizedBridgeRequest: () => true }));
vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  buildActorContextFromRun: vi.fn(async () => ({
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-1",
    platformRole: "member",
  })),
  resolveRunOwnerMembershipOrgRole: vi.fn(async () => undefined),
}));
vi.mock("@/lib/extension-scoped-tools", () => ({ EXTENSION_SCOPED_TOOLS: new Set<string>() }));
vi.mock("@/lib/run-folder-tools", () => ({ RUN_FOLDER_TOOLS: new Set<string>() }));
vi.mock("@/lib/primitive-handlers", () => ({
  collectAllPrimitiveHandlers: async () => ({ trigger_config_set: async () => ({ ok: true }) }),
}));
vi.mock("@/lib/extension-host-context", () => ({
  prepareDeclaredRunToolArguments: async (_tool: string, input: unknown) => input,
  runActionRefusalClassCode: (err: unknown) =>
    (err as { name?: string } | null)?.name === "RunStepToolPolicyRefusal" ? (err as { code: string }).code : null,
  OutwardActionRefusal: class OutwardActionRefusal extends Error {
    constructor(readonly code: string) { super(code); this.name = "OutwardActionRefusal"; }
  },
}));
vi.mock("@/lib/trigger-email-send-use-cases", async () => {
  const { mcpRequestContextStorage } = await vi.importActual<
    typeof import("@cinatra-ai/mcp-server/request-context")
  >("@cinatra-ai/mcp-server/request-context");
  return {
    createTriggerEmailSendUseCases: () => ({
      startInitialSend: async (input: unknown, actor: unknown) => {
        h.sends.push({ input, actor, frame: mcpRequestContextStorage.getStore() });
        if (h.sendFails > 0) {
          h.sendFails -= 1;
          throw new Error("the mail provider did not answer");
        }
        return { operationId: "camp-1", kind: "initial_send", status: "completed" };
      },
    }),
  };
});

import { POST } from "@/app/api/agents/passthrough/route";

const ATTEST_KEY = "step-attest-key-under-test";
const CTX = "ctx-run-1";
const NODE = "send_campaign";
const SEND = "email_outreach_send_initial_start";
const RUN = { id: "run-1", orgId: "org-1", runBy: "user-1", templateId: "tpl-1", packageVersion: null, oboCeiling: null };
const SEND_INPUT = {
  campaignId: "camp-1",
  approvedDraftBundleRef: "11111111-1111-4111-8111-111111111111",
  confirmedRecipientsRef: "22222222-2222-4222-8222-222222222222",
};
const ATTEST_BEFORE = process.env.CINATRA_CONTEXT_ATTEST_KEY;
const FLOW = readFileSync(
  new URL("../../../../../../scripts/ci/__tests__/__fixtures__/pin-advance-host-tools/publishing-step-declared-tool.oas.json", import.meta.url),
  "utf8",
);
const SHA = createHash("sha256").update(FLOW).digest("hex");
const VERIFIED_SOURCE = Object.freeze({ contextId: CTX, stepId: NODE, executionAttemptId: "attempt-1", sourceSha256: SHA,
  executedSourceSha256: SHA, declarationSourceSha256: SHA });
const POLICY = { version: 1, contextId: CTX, sourceSha256: SHA, executedSourceSha256: SHA, declarationSourceSha256: SHA,
  source: FLOW };

/** A signed call of the step. `decision`: the publish decision of the call's visit, signed beside the pair (`s3`). */
function makeReq(opts: { decision?: string; decisionSig?: string; sourceHeaders?: boolean } = {}): Request {
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const sig = createHmac("sha256", ATTEST_KEY).update(`s2\n${CTX}\n${NODE}\nattempt-1\n${SHA}\n${SHA}\n${SHA}\n${expiry}`).digest("hex");
  const headers: Record<string, string> = { "content-type": "application/json", "x-cinatra-a2a-context-id": CTX,
    "x-cinatra-step-node": NODE, "x-cinatra-step-attestation": `s2:${expiry}:${sig}` };
  if (opts.sourceHeaders !== false) {
    Object.assign(headers, { "x-cinatra-execution-attempt": "attempt-1", "x-cinatra-raw-source": SHA,
      "x-cinatra-executed-source": SHA, "x-cinatra-declaration-source": SHA });
  }
  if (opts.decision !== undefined) {
    const decisionSig = opts.decisionSig ?? createHmac("sha256", ATTEST_KEY)
      .update(`s3\n${CTX}\n${NODE}\nattempt-1\n${SHA}\n${SHA}\n${SHA}\n${opts.decision}\n${sig}\n${expiry}`).digest("hex");
    headers["x-cinatra-publish-decision"] = opts.decision;
    headers["x-cinatra-publish-decision-attestation"] = `s3:${expiry}:${decisionSig}`;
  }
  return new Request("http://localhost:3000/api/agents/passthrough", {
    method: "POST",
    headers,
    body: JSON.stringify({ tool: SEND, input: SEND_INPUT, agent_run_id: RUN.id }),
  });
}

/** A released decision row of the step (or of `nodeId`), created `minute` minutes after the first. */
const decisionRow = (id: string, minute: number, nodeId = NODE) => ({ id, orgId: RUN.orgId, runId: RUN.id, nodeId,
  gateTaskId: `gate-task-${id}`, status: "released", decidedBy: "user-7", decidedAt: new Date(Date.UTC(2026, 10, 24, 10, minute)),
  createdAt: new Date(Date.UTC(2026, 10, 24, 9, minute)), runGeneration: 0, surfacedValues: "{}", declaredRows: null,
  a2aContextId: CTX, decisionNote: null, expiresAt: new Date(Date.UTC(2026, 10, 25, 9, minute)) });
const used = () => (h.tables.get(artifactReviewActionConsumptions) ?? []).map((r) => r.gateId);
const codeOf = async (res: Response) => ((await res.json()) as { code?: string }).code;

beforeEach(() => {
  h.sends.length = 0;
  h.sendFails = 0;
  h.tables = new Map<unknown, Row[]>([
    [agentRuns, [{ id: RUN.id, orgId: RUN.orgId, status: "running", executionAttemptId: "attempt-1", a2aContextId: CTX,
      resetGeneration: 0 }]],
    [agentRunOutwardActionPolicies, [{ runId: RUN.id, orgId: RUN.orgId, executionAttemptId: "attempt-1", policy: POLICY }]],
    [agentRunPublishDecisions, [decisionRow("decision-1", 0)]],
    [artifactReviewActionConsumptions, []],
  ]);
  h.readAgentRunById.mockReset().mockResolvedValue(RUN);
  h.readAgentRunByContextId.mockReset().mockImplementation(async (ctx: string) => (ctx === CTX ? RUN : null));
  h.publishCallAllowed.mockReset().mockResolvedValue(true);
  h.publishingStepCallReleased.mockReset().mockResolvedValue(true);
  h.verifyRunExecutedSource.mockReset().mockResolvedValue(VERIFIED_SOURCE);
  process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_KEY;
});

afterEach(() => {
  if (ATTEST_BEFORE === undefined) delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
  else process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_BEFORE;
});

describe("a direct passthrough publishing step's call, used through the real consumption", () => {
  it("the first signed call reaches the send and records the decision as used under publish_decision:<id>", async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(h.sends).toHaveLength(1);
    expect(h.tables.get(artifactReviewActionConsumptions)).toEqual([
      expect.objectContaining({ gateId: "publish_decision:decision-1", stepId: NODE,
        toolIdentity: expect.objectContaining({ toolName: SEND, installId: "host-builtin" }) }),
    ]);
  });

  it("the same call again answers the fixed 409 and never reaches the send", async () => {
    expect((await POST(makeReq())).status).toBe(200);
    const again = await POST(makeReq());
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code?: string }).code).toBe("publishing_step_call_performed");
    expect(h.sends).toHaveLength(1);
  });
});

// cinatra#3745 (#4791): a step entered twice in one attempt has one decision per visit, and the runtime signs the
// visit's decision beside the pair. The call uses only the decision of its own visit.
describe("a publishing step's call uses the decision of its own visit", () => {
  it("a delayed call of the first visit, after a second release, never uses the second visit's decision", async () => {
    expect((await POST(makeReq({ decision: "decision-1" }))).status).toBe(200);
    h.tables.get(agentRunPublishDecisions)!.push(decisionRow("decision-2", 5));
    const late = await POST(makeReq({ decision: "decision-1" }));
    expect(late.status).toBe(409);
    expect(used()).toEqual(["publish_decision:decision-1"]);
    expect(h.sends).toHaveLength(1);
  });

  it("the second visit's own call is served once", async () => {
    h.tables.get(agentRunPublishDecisions)!.push(decisionRow("decision-2", 5));
    expect((await POST(makeReq({ decision: "decision-2" }))).status).toBe(200);
    expect((await POST(makeReq({ decision: "decision-2" }))).status).toBe(409);
    expect(used()).toEqual(["publish_decision:decision-2"]);
    expect(h.sends).toHaveLength(1);
  });

  it("a call that names a decision of another step is refused, and uses nothing", async () => {
    h.tables.get(agentRunPublishDecisions)!.push(decisionRow("decision-other-step", 5, "another_step"));
    const res = await POST(makeReq({ decision: "decision-other-step" }));
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("action_decision_binding_mismatch");
    expect(used()).toEqual([]);
    expect(h.sends).toHaveLength(0);
  });

  it("a call that names a decision of another run is refused, and uses nothing", async () => {
    h.tables.get(agentRunPublishDecisions)!.push({ ...decisionRow("decision-other-run", 5), runId: "run-2" });
    const res = await POST(makeReq({ decision: "decision-other-run" }));
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("action_decision_binding_mismatch");
    expect(used()).toEqual([]);
  });

  it("a call that names no decision is served when the step has one visit", async () => {
    expect((await POST(makeReq())).status).toBe(200);
    expect(used()).toEqual(["publish_decision:decision-1"]);
  });

  it("a call that names no decision is refused when the step has two visits", async () => {
    h.tables.get(agentRunPublishDecisions)!.push(decisionRow("decision-2", 5));
    const res = await POST(makeReq());
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("action_decision_binding_missing");
    expect(h.sends).toHaveLength(0);
  });

  it("a decision whose signature does not verify, or that is named without the source pair, is refused before the send", async () => {
    expect((await POST(makeReq({ decision: "decision-1", decisionSig: "0".repeat(64) }))).status).toBe(403);
    expect((await POST(makeReq({ decision: "decision-1", sourceHeaders: false }))).status).toBe(403);
    expect(used()).toEqual([]);
    expect(h.sends).toHaveLength(0);
  });
});

afterAll(() => {
  for (const id of ["server-only", "@cinatra-ai/agents", "@cinatra-ai/agents/store", "../../../../../../packages/agents/src/db",
    "../../../../../../packages/agents/src/org-write-run-seam", "@/lib/org-write/run-authority-mint", "@cinatra-ai/a2a", "@cinatra-ai/mcp-server",
    "@cinatra-ai/llm/actor-context", "@/lib/wayflow-bridge-auth", "@/lib/authz/build-actor-context-from-run",
    "@/lib/extension-scoped-tools", "@/lib/run-folder-tools", "@/lib/primitive-handlers", "@/lib/extension-host-context",
    "@/lib/trigger-email-send-use-cases"]) vi.doUnmock(id);
  vi.resetModules();
});
