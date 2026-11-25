/**
 * The guarded outward run action (cinatra#3745).
 *
 * A tool that sends or publishes on a person's behalf, called through the
 * runtime server on an agent run's frame, is admitted for exactly one call:
 * the frame's step proof is taken, the tool's owner passes the loaded-identity
 * check, the person's recorded decision for this run, step and tool is consumed
 * before the effect, and only then does `enforceMcpBoundary` admit the call.
 * Every other outward call stays refused, and a refusal never carries store
 * text.
 *
 * These cases drive the real `createMcpRuntimeServer` choke point, the real
 * capability plan, the real `enforceMcpBoundary`, the real guarded action of
 * `@/lib/extension-host-context` and the real loaded-identity registry. The
 * audit writer, the classification reader and the extension-registry reader
 * are test doubles, as is the run store: its consumption double keeps one
 * released decision per (run, step) for the tools that step declares, with the
 * items and revisions the decision released, and refuses as the real store does
 * (its own refusals, its comparison of the call's subject with the released
 * items and its single-use fence are pinned in packages/agents).
 */
import "server-only";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as auditModule from "@/lib/authz/audit";
import * as augmentModule from "@/lib/authz/inventory-augment";
import * as extensionRegistryModule from "@/lib/extension-mcp-registry";
import { enforceMcpBoundary } from "@/lib/authz/mcp-boundary";
import {
  __resetCapabilityRegistry,
  recordLoadedExtensionIdentity,
  retireLoadedExtensionIdentity,
} from "@/lib/extension-capabilities-registry";
import { createMcpRuntimeServer } from "../../../packages/mcp-server/src/runtime-server";
import {
  mcpRequestContextStorage,
  type McpRequestContext,
} from "../../../packages/mcp-server/src/request-context";

const store = vi.hoisted(() => {
  class RunStepToolPolicyRefusal extends Error {
    constructor(readonly code: string) { super(code); this.name = "RunStepToolPolicyRefusal"; }
  }
  type Released = { artifactId: string; representationRevisionId: string };
  type Decision = { tools: Set<string>; consumed: boolean; released: Released[] };
  return {
    RunStepToolPolicyRefusal,
    decisions: new Map<string, Decision>(),
    fail: null as Error | null,
    consume: vi.fn(),
  };
});
vi.mock("@cinatra-ai/agents/store", () => ({
  readCurrentRunStepToolPolicy: async () => ({ source: "bound-source-under-test" }),
  assertRunStepToolAllowed: () => ({ kind: "declared" }),
  RunStepToolPolicyRefusal: store.RunStepToolPolicyRefusal,
  consumeRunActionDecision: (...args: unknown[]) => store.consume(...args),
}));

const OUTWARD = "example_outward_send";
const OTHER_OUTWARD = "example_outward_publish";
const PACKAGE = "@acme/outreach";
const VERSION = "1.2.3";
const FIXTURE_CLASSIFICATION = { resourceType: "agent_run", action: "execute", status: "enforced" } as const;
const REASON = "outward_effect_requires_recorded_decision";

const source = (stepId = "step-1") => ({
  contextId: "ctx-1", stepId, executionAttemptId: "attempt-1",
  sourceSha256: "a".repeat(64), executedSourceSha256: "b".repeat(64), declarationSourceSha256: "c".repeat(64),
});
const AUTHORITY = { orgId: "org-1", lease: "run-lease" };
const runFrame = (over: Partial<Record<string, unknown>> = {}): McpRequestContext =>
  ({
    orgId: "org-1", userId: "user-1", runId: "run-1",
    verifiedStepId: "step-1", verifiedExecutedSource: source(), orgWriteAuthority: AUTHORITY,
    ...over,
  }) as McpRequestContext;

type ToolResult = { content?: Array<{ type?: string; text?: string }>; isError?: boolean };

/** One runtime server with the two outward tools; `owner` stamps an extension owner (absent: a host built-in). */
async function buildServer(owner?: { packageName: string; version: string },
  subject?: { artifactId: string; representationRevisionId: string }) {
  const handled: string[] = [];
  const config = (name: string) => ({
    title: name, description: name, outward: subject ? { subject } : {},
    ...(owner ? { cinatraPrimitive: { ownerPackage: owner.packageName, resolvedVersion: owner.version,
      dispatchTarget: { kind: "extension-default", packageName: owner.packageName, version: owner.version, name } } } : {}),
  });
  const runtime = await createMcpRuntimeServer({
    name: "guarded-outward-test",
    version: "0.0.0",
    registerCapabilities: (toolServer) => {
      for (const name of [OUTWARD, OTHER_OUTWARD]) {
        (toolServer.registerTool as unknown as (n: string, c: unknown, h: (...a: unknown[]) => unknown) => unknown)(
          name, config(name), async () => {
            handled.push(name);
            return { content: [{ type: "text", text: "sent" }] };
          });
      }
    },
  });
  const registry = (runtime as unknown as {
    _registeredTools: Record<string, { handler: (...a: unknown[]) => unknown }>;
  })._registeredTools;
  return {
    handled,
    call: async (name: string, frame: McpRequestContext, args: unknown = {}): Promise<ToolResult> =>
      (await mcpRequestContextStorage.run(frame, () => registry[name]!.handler(args, {}))) as ToolResult,
  };
}

