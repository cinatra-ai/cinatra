// red-first-expect: authorization denied for "example_outward_send": outward_effect_requires_recorded_decision
/**
 * cinatra#3745 — the inner road of the guarded outward run action.
 *
 * An extension's own in-process call (`ctx.mcp.callPrimitive`) of an outward
 * tool on a run frame takes the same guarded outward run action as the
 * transport: it is let through once, on the person's consumed decision for this
 * run, step and tool (and released item); every call the transport's action
 * refuses stays refused here.
 *
 * The real self-invoker, the real `enforceMcpBoundary` and the real guarded
 * action of `@/lib/extension-host-context` run. The host primitive map, the
 * audit writer, the classification reader and the run store are test doubles;
 * the store's consumption double keeps one released decision per (run, step)
 * for the tools that step declares, and refuses as the real store does.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mcpRequestContextStorage, type McpRequestContext } from "@cinatra-ai/mcp-server";
import * as auditModule from "@/lib/authz/audit";
import * as augmentModule from "@/lib/authz/inventory-augment";
import * as extensionRegistryModule from "@/lib/extension-mcp-registry";

const OUTWARD = "example_outward_send";
const OTHER_OUTWARD = "example_outward_publish";
const PLAIN = "example_plain_read";
const NEVER_ADMITTED = ["agent_run_resume", "approvals_decide", "agent_creation_request_decide",
  "permissions_members_invite", "email_outreach_system_jobs_initial_send_run",
  "email_outreach_system_process_due_follow_ups"];
const REASON = "outward_effect_requires_recorded_decision";

const h = vi.hoisted(() => {
  class RunStepToolPolicyRefusal extends Error {
    constructor(readonly code: string) { super(code); this.name = "RunStepToolPolicyRefusal"; }
  }
  type Released = { artifactId: string; representationRevisionId: string };
  return {
    RunStepToolPolicyRefusal,
    decisions: new Map<string, { tools: Set<string>; consumed: boolean; released: Released[] }>(),
    consume: vi.fn(),
    handled: [] as string[],
  };
});

vi.mock("@/lib/mcp-server", async () => {
  const entry = (name: string, declaredOutward: unknown) => ({
    handler: async () => { h.handled.push(name); return { structuredContent: { sent: name } }; },
    planned: { name, registeredName: name, order: 0, declaredClass: undefined, declarationMalformed: false,
      declaredOutward, ownerPackage: "@cinatra-ai/host", resolvedVersion: "1.0.0", capabilityKey: null,
      dispatchTarget: { kind: "host", packageName: "@cinatra-ai/host", version: "1.0.0", name },
      identityFailure: null, reserved: false },
  });
  return {
    buildHostSelfPrimitiveHandlers: async () => new Map<string, unknown>([
      [OUTWARD, entry(OUTWARD, { subject: { artifactId: "postId", representationRevisionId: "revisionId" } })],
      [OTHER_OUTWARD, entry(OTHER_OUTWARD, { subject: null })],
      [PLAIN, entry(PLAIN, null)],
      ...["agent_run_resume", "approvals_decide", "agent_creation_request_decide", "permissions_members_invite",
        "email_outreach_system_jobs_initial_send_run", "email_outreach_system_process_due_follow_ups"]
        .map((n) => [n, entry(n, null)] as [string, unknown]),
    ]),
  };
});
vi.mock("@cinatra-ai/agents/store", () => ({
  readCurrentRunStepToolPolicy: async () => ({ source: "bound-source-under-test" }),
  assertRunStepToolAllowed: () => ({ kind: "declared" }),
  RunStepToolPolicyRefusal: h.RunStepToolPolicyRefusal,
  consumeRunActionDecision: (...args: unknown[]) => h.consume(...args),
}));

import { callHostPrimitive, __resetHostSelfPrimitiveHandlers } from "@/lib/extension-self-mcp";

const source = (stepId = "step-1") => ({
  contextId: "ctx-1", stepId, executionAttemptId: "attempt-1",
  sourceSha256: "a".repeat(64), executedSourceSha256: "b".repeat(64), declarationSourceSha256: "c".repeat(64),
});
const runFrame = (over: Partial<Record<string, unknown>> = {}): McpRequestContext =>
  ({ orgId: "org-1", userId: "user-1", runId: "run-1", verifiedStepId: "step-1", verifiedExecutedSource: source(),
    orgWriteAuthority: { orgId: "org-1", lease: "run-lease" }, ...over }) as McpRequestContext;
const POST = { postId: "post-1", revisionId: "revision-A" };
const inner = (name: string, frame: McpRequestContext = runFrame(), args: unknown = POST) =>
  mcpRequestContextStorage.run(frame, () => callHostPrimitive(name, args));
const refusal = async (p: Promise<unknown>) => String((await p.then(() => null, (e: unknown) => e) as Error)?.message);

beforeEach(() => {
  __resetHostSelfPrimitiveHandlers();
  h.handled.length = 0;
  h.decisions.clear();
  h.decisions.set("run-1|step-1", { tools: new Set([OUTWARD, ...NEVER_ADMITTED]), consumed: false,
    released: [{ artifactId: "post-1", representationRevisionId: "revision-A" }] });
  h.consume.mockReset().mockImplementation(async (input: {
    runId: string; proof: { stepId: string }; action: { toolName: string };
    subject?: { artifactId: string; representationRevisionId: string } | null;
  }) => {
    const decision = h.decisions.get(`${input.runId}|${input.proof.stepId}`);
    if (!decision) throw new h.RunStepToolPolicyRefusal("action_person_decision_missing");
    if (!decision.tools.has(input.action.toolName)) throw new h.RunStepToolPolicyRefusal("step_tool_not_declared");
    if (input.subject && !decision.released.some((r) => r.artifactId === input.subject!.artifactId &&
        r.representationRevisionId === input.subject!.representationRevisionId)) {
      throw new h.RunStepToolPolicyRefusal("action_subject_not_released");
    }
    if (decision.consumed) throw new h.RunStepToolPolicyRefusal("action_person_decision_already_consumed");
    decision.consumed = true;
    return Object.freeze({ consumptionKey: "publish_decision:d-1", decisionId: "d-1", decidedBy: "person-1",
      stepId: input.proof.stepId, action: input.action });
  });
  const realLookup = augmentModule.lookupPrimitiveClassification;
  vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined);
  vi.spyOn(augmentModule, "lookupPrimitiveClassification").mockImplementation((name: string) =>
    name === OUTWARD || name === OTHER_OUTWARD || name === PLAIN || NEVER_ADMITTED.includes(name)
      ? { resourceType: "agent_run", action: "execute", status: "enforced" } : realLookup(name));
  vi.spyOn(extensionRegistryModule, "getEffectiveExtensionMcpTool").mockReturnValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => {
  __resetHostSelfPrimitiveHandlers();
  vi.doUnmock("@/lib/mcp-server");
  vi.doUnmock("@cinatra-ai/agents/store");
  vi.resetModules();
});

describe("an inner outward call of a run takes the guarded outward run action", () => {
  it("is let through exactly once on the consumed decision for its run, step, tool and released item", async () => {
    expect(await inner(OUTWARD)).toEqual({ sent: OUTWARD });
    expect(h.handled).toEqual([OUTWARD]);
    expect(h.consume).toHaveBeenCalledTimes(1);
    expect(h.consume.mock.calls[0]![0]).toMatchObject({ runId: "run-1", proof: source(),
      action: { toolName: OUTWARD, packageName: "@cinatra-ai/host", installId: "host-builtin" },
      subject: { artifactId: "post-1", representationRevisionId: "revision-A" } });
  });

  it("refuses a second use of the same decision", async () => {
    await inner(OUTWARD);
    expect(await refusal(inner(OUTWARD))).toContain(`${REASON}:action_person_decision_already_consumed`);
    expect(h.handled).toEqual([OUTWARD]);
  });

  it("refuses with no decision, and the refusal keeps the recorded-decision reason", async () => {
    h.decisions.clear();
    const message = await refusal(inner(OUTWARD));
    expect(message).toContain(`authorization denied for "${OUTWARD}": ${REASON}`);
    expect(h.handled).toEqual([]);
  });

  it("refuses for another run, another step, another tool and an item the person did not release", async () => {
    expect(await refusal(inner(OUTWARD, runFrame({ runId: "run-2" })))).toContain(`${REASON}:action_person_decision_missing`);
    expect(await refusal(inner(OUTWARD, runFrame({ verifiedStepId: "step-2", verifiedExecutedSource: source("step-2") }))))
      .toContain(`${REASON}:action_person_decision_missing`);
    expect(await refusal(inner(OTHER_OUTWARD))).toContain(`${REASON}:step_tool_not_declared`);
    expect(await refusal(inner(OUTWARD, runFrame(), { postId: "post-2", revisionId: "revision-A" })))
      .toContain(`${REASON}:action_subject_not_released`);
    expect(h.handled).toEqual([]);
    expect(h.decisions.get("run-1|step-1")!.consumed).toBe(false);
  });

  it("fails closed on a frame without actor, write authority or step proof, consuming nothing", async () => {
    expect(await refusal(inner(OUTWARD, runFrame({ userId: undefined })))).toContain("not_org_member");
    expect(await refusal(inner(OUTWARD, runFrame({ orgWriteAuthority: undefined }))))
      .toContain(`${REASON}:action_write_authority_missing`);
    expect(await refusal(inner(OUTWARD, runFrame({ verifiedStepId: undefined })))).toContain("action_executed_source_missing_or_stale");
    expect(await refusal(inner(OUTWARD, runFrame(), { postId: "post-1" }))).toContain(`${REASON}:action_subject_missing`);
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.handled).toEqual([]);
  });

  it("keeps the never-admitted tools refused even with a decision that names them", async () => {
    for (const name of NEVER_ADMITTED) {
      const message = await refusal(inner(name, runFrame(), {}));
      expect(message).toContain(`authorization denied for "${name}": ${REASON}`);
      expect(message).not.toContain(`${REASON}:`);
    }
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.handled).toEqual([]);
  });

  it("refuses an unknown tool and leaves a plain tool's inner call untouched", async () => {
    expect(await refusal(inner("example_unknown_tool"))).toContain("no host primitive is registered");
    expect(await inner(PLAIN)).toEqual({ sent: PLAIN });
    expect(h.consume).not.toHaveBeenCalled();
  });
});
