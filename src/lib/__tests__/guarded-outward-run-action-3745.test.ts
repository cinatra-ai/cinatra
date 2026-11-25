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
import * as registryModule from "@/lib/extension-capabilities-registry";
import {
  __resetCapabilityRegistry,
  recordLoadedExtensionIdentity,
  retireLoadedExtensionIdentity,
} from "@/lib/extension-capabilities-registry";
import { createExtensionHostContext } from "@/lib/extension-host-context";
import { loadRuntimePackageExtensions } from "@/lib/runtime-package-loader";
import {
  dispatchExtensionMcpToolEdgeBound,
  dispatchPlannedExtensionMcpTool,
  dispatchVersionedOnlyExtensionMcpTool,
  wrapExtensionToolResult,
} from "@/lib/extension-edge-bound-serving";
import {
  beginVersionKeyedRegistration,
  resolveVersionKeyedMcpTool,
  __resetVersionKeyedServingForTests,
} from "@/lib/extension-version-keyed-serving";
import { withActorContext } from "@cinatra-ai/llm/actor-context";
import { callHostPrimitive, __resetHostSelfPrimitiveHandlers } from "@/lib/extension-self-mcp";
import type { CapturedHostPrimitive } from "@/lib/extension-mcp-registry";
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
// The host's in-process primitive map (the self-invoker's), captured per case through the real recording server.
const selfInvoker = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }));
vi.mock("@/lib/mcp-server", () => ({ buildHostSelfPrimitiveHandlers: async () => selfInvoker.handlers }));

// The install rows the edge-bound resolution reads (the real resolution runs; only its row store is in memory).
const installs = vi.hoisted(() => ({ rows: new Map<string, unknown>() }));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionById: async (id: string) => installs.rows.get(id) ?? null,
  readInstalledExtensionsByPackageName: async () => [],
  listInstalledExtensions: async () => [],
}));