describe("the guarded outward run action", () => {
  let auditSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetCapabilityRegistry();
    store.decisions.clear();
    store.decisions.set("run-1|step-1", { tools: new Set([OUTWARD]), consumed: false,
      released: [{ artifactId: "post-1", representationRevisionId: "revision-A" }] });
    store.fail = null;
    store.consume.mockReset().mockImplementation(async (input: {
      orgId: string; runId: string; authority: unknown;
      proof: { stepId: string }; action: { toolName: string };
      subject?: { artifactId: string; representationRevisionId: string } | null;
    }) => {
      if (store.fail) throw store.fail;
      if (!input.authority) throw new store.RunStepToolPolicyRefusal("action_decision_input_invalid");
      const decision = store.decisions.get(`${input.runId}|${input.proof.stepId}`);
      if (!decision) throw new store.RunStepToolPolicyRefusal("action_person_decision_missing");
      if (!decision.tools.has(input.action.toolName)) throw new store.RunStepToolPolicyRefusal("step_tool_not_declared");
      if (input.subject && !decision.released.some((r) => r.artifactId === input.subject!.artifactId &&
          r.representationRevisionId === input.subject!.representationRevisionId)) {
        throw new store.RunStepToolPolicyRefusal("action_subject_not_released");
      }
      if (decision.consumed) throw new store.RunStepToolPolicyRefusal("action_person_decision_already_consumed");
      decision.consumed = true;
      return Object.freeze({ consumptionKey: "publish_decision:d-1", decisionId: "d-1", decidedBy: "person-1",
        stepId: input.proof.stepId, action: input.action });
    });
    const realLookup = augmentModule.lookupPrimitiveClassification;
    auditSpy = vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined);
    vi.spyOn(augmentModule, "lookupPrimitiveClassification").mockImplementation((name: string) =>
      name === OUTWARD || name === OTHER_OUTWARD ? { ...FIXTURE_CLASSIFICATION } : realLookup(name));
    vi.spyOn(extensionRegistryModule, "getEffectiveExtensionMcpTool").mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetCapabilityRegistry();
  });

  // Before the change every outward call on a run frame is refused, so the handler never runs:
  // red-first-expect: expected true to be falsy
  it("admits exactly one call of a host built-in outward tool after consuming the person's decision", async () => {
    const server = await buildServer();
    const result = await server.call(OUTWARD, runFrame());
    expect(result.isError).toBeFalsy();
    expect(server.handled).toEqual([OUTWARD]);
    expect(store.consume).toHaveBeenCalledTimes(1);
    const input = store.consume.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({ orgId: "org-1", runId: "run-1", authority: AUTHORITY, proof: source() });
    expect(input.action).toEqual({ toolName: OUTWARD, packageName: "@cinatra-ai/host", version: expect.any(String),
      installId: "host-builtin", digest: "host-builtin" });
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ operation: OUTWARD, decision: "allowed",
      metadata: expect.objectContaining({ via: "recorded_decision", consumptionKey: "publish_decision:d-1" }) }));
  });

  // Before the change the refusal names no consumption, so the reason has no refusal code:
  // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
  it("refuses a second call with the same decision, and the handler runs once", async () => {
    const server = await buildServer();
    await server.call(OUTWARD, runFrame());
    const second = await server.call(OUTWARD, runFrame());
    expect(second.isError).toBe(true);
    expect(second.content?.[0]?.text).toContain(`${REASON}:action_person_decision_already_consumed`);
    expect(server.handled).toEqual([OUTWARD]);
  });

  // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
  it("refuses a call with no decision for its step", async () => {
    store.decisions.clear();
    const server = await buildServer();
    const result = await server.call(OUTWARD, runFrame());
    expect(result.content?.[0]?.text).toContain(`${REASON}:action_person_decision_missing`);
    expect(server.handled).toEqual([]);
  });

  // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
  it("refuses a call from another step, whose own decision does not exist", async () => {
    const server = await buildServer();
    const result = await server.call(OUTWARD, runFrame({ verifiedStepId: "step-2", verifiedExecutedSource: source("step-2") }));
    expect(result.content?.[0]?.text).toContain(`${REASON}:action_person_decision_missing`);
    expect(server.handled).toEqual([]);
    expect(store.decisions.get("run-1|step-1")!.consumed).toBe(false);
  });

  // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
  it("refuses another tool than the one the step's decision covers, and uses nothing up", async () => {
    const server = await buildServer();
    const result = await server.call(OTHER_OUTWARD, runFrame());
    expect(result.content?.[0]?.text).toContain(`${REASON}:step_tool_not_declared`);
    expect(server.handled).toEqual([]);
    expect(store.decisions.get("run-1|step-1")!.consumed).toBe(false);
  });

  // The wrapper's argument preparation refuses this frame first; the boundary refuses it again on its own.
  // red-first-expect: expected { allowed: false, …(2) } to deeply equal { allowed: false, …(2) }
  it("refuses, at the boundary itself, a frame whose step is not the proof's step, before any consumption", async () => {
    const decision = await enforceMcpBoundary({
      primitiveName: OUTWARD, ctx: runFrame({ verifiedExecutedSource: source("step-2") }), delegatedRestricted: false,
      declaresOutward: true, outwardOwner: { kind: "host", packageName: "@cinatra-ai/host", version: "1.0.0" },
    } as Parameters<typeof enforceMcpBoundary>[0]);
    expect(decision).toEqual({ allowed: false, shouldBlock: true,
      reason: `${REASON}:action_executed_source_missing_or_stale` });
    expect(store.consume).not.toHaveBeenCalled();
  });

  // red-first-expect: expected { allowed: false, …(2) } to deeply equal { allowed: false, …(2) }
  it("refuses an outward run call whose planned owner identity failed", async () => {
    const decision = await enforceMcpBoundary({ primitiveName: OUTWARD, ctx: runFrame(), delegatedRestricted: false,
      declaresOutward: true, outwardOwner: null } as Parameters<typeof enforceMcpBoundary>[0]);
    expect(decision).toEqual({ allowed: false, shouldBlock: true, reason: `${REASON}:action_owner_unresolved` });
    expect(store.consume).not.toHaveBeenCalled();
  });

  // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
  it("refuses a frame without the run's write authority, before any consumption", async () => {
    const server = await buildServer();
    const result = await server.call(OUTWARD, runFrame({ orgWriteAuthority: undefined }));
    expect(result.content?.[0]?.text).toContain(`${REASON}:action_write_authority_missing`);
    expect(store.consume).not.toHaveBeenCalled();
  });

  // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
  it("fails closed on a store failure with a fixed code and never the store's text", async () => {
    store.fail = new Error("connect ECONNREFUSED db-internal:5432 password=hunter2");
    const server = await buildServer();
    const result = await server.call(OUTWARD, runFrame());
    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain(`${REASON}:action_person_decision_unavailable`);
    expect(text).not.toMatch(/ECONNREFUSED|db-internal|hunter2/);
    expect(JSON.stringify(auditSpy.mock.calls)).not.toMatch(/ECONNREFUSED|db-internal|hunter2/);
    expect(server.handled).toEqual([]);
  });

  // red-first-expect: to contain 'not_org_member'
  it("uses no decision up when another boundary rule refuses the call", async () => {
    const server = await buildServer();
    const result = await server.call(OUTWARD, runFrame({ userId: undefined }));
    expect(result.content?.[0]?.text).toContain("not_org_member");
    expect(store.consume).not.toHaveBeenCalled();
    expect(server.handled).toEqual([]);
  });

  describe("an extension-owned outward tool", () => {
    // Before the change the loaded identity is not consulted and every outward run call is refused:
    // red-first-expect: expected true to be falsy
    it("is admitted once under the owner's current loaded identity", async () => {
      recordLoadedExtensionIdentity({ packageName: PACKAGE, version: VERSION, installId: "install-9", digest: "sha256:abc" });
      const server = await buildServer({ packageName: PACKAGE, version: VERSION });
      const result = await server.call(OUTWARD, runFrame());
      expect(result.isError).toBeFalsy();
      expect(server.handled).toEqual([OUTWARD]);
      expect((store.consume.mock.calls[0]![0] as { action: unknown }).action).toEqual({
        toolName: OUTWARD, packageName: PACKAGE, version: VERSION, installId: "install-9", digest: "sha256:abc" });
    });

    // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
    it("is refused when its owner has no loaded identity (a dev, legacy or bundled load)", async () => {
      const server = await buildServer({ packageName: PACKAGE, version: VERSION });
      const result = await server.call(OUTWARD, runFrame());
      expect(result.content?.[0]?.text).toContain(`${REASON}:action_loaded_identity_missing_or_stale`);
      expect(store.consume).not.toHaveBeenCalled();
    });

    // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
    it("is refused when its owner's loaded identity was retired", async () => {
      recordLoadedExtensionIdentity({ packageName: PACKAGE, version: VERSION, installId: "install-9", digest: "sha256:abc" });
      retireLoadedExtensionIdentity(PACKAGE, VERSION);
      const server = await buildServer({ packageName: PACKAGE, version: VERSION });
      const result = await server.call(OUTWARD, runFrame());
      expect(result.content?.[0]?.text).toContain(`${REASON}:action_loaded_identity_missing_or_stale`);
      expect(store.consume).not.toHaveBeenCalled();
      expect(server.handled).toEqual([]);
    });

    // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
    it("is refused when its owner's loaded identity is replaced between the check and the consumption", async () => {
      recordLoadedExtensionIdentity({ packageName: PACKAGE, version: VERSION, installId: "install-9", digest: "sha256:abc" });
      // The boundary's other rules run between the two steps; a new install is stamped while they run.
      vi.mocked(augmentModule.lookupPrimitiveClassification).mockImplementation((name: string) => {
        if (name === OUTWARD) {
          recordLoadedExtensionIdentity({ packageName: PACKAGE, version: VERSION, installId: "install-10", digest: "sha256:def" });
          return { ...FIXTURE_CLASSIFICATION };
        }
        return undefined;
      });
      const server = await buildServer({ packageName: PACKAGE, version: VERSION });
      const result = await server.call(OUTWARD, runFrame());
      expect(result.content?.[0]?.text).toContain(`${REASON}:action_loaded_identity_stale`);
      expect(store.consume).not.toHaveBeenCalled();
      expect(server.handled).toEqual([]);
    });
  });
  // cinatra#3745: a released decision is used only for the item and revision it released. The tool's declared subject
  // names the input fields that carry them; the boundary reads them from the call and hands them to the consumption.
  describe("a tool that declares a subject", () => {
    const FIELDS = { artifactId: "postId", representationRevisionId: "postRevision" };

    // red-first-expect: expected true to be falsy
    it("is admitted once for the released item and revision, which the consumption receives", async () => {
      const server = await buildServer(undefined, FIELDS);
      const result = await server.call(OUTWARD, runFrame(), { postId: "post-1", postRevision: "revision-A", body: "x" });
      expect(result.isError).toBeFalsy();
      expect(server.handled).toEqual([OUTWARD]);
      expect((store.consume.mock.calls[0]![0] as { subject?: unknown }).subject)
        .toEqual({ artifactId: "post-1", representationRevisionId: "revision-A" });
    });

    // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
    it("is refused for another revision of the released item, and the decision stays unused", async () => {
      const server = await buildServer(undefined, FIELDS);
      const result = await server.call(OUTWARD, runFrame(), { postId: "post-1", postRevision: "revision-B" });
      expect(result.content?.[0]?.text).toContain(`${REASON}:action_subject_not_released`);
      expect(server.handled).toEqual([]);
      expect(store.decisions.get("run-1|step-1")!.consumed).toBe(false);
      // The released revision is still admitted afterwards: the refusal used nothing up.
      const admitted = await server.call(OUTWARD, runFrame(), { postId: "post-1", postRevision: "revision-A" });
      expect(admitted.isError).toBeFalsy();
    });

    // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
    it("is refused, before any consumption, when the call omits the item or the revision", async () => {
      const server = await buildServer(undefined, FIELDS);
      for (const args of [{ postId: "post-1" }, { postRevision: "revision-A" }, {}]) {
        const result = await server.call(OUTWARD, runFrame(), args);
        expect(result.content?.[0]?.text).toContain(`${REASON}:action_subject_missing`);
      }
      expect(store.consume).not.toHaveBeenCalled();
      expect(server.handled).toEqual([]);
    });

    // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
    it("is refused, before any consumption, when the item or the revision is not a string", async () => {
      const server = await buildServer(undefined, FIELDS);
      for (const args of [{ postId: 7, postRevision: "revision-A" }, { postId: "post-1", postRevision: ["revision-A"] },
        { postId: "", postRevision: "revision-A" }]) {
        const result = await server.call(OUTWARD, runFrame(), args);
        expect(result.content?.[0]?.text).toContain(`${REASON}:action_subject_invalid`);
      }
      expect(store.consume).not.toHaveBeenCalled();
      expect(server.handled).toEqual([]);
    });

    it("a tool without a subject hands the consumption no subject (it is bound to the decision only)", async () => {
      const server = await buildServer();
      await server.call(OUTWARD, runFrame(), { postId: "post-9", postRevision: "revision-Z" });
      expect((store.consume.mock.calls[0]![0] as { subject?: unknown }).subject ?? null).toBeNull();
      expect(server.handled).toEqual([OUTWARD]);
    });
  });
});