// The runtime loader's SDK driver, as a fake that emits the real sequence (makeContext, the register settle, then the
// bootstrap results), and the loader's store, trust and migration reads. Absent a fake driver, the real one runs.
const activation = vi.hoisted(() => ({
  drive: null as null | ((root: string, deps: Record<string, unknown>) => Promise<unknown[]>),
  records: [] as unknown[],
}));
vi.mock(import("@cinatra-ai/sdk-extensions"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runRuntimePackageActivation: ((root: string, deps: Record<string, unknown>) =>
      activation.drive ? activation.drive(root, deps)
        : (actual.runRuntimePackageActivation as (...a: unknown[]) => unknown)(root, deps)) as never,
    recordDeclaresHostMigrations: ((...a: unknown[]) =>
      activation.drive ? false : (actual.recordDeclaresHostMigrations as (...b: unknown[]) => boolean)(...a)) as never,
  };
});
vi.mock(import("@/lib/extension-store-io"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, discoverStoreRecordsV2: (async () => activation.records) as never };
});
vi.mock(import("@/lib/extension-signature"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveSignatureVerdict: () => undefined, signaturesRequired: () => false };
});
vi.mock(import("@/lib/extension-trust"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, classifyExtensionTrust: (() => ({ trusted: true, tier: "trusted-bootstrap", reason: "ok" })) as never };
});
vi.mock(import("@/lib/extension-migration-host"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    applyMigrationsForTrustedRecords: (async () => ({ applied: [], refused: [] })) as never,
    applyMigrationUnionForTrustedRecords: (async () => ({ applied: [], refused: [] })) as never,
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
async function buildServer(owner?: { packageName: string; version: string; loadedIdentity?: object },
  subject?: { artifactId: string; representationRevisionId: string }) {
  const handled: string[] = [];
  const config = (name: string) => ({
    title: name, description: name, outward: subject ? { subject } : {},
    ...(owner ? { cinatraPrimitive: { ownerPackage: owner.packageName, resolvedVersion: owner.version,
      dispatchTarget: { kind: "extension-default", packageName: owner.packageName, version: owner.version, name,
        ...(owner.loadedIdentity ? { loadedIdentity: owner.loadedIdentity } : {}) } } } : {}),
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
      const loadedIdentity = recordLoadedExtensionIdentity({ packageName: PACKAGE, version: VERSION,
        installId: "install-9", digest: "sha256:abc" });
      const server = await buildServer({ packageName: PACKAGE, version: VERSION, loadedIdentity });
      const result = await server.call(OUTWARD, runFrame());
      expect(result.isError).toBeFalsy();
      expect(server.handled).toEqual([OUTWARD]);
      expect((store.consume.mock.calls[0]![0] as { action: unknown }).action).toEqual({
        toolName: OUTWARD, packageName: PACKAGE, version: VERSION, installId: "install-9", digest: "sha256:abc" });
    });

    // The registration carries no identity, though another load of the same version has a current one: it is never
    // looked up again by package and version.
    it("is refused when its registration carries no loaded identity (a dev or legacy load)", async () => {
      recordLoadedExtensionIdentity({ packageName: PACKAGE, version: VERSION, installId: "install-9", digest: "sha256:abc" });
      const server = await buildServer({ packageName: PACKAGE, version: VERSION });
      const result = await server.call(OUTWARD, runFrame());
      expect(result.content?.[0]?.text).toContain(`${REASON}:action_loaded_identity_missing_or_stale`);
      expect(store.consume).not.toHaveBeenCalled();
    });

    // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
    it("is refused when its owner's loaded identity was retired", async () => {
      const loadedIdentity = recordLoadedExtensionIdentity({ packageName: PACKAGE, version: VERSION,
        installId: "install-9", digest: "sha256:abc" });
      retireLoadedExtensionIdentity(PACKAGE, VERSION);
      const server = await buildServer({ packageName: PACKAGE, version: VERSION, loadedIdentity });
      const result = await server.call(OUTWARD, runFrame());
      expect(result.content?.[0]?.text).toContain(`${REASON}:action_loaded_identity_stale`);
      expect(store.consume).not.toHaveBeenCalled();
      expect(server.handled).toEqual([]);
    });

    // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
    it("is refused when its owner's loaded identity is replaced between the check and the consumption", async () => {
      const loadedIdentity = recordLoadedExtensionIdentity({ packageName: PACKAGE, version: VERSION,
        installId: "install-9", digest: "sha256:abc" });
      // The boundary's other rules run between the two steps; a new install is stamped while they run.
      vi.mocked(augmentModule.lookupPrimitiveClassification).mockImplementation((name: string) => {
        if (name === OUTWARD) {
          recordLoadedExtensionIdentity({ packageName: PACKAGE, version: VERSION, installId: "install-10", digest: "sha256:def" });
          return { ...FIXTURE_CLASSIFICATION };
        }
        return undefined;
      });
      const server = await buildServer({ packageName: PACKAGE, version: VERSION, loadedIdentity });
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
  // cinatra#3745: a step entered twice in one attempt has one decision per visit and signs the same proof on both. The
  // frame carries the decision of its own visit (`verifiedPublishDecisionId`, verified from the token beside the proof)
  // and the guarded action hands it to the consumption unchanged. The consumption double here keeps the visits of the
  // step and answers as the real consumption does for a call with and without that id (the rule itself is pinned
  // through the real function in packages/agents).
  describe("the decision of the call's own visit", () => {
    type Visit = { id: string; stepId: string; consumed: boolean };
    let visits: Visit[];
    beforeEach(() => {
      visits = [{ id: "decision-1", stepId: "step-1", consumed: false }];
      store.consume.mockReset().mockImplementation(async (input: {
        runId: string; proof: { stepId: string }; action: { toolName: string }; publishDecisionId?: string;
      }) => {
        const own = visits.filter((v) => v.stepId === input.proof.stepId);
        let visit: Visit | undefined;
        if (input.publishDecisionId !== undefined) {
          visit = own.find((v) => v.id === input.publishDecisionId);
          if (!visit) throw new store.RunStepToolPolicyRefusal("action_decision_binding_mismatch");
        } else {
          if (own.length === 0) throw new store.RunStepToolPolicyRefusal("action_person_decision_missing");
          if (own.length > 1) throw new store.RunStepToolPolicyRefusal("action_decision_binding_missing");
          visit = own[0]!;
        }
        if (visit.consumed) throw new store.RunStepToolPolicyRefusal("action_person_decision_already_consumed");
        visit.consumed = true;
        return Object.freeze({ consumptionKey: `publish_decision:${visit.id}`, decisionId: visit.id, decidedBy: "person-1",
          stepId: input.proof.stepId, action: input.action });
      });
    });
    const visitFrame = (publishDecisionId?: string, stepId = "step-1") => runFrame({
      verifiedStepId: stepId, verifiedExecutedSource: source(stepId),
      ...(publishDecisionId === undefined ? {} : { verifiedPublishDecisionId: publishDecisionId }),
    });

    // Before the change the consumption gets no decision id, so with two visits the delayed call is refused as unbound:
    // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
    it("a delayed first-visit call after the second release never uses the second visit's decision", async () => {
      const server = await buildServer();
      expect((await server.call(OUTWARD, visitFrame("decision-1"))).isError).toBeFalsy();
      visits.push({ id: "decision-2", stepId: "step-1", consumed: false });
      const delayed = await server.call(OUTWARD, visitFrame("decision-1"));
      expect(delayed.content?.[0]?.text).toContain(`${REASON}:action_person_decision_already_consumed`);
      expect(visits.find((v) => v.id === "decision-2")!.consumed).toBe(false);
      expect(server.handled).toEqual([OUTWARD]);
      expect((store.consume.mock.calls[0]![0] as { publishDecisionId?: unknown }).publishDecisionId).toBe("decision-1");
    });

    // red-first-expect: expected true to be falsy
    it("the second visit's own call is served once", async () => {
      visits.push({ id: "decision-2", stepId: "step-1", consumed: false });
      const server = await buildServer();
      expect((await server.call(OUTWARD, visitFrame("decision-2"))).isError).toBeFalsy();
      const again = await server.call(OUTWARD, visitFrame("decision-2"));
      expect(again.content?.[0]?.text).toContain(`${REASON}:action_person_decision_already_consumed`);
      expect(visits.map((v) => v.consumed)).toEqual([false, true]);
      expect(server.handled).toEqual([OUTWARD]);
    });

    // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
    it("refuses a verified decision of another step, and uses nothing up", async () => {
      visits.push({ id: "decision-other-step", stepId: "step-2", consumed: false });
      const server = await buildServer();
      const result = await server.call(OUTWARD, visitFrame("decision-other-step"));
      expect(result.content?.[0]?.text).toContain(`${REASON}:action_decision_binding_mismatch`);
      expect(visits.every((v) => !v.consumed)).toBe(true);
      expect(server.handled).toEqual([]);
    });

    it("serves a call with no verified decision when the step has exactly one decision", async () => {
      const server = await buildServer();
      expect((await server.call(OUTWARD, visitFrame())).isError).toBeFalsy();
      expect((store.consume.mock.calls[0]![0] as { publishDecisionId?: unknown }).publishDecisionId).toBeUndefined();
      expect(server.handled).toEqual([OUTWARD]);
    });

    it("hands a malformed frame value to the consumption unchanged, never as an absent one", async () => {
      const server = await buildServer();
      await server.call(OUTWARD, runFrame({ verifiedPublishDecisionId: 7 }));
      expect((store.consume.mock.calls[0]![0] as { publishDecisionId?: unknown }).publishDecisionId).toBe(7);
    });
  });

  // cinatra#3745: the identity checked, recorded and re-checked is the identity of the handler that will run: the loaded
  // identity the registry keeps beside that handler (stamped by the load attempt whose ctx registered it), read off the
  // same captured entry the dispatch invokes, never looked up again by package and version.
  describe("the identity of the handler that runs", () => {
    /** One load attempt of PACKAGE@VERSION: the loader stamps its identity, and the attempt's ctx registers OUTWARD. */
    function loadAttempt(installId: string, digest: string, ran: string[], stamp = true) {
      const loadedIdentity = recordLoadedExtensionIdentity({ packageName: PACKAGE, version: VERSION, installId, digest });
      const ctx = createExtensionHostContext(PACKAGE, ["mcp"], {}, { installId, version: VERSION, isDefault: true,
        ...(stamp ? { loadedIdentity } : {}) });
      ctx.mcp.registerTool({ name: OUTWARD, description: OUTWARD, outward: {},
        // A registration that names an identity itself is ignored: the host writes the field.
        ...(stamp ? {} : { loadedIdentity }),
        handler: async () => { ran.push(installId); return { sent: installId }; } } as Parameters<typeof ctx.mcp.registerTool>[0]);
    }

    /** The per-request server the replay builds: the registry entry captured now, with its handler and its stamp. */
    async function replayServer() {
      const tool = extensionRegistryModule.listExtensionMcpTools().find((t) => t.name === OUTWARD);
      if (!tool) throw new Error(`"${OUTWARD}" is not registered`);
      const runtime = await createMcpRuntimeServer({
        name: "guarded-outward-replay-test",
        version: "0.0.0",
        registerCapabilities: (toolServer) => {
          (toolServer.registerTool as unknown as (n: string, c: unknown, h: (input: unknown) => unknown) => unknown)(
            OUTWARD,
            extensionRegistryModule.buildReplayedExtensionToolConfig(OUTWARD, tool, {
              ownerPackage: PACKAGE, resolvedVersion: tool.resolvedVersion,
              dispatchTarget: { kind: "extension-default", packageName: PACKAGE, version: VERSION, name: OUTWARD },
            }),
            async (input: unknown) => wrapExtensionToolResult(
              await dispatchPlannedExtensionMcpTool({ expected: "default", tool }, input)),
          );
        },
      });
      const registry = (runtime as unknown as {
        _registeredTools: Record<string, { handler: (...a: unknown[]) => unknown }>;
      })._registeredTools;
      return (frame: McpRequestContext): Promise<ToolResult> =>
        mcpRequestContextStorage.run(frame, () => registry[OUTWARD]!.handler({}, {})) as Promise<ToolResult>;
    }

    afterEach(() => {
      extensionRegistryModule.removeExtensionMcpToolsForPackage(PACKAGE);
    });

    it("records the install whose handler runs", async () => {
      const ran: string[] = [];
      loadAttempt("install-A", "sha256:aaa", ran);
      const call = await replayServer();
      expect((await call(runFrame())).isError).toBeFalsy();
      expect(ran).toEqual(["install-A"]);
      expect((store.consume.mock.calls[0]![0] as { action: unknown }).action).toEqual({
        toolName: OUTWARD, packageName: PACKAGE, version: VERSION, installId: "install-A", digest: "sha256:aaa" });
    });

    // Before the change the check looks the identity up by package and version, finds install B and runs A under it:
    // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
    it("refuses a call whose captured handler was replaced by a same-version hot update before admission", async () => {
      const ran: string[] = [];
      loadAttempt("install-A", "sha256:aaa", ran);
      const call = await replayServer();
      // A hot update of the same version stamps install B and registers its handler after A's was captured.
      loadAttempt("install-B", "sha256:bbb", ran);
      const result = await call(runFrame());
      expect(result.content?.[0]?.text).toContain(`${REASON}:action_loaded_identity_stale`);
      expect(store.consume).not.toHaveBeenCalled();
      expect(store.decisions.get("run-1|step-1")!.consumed).toBe(false);
      expect(ran).toEqual([]);
      expect(JSON.stringify(auditSpy.mock.calls)).not.toContain("install-B");
      // A request planned after the update runs B's handler under B's identity, with the unused decision.
      const next = await replayServer();
      expect((await next(runFrame())).isError).toBeFalsy();
      expect(ran).toEqual(["install-B"]);
      expect((store.consume.mock.calls[0]![0] as { action: { installId: string } }).action.installId).toBe("install-B");
    });

    // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
    it("refuses a registration whose ctx carried no stamp, whatever identity the tool names itself", async () => {
      const ran: string[] = [];
      loadAttempt("install-A", "sha256:aaa", ran, false);
      const result = await (await replayServer())(runFrame());
      expect(result.content?.[0]?.text).toContain(`${REASON}:action_loaded_identity_missing_or_stale`);
      expect(store.consume).not.toHaveBeenCalled();
      expect(ran).toEqual([]);
    });

    // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
    it("refuses an identity of another package or version than the planned owner", async () => {
      const loadedIdentity = recordLoadedExtensionIdentity({ packageName: PACKAGE, version: "9.9.9",
        installId: "install-9", digest: "sha256:abc" });
      const server = await buildServer({ packageName: PACKAGE, version: VERSION, loadedIdentity });
      const result = await server.call(OUTWARD, runFrame());
      expect(result.content?.[0]?.text).toContain(`${REASON}:action_loaded_identity_missing_or_stale`);
      expect(store.consume).not.toHaveBeenCalled();
    });

    // cinatra#3745: an extension's outward tool is callable only while the extension is fully activated. These cases
    // run the REAL runtime loader with a fake SDK driver that emits the real order: the record registers (its ctx
    // registers OUTWARD, the settle reports success), and only then the bootstrap pass runs, which may throw.
    describe("an extension whose activation did not complete", () => {
      type Attempt = { installId: string; version: string; bootstrap: "passes" | "throws" };
      const digestOf = (a: Attempt) => (a.version === VERSION ? "d" : "e").repeat(64);
      const record = (a: Attempt) => ({ packageName: PACKAGE, version: a.version, serverEntry: "./register",
        requestedHostPorts: ["mcp"], sdkAbiRange: "^2", storeDir: `/store/connector/outreach/${digestOf(a)}`,
        declaredDigest: digestOf(a), kind: "connector" });
      const anchor = (a: Attempt) => ({ installId: a.installId, integrity: "sha512-a", contentHash: "ch-a",
        registryUrl: "https://registry.cinatra.ai", trustDecision: true, approvedPorts: ["mcp"], version: a.version,
        isDefault: true, signature: null, digest: digestOf(a), kind: "connector" });

      type Deps = { records?: Array<ReturnType<typeof record>>;
        makeContext: (p: string, ports: readonly string[], r: unknown) => ReturnType<typeof createExtensionHostContext>;
        onRegisterSettled?: (r: unknown, ok: boolean) => void };
      /** One activation pass through the real loader of DEFAULT records of PACKAGE, in this order; each record's
       *  `bootstrap` decides its own bootstrap result, reported (as the real driver does) by package name only. */
      async function activateRecords(attempts: Attempt[], ran: string[]) {
        extensionRegistryModule.removeExtensionMcpToolsForPackage(PACKAGE);
        activation.records = attempts.map(record);
        activation.drive = async (_root, rawDeps) => {
          const deps = rawDeps as unknown as Deps;
          const results: unknown[] = [];
          const registered: Attempt[] = [];
          (deps.records ?? []).forEach((r, i) => {
            const attempt = attempts[i]!;
            const ctx = deps.makeContext(r.packageName, r.requestedHostPorts, r);
            ctx.mcp.registerTool({ name: OUTWARD, description: OUTWARD, outward: {},
              handler: async () => { ran.push(attempt.installId); return { sent: attempt.installId }; },
            } as Parameters<typeof ctx.mcp.registerTool>[0]);
            deps.onRegisterSettled?.(r, true);
            results.push({ packageName: r.packageName, status: "registered" });
            registered.push(attempt);
          });
          for (const attempt of registered) {
            results.push(attempt.bootstrap === "throws"
              ? { packageName: PACKAGE, status: "failed", reason: "bootstrap-threw", error: new Error("bootstrap failed") }
              : { packageName: PACKAGE, status: "bootstrapped" });
          }
          return results;
        };
        return loadRuntimePackageExtensions("/store", {
          resolveInstallAnchors: async () => attempts.map(anchor) as never,
        });
      }
      /** One activation of PACKAGE@VERSION through the real loader; `bootstrap` decides the bootstrap result. */
      const activate = (installId: string, bootstrap: Attempt["bootstrap"], ran: string[]) =>
        activateRecords([{ installId, version: VERSION, bootstrap }], ran);

      afterEach(() => {
        activation.drive = null;
        activation.records = [];
      });

      // Without the guarded action the refusal names no code; without this rule the stamp of a register-passes /
      // bootstrap-throws activation stays current, so the call runs:
      // red-first-expect: expected 'Authorization denied for example_outw…' to contain 'outward_effect_requires_recorded_deci…
      it("refuses an outward tool of an extension whose bootstrap threw, and consumes no decision", async () => {
        const ran: string[] = [];
        const results = await activate("install-A", "throws", ran);
        expect(results.map((r) => (r as { status: string }).status)).toEqual(["registered", "failed"]);
        const result = await (await replayServer())(runFrame());
        expect(result.content?.[0]?.text).toContain(`${REASON}:action_loaded_identity_stale`);
        expect(store.consume).not.toHaveBeenCalled();
        expect(store.decisions.get("run-1|step-1")!.consumed).toBe(false);
        expect(ran).toEqual([]);
      });

      it("serves the outward tool of a fully activated extension once", async () => {
        const ran: string[] = [];
        await activate("install-A", "passes", ran);
        expect((await (await replayServer())(runFrame())).isError).toBeFalsy();
        expect(ran).toEqual(["install-A"]);
        expect((store.consume.mock.calls[0]![0] as { action: { installId: string } }).action.installId).toBe("install-A");
      });

      // A reload's own stamp retires the previous identity of the same version at once, and its bootstrap failure
      // retires the new one: nothing serves an outward call until a later activation passes (the hot update's
      // rollback re-activates the previous revision, which then gets an identity of its own).
      // red-first-expect: expected 'Authorization denied for example_outw…' to contain 'outward_effect_requires_recorded_deci…
      it("a reload whose bootstrap throws retires the new identity and keeps no previous one serving", async () => {
        const ran: string[] = [];
        await activate("install-A", "passes", ran);
        const previous = await replayServer();
        await activate("install-B", "throws", ran);
        for (const call of [previous, await replayServer()]) {
          expect((await call(runFrame())).content?.[0]?.text).toContain(`${REASON}:action_loaded_identity_stale`);
        }
        expect(store.consume).not.toHaveBeenCalled();
        expect(ran).toEqual([]);
        await activate("install-A", "passes", ran);
        expect((await (await replayServer())(runFrame())).isError).toBeFalsy();
        expect(ran).toEqual(["install-A"]);
      });

      // Two default records of one package are permitted; each bootstrap outcome belongs to the record bootstrapped.
      // Without the bootstrap rule record A's stamp stays current; with the failure bound to the package name, the
      // failure of record A retired the stamp of record B as well:
      // red-first-expect: expected { packageName: '@acme/outreach', …(4) } to be undefined
      it("a failed bootstrap of one default record never retires another default record of the package", async () => {
        const ran: string[] = [];
        await activateRecords([
          { installId: "install-A", version: "1.2.2", bootstrap: "throws" },
          { installId: "install-B", version: VERSION, bootstrap: "passes" },
        ], ran);
        expect(registryModule.currentLoadedExtensionIdentity(PACKAGE, "1.2.2")).toBeUndefined();
        expect(registryModule.currentLoadedExtensionIdentity(PACKAGE, VERSION)).toMatchObject({ installId: "install-B" });
        const call = await replayServer();
        expect((await call(runFrame())).isError).toBeFalsy();
        expect(ran).toEqual(["install-B"]);
        expect((store.consume.mock.calls[0]![0] as { action: { installId: string } }).action.installId).toBe("install-B");
        expect((await call(runFrame())).content?.[0]?.text).toContain(`${REASON}:action_person_decision_already_consumed`);
        expect(ran).toEqual(["install-B"]);
      });

      it("retires both default records of the package when both bootstraps throw", async () => {
        const ran: string[] = [];
        await activateRecords([
          { installId: "install-A", version: "1.2.2", bootstrap: "throws" },
          { installId: "install-B", version: VERSION, bootstrap: "throws" },
        ], ran);
        expect(registryModule.currentLoadedExtensionIdentity(PACKAGE, "1.2.2")).toBeUndefined();
        expect(registryModule.currentLoadedExtensionIdentity(PACKAGE, VERSION)).toBeUndefined();
        expect((await (await replayServer())(runFrame())).content?.[0]?.text).toContain(`${REASON}:action_loaded_identity_stale`);
        expect(store.consume).not.toHaveBeenCalled();
        expect(ran).toEqual([]);
      });
    });
  });

  // cinatra#3745: ONE DECISION, ONE EFFECT. The person released one decision for the step's offered tool and its
  // subject. A call a tool's handler makes through `ctx.mcp.callPrimitive` (the self-invoker's inner call) is not that
  // tool, so an outward inner call is refused with a fixed code, whether the offered tool is outward or not, and never
  // uses the decision. These cases run the real self-invoker and the real boundary inside the real runtime server.
  describe("an outward call made inside a run's tool", () => {
    const WRAPPER = "example_outward_wrapper";
    const PLAIN_WRAPPER = "example_plain_wrapper";
    const INNER = "example_inner_publish";
    const INNER_READ = "example_inner_read";
    const INNER_REASON = `${REASON}:action_inner_outward_call_refused`;

    async function buildWrappers(innerName: string) {
      const ran: string[] = [];
      const errors: string[] = [];
      let later: (() => Promise<unknown>) | null = null;
      selfInvoker.handlers.clear();
      const recording = extensionRegistryModule.createSelfPrimitiveRecordingServer(
        selfInvoker.handlers as Map<string, CapturedHostPrimitive>);
      for (const [name, outward] of [[INNER, true], [INNER_READ, false]] as const) {
        (recording.registerTool as unknown as (n: string, c: unknown, h: (...a: unknown[]) => unknown) => unknown)(
          name, { title: name, description: name, ...(outward ? { outward: {} } : {}) },
          async () => { ran.push(name); return { structuredContent: { ok: name } }; });
      }
      __resetHostSelfPrimitiveHandlers();
      const runtime = await createMcpRuntimeServer({
        name: "guarded-outward-inner-test",
        version: "0.0.0",
        registerCapabilities: (toolServer) => {
          for (const [name, outward] of [[WRAPPER, true], [PLAIN_WRAPPER, false]] as const) {
            (toolServer.registerTool as unknown as (n: string, c: unknown, h: (...a: unknown[]) => unknown) => unknown)(
              name, { title: name, description: name, ...(outward ? { outward: {} } : {}) }, async () => {
                ran.push(name);
                later = () => callHostPrimitive(innerName, {});
                try { await callHostPrimitive(innerName, {}); } catch (e) { errors.push(String((e as Error).message)); }
                return { content: [{ type: "text", text: "done" }] };
              });
          }
        },
      });
      const registry = (runtime as unknown as {
        _registeredTools: Record<string, { handler: (...a: unknown[]) => unknown }>;
      })._registeredTools;
      return {
        ran, errors,
        call: (name: string): Promise<ToolResult> =>
          mcpRequestContextStorage.run(runFrame(), () => registry[name]!.handler({}, {})) as Promise<ToolResult>,
        callLater: () => mcpRequestContextStorage.run(runFrame(), () => later!()),
      };
    }

    beforeEach(() => {
      store.decisions.set("run-1|step-1", { tools: new Set([WRAPPER, INNER]), consumed: false, released: [] });
      vi.mocked(augmentModule.lookupPrimitiveClassification).mockImplementation((name: string) =>
        [OUTWARD, OTHER_OUTWARD, WRAPPER, PLAIN_WRAPPER, INNER, INNER_READ].includes(name)
          ? { ...FIXTURE_CLASSIFICATION } : undefined);
    });
    afterEach(() => {
      selfInvoker.handlers.clear();
      __resetHostSelfPrimitiveHandlers();
    });

    // Before the change the inner call takes the guarded action and is refused as undeclared after the wrapper used
    // the decision up:
    // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
    it("a declared outward wrapper uses the decision once, and its outward inner call is refused, unrun", async () => {
      const w = await buildWrappers(INNER);
      expect((await w.call(WRAPPER)).isError).toBeFalsy();
      expect(w.errors).toHaveLength(1);
      expect(w.errors[0]).toContain(INNER_REASON);
      expect(w.ran).toEqual([WRAPPER]);
      expect(store.consume).toHaveBeenCalledTimes(1);
      expect((store.consume.mock.calls[0]![0] as { action: { toolName: string } }).action.toolName).toBe(WRAPPER);
      expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ operation: INNER, decision: "denied",
        metadata: expect.objectContaining({ reason: INNER_REASON }) }));
    });

    // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
    it("a wrapper that is not outward has no decision, and its outward inner call is refused without reading one", async () => {
      const w = await buildWrappers(INNER);
      expect((await w.call(PLAIN_WRAPPER)).isError).toBeFalsy();
      expect(w.errors[0]).toContain(INNER_REASON);
      expect(w.ran).toEqual([PLAIN_WRAPPER]);
      expect(store.consume).not.toHaveBeenCalled();
      expect(store.decisions.get("run-1|step-1")!.consumed).toBe(false);
    });

    // red-first-expect: to contain 'outward_effect_requires_recorded_deci…
    it("an outward inner call made after the wrapper returned is refused, and the decision is not used again", async () => {
      const w = await buildWrappers(INNER);
      await w.call(WRAPPER);
      const late = await w.callLater().catch((e: unknown) => e);
      expect(String((late as Error).message)).toContain(INNER_REASON);
      expect(w.ran).toEqual([WRAPPER]);
      expect(store.consume).toHaveBeenCalledTimes(1);
    });

    it("an inner call of a tool that is not outward is served as before", async () => {
      const w = await buildWrappers(INNER_READ);
      expect((await w.call(PLAIN_WRAPPER)).isError).toBeFalsy();
      expect(w.errors).toEqual([]);
      expect(w.ran).toEqual([PLAIN_WRAPPER, INNER_READ]);
      expect(store.consume).not.toHaveBeenCalled();
    });
  });

  // cinatra#3745: WHAT IS AUTHORIZED IS WHAT RUNS, on every dispatch path. Registration A (not outward) is planned and
  // authorized; a same-version registration B that declares itself outward replaces it before the handler is taken.
  // A's handler may run (it is what was checked), or the call is refused; B's handler never runs. These cases use the
  // real host ctx and registries, the real replayed config and recording server, the real edge-bound resolution, the
  // real pinned dispatch, the real self-invoker and the real boundary.
  describe("what is authorized is what runs", () => {
    const SWAPPED = "example_swapped_tool";
    const RETAINED_VERSION = "2.0.0";
    const DEPENDENT = "install-dependent";

    /** Registration of the DEFAULT version through the real host ctx (the registry entry). */
    function registerDefault(tag: string, ran: string[], outward: boolean) {
      const ctx = createExtensionHostContext(PACKAGE, ["mcp"], {}, { installId: `install-${tag}`, version: VERSION, isDefault: true });
      ctx.mcp.registerTool({ name: SWAPPED, description: SWAPPED, ...(outward ? { outward: {} } : {}),
        handler: async () => { ran.push(tag); return { ran: tag }; } } as Parameters<typeof ctx.mcp.registerTool>[0]);
      const entry = extensionRegistryModule.listExtensionMcpTools().find((t) => t.name === SWAPPED);
      if (!entry) throw new Error("not registered");
      return entry;
    }
    /** A retained (non-default, pinned) version's registration, committed as a successful load attempt does. */
    function retain(tag: string, ran: string[], outward: boolean) {
      const sink = beginVersionKeyedRegistration(PACKAGE, RETAINED_VERSION);
      sink.retainMcpTool({ name: SWAPPED, packageName: PACKAGE, ...(outward ? { outward: {} } : {}),
        handler: async () => { ran.push(tag); return { ran: tag }; } });
      sink.commit();
      const served = resolveVersionKeyedMcpTool(PACKAGE, RETAINED_VERSION, SWAPPED);
      if (served.kind !== "serve") throw new Error("not retained");
      return served.value;
    }
    const config = (registration: object, kind: "extension-default" | "extension-versioned", version: string) =>
      extensionRegistryModule.buildReplayedExtensionToolConfig(SWAPPED, registration, {
        ownerPackage: PACKAGE, resolvedVersion: version,
        dispatchTarget: { kind, packageName: PACKAGE, version, name: SWAPPED },
      });
    /** The run's edge pins the retained version (the dependent's install row and its resolved edge). */
    function pinRetained<T>(fn: () => Promise<T>): Promise<T> {
      installs.rows.set(DEPENDENT, { id: DEPENDENT, packageName: "@acme/dependent", status: "active",
        organizationId: "org-1", ownerLevel: "organization", ownerId: null, isDefault: true,
        dependencyEdges: [{ packageName: PACKAGE, edgeType: "runtime", requirement: "required",
          versionConstraint: { kind: "exact", version: RETAINED_VERSION }, resolvedInstallId: "install-retained",
          resolutionReason: "test" }] });
      installs.rows.set("install-retained", { id: "install-retained", packageName: PACKAGE, status: "active",
        organizationId: "org-1", ownerLevel: "organization", ownerId: null, isDefault: false,
        version: RETAINED_VERSION, dependencyEdges: [] });
      return withActorContext({ dependentInstallId: DEPENDENT } as Parameters<typeof withActorContext>[0], fn) as Promise<T>;
    }
    async function runtimeCall(registerHandler: (input: unknown) => Promise<unknown>, cfg: unknown) {
      const runtime = await createMcpRuntimeServer({
        name: "authorized-runs-test", version: "0.0.0",
        registerCapabilities: (toolServer) => {
          (toolServer.registerTool as unknown as (n: string, c: unknown, h: (input: unknown) => unknown) => unknown)(
            SWAPPED, cfg, async (input: unknown) => wrapExtensionToolResult(await registerHandler(input)));
        },
      });
      const registry = (runtime as unknown as {
        _registeredTools: Record<string, { handler: (...a: unknown[]) => unknown }>;
      })._registeredTools;
      return () => mcpRequestContextStorage.run(runFrame(), () => registry[SWAPPED]!.handler({}, {})) as Promise<ToolResult>;
    }

    beforeEach(() => {
      __resetVersionKeyedServingForTests();
      installs.rows.clear();
      vi.mocked(augmentModule.lookupPrimitiveClassification).mockImplementation((name: string) =>
        name === SWAPPED ? { ...FIXTURE_CLASSIFICATION } : undefined);
    });
    afterEach(() => {
      extensionRegistryModule.removeExtensionMcpToolsForPackage(PACKAGE);
      __resetVersionKeyedServingForTests();
      selfInvoker.handlers.clear();
      __resetHostSelfPrimitiveHandlers();
      installs.rows.clear();
    });

    it("the runtime server's default dispatch runs the planned registration A, never B", async () => {
      const ran: string[] = [];
      const a = registerDefault("A", ran, false);
      const call = await runtimeCall((input) => dispatchPlannedExtensionMcpTool({ expected: "default", tool: a }, input),
        config(a, "extension-default", VERSION));
      registerDefault("B", ran, true);
      const result = await call();
      expect(result.isError).toBeFalsy();
      expect(ran).toEqual(["A"]);
      expect(store.consume).not.toHaveBeenCalled();
    });

    // The handler below is the live replay's versioned dispatch as `src/lib/mcp-server.ts` writes it (the planned
    // retained entry passed as `registration`).
    // red-first-expect: expected [ 'B' ] to deeply equal []
    it("the runtime server's versioned dispatch refuses when the retained entry was replaced", async () => {
      const ran: string[] = [];
      const a = retain("A", ran, false);
      const call = await runtimeCall((input) => dispatchPlannedExtensionMcpTool({ expected: "versioned",
        packageName: PACKAGE, name: SWAPPED, version: RETAINED_VERSION, registration: a }, input),
      config(a, "extension-versioned", RETAINED_VERSION));
      retain("B", ran, true);
      const outcome = await pinRetained(call).catch((e: unknown) => e);
      expect(ran).toEqual([]);
      expect(outcome).toMatchObject({ code: "EDGE_BOUND_PLAN_DRIFT" });
      expect(String((outcome as Error).message)).toContain("re-registered by another load since it was planned");
      expect(store.consume).not.toHaveBeenCalled();
    });

    it("the self-invoker's inner call on the default version runs the authorized registration A, never B", async () => {
      const ran: string[] = [];
      const a = registerDefault("A", ran, false);
      selfInvoker.handlers.clear();
      const recording = extensionRegistryModule.createSelfPrimitiveRecordingServer(
        selfInvoker.handlers as Map<string, CapturedHostPrimitive>);
      // As the self-invoker build captures a default registration.
      (recording.registerTool as unknown as (n: string, c: unknown, h: (input: unknown) => unknown) => unknown)(
        SWAPPED, config(a, "extension-default", VERSION),
        async (input: unknown) => wrapExtensionToolResult(await dispatchExtensionMcpToolEdgeBound(a, input)));
      __resetHostSelfPrimitiveHandlers();
      registerDefault("B", ran, true);
      const out = await mcpRequestContextStorage.run(runFrame(), () => callHostPrimitive(SWAPPED, {}));
      expect(ran).toEqual(["A"]);
      expect(out).toEqual({ ran: "A" });
      expect(store.consume).not.toHaveBeenCalled();
    });

    // red-first-expect: expected [ 'B' ] to deeply equal []
    it("the self-invoker's inner call on a retained version refuses when the retained entry was replaced", async () => {
      const ran: string[] = [];
      const a = retain("A", ran, false);
      selfInvoker.handlers.clear();
      const recording = extensionRegistryModule.createSelfPrimitiveRecordingServer(
        selfInvoker.handlers as Map<string, CapturedHostPrimitive>);
      // As the self-invoker build captures a retained union entry.
      (recording.registerTool as unknown as (n: string, c: unknown, h: (input: unknown) => unknown) => unknown)(
        SWAPPED, config(a, "extension-versioned", RETAINED_VERSION),
        async (input: unknown) => wrapExtensionToolResult(
          await dispatchVersionedOnlyExtensionMcpTool({ packageName: PACKAGE, name: SWAPPED }, input)));
      __resetHostSelfPrimitiveHandlers();
      retain("B", ran, true);
      const outcome = await pinRetained(() =>
        mcpRequestContextStorage.run(runFrame(), () => callHostPrimitive(SWAPPED, {}))).catch((e: unknown) => e);
      expect(ran).toEqual([]);
      expect(outcome).toMatchObject({ code: "EDGE_BOUND_PLAN_DRIFT" });
      expect(String((outcome as Error).message)).toContain("re-registered by another load since it was planned");
      expect(store.consume).not.toHaveBeenCalled();
    });

    it("the self-invoker's inner call on a retained version runs its entry when nothing replaced it", async () => {
      const ran: string[] = [];
      const a = retain("A", ran, false);
      selfInvoker.handlers.clear();
      const recording = extensionRegistryModule.createSelfPrimitiveRecordingServer(
        selfInvoker.handlers as Map<string, CapturedHostPrimitive>);
      (recording.registerTool as unknown as (n: string, c: unknown, h: (input: unknown) => unknown) => unknown)(
        SWAPPED, config(a, "extension-versioned", RETAINED_VERSION),
        async (input: unknown) => wrapExtensionToolResult(
          await dispatchVersionedOnlyExtensionMcpTool({ packageName: PACKAGE, name: SWAPPED }, input)));
      __resetHostSelfPrimitiveHandlers();
      const out = await pinRetained(() => mcpRequestContextStorage.run(runFrame(), () => callHostPrimitive(SWAPPED, {})));
      expect(out).toEqual({ ran: "A" });
      expect(ran).toEqual(["A"]);
    });
  });
});
