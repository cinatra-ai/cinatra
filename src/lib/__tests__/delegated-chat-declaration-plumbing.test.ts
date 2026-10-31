import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  registerExtensionMcpTool,
  listExtensionMcpTools,
  _resetExtensionMcpForTests,
  buildReplayedExtensionToolConfig,
  createSelfPrimitiveRecordingServer,
  type CapturedHostPrimitive,
} from "@/lib/extension-mcp-registry";
import {
  planExtensionToolDiscovery,
  planSelfInvokerRetainedUnion,
  type DiscoveryDefaultTool,
  type ResolveEdgeBoundExtensionDeps,
} from "@/lib/extension-edge-bound-serving";
import {
  beginVersionKeyedRegistration,
  listServableVersionKeyedMcpTools,
  resolveVersionKeyedMcpTool,
  __resetVersionKeyedServingForTests,
} from "@/lib/extension-version-keyed-serving";
import * as auditModule from "@/lib/authz/audit";
import * as augmentModule from "@/lib/authz/inventory-augment";
import * as extensionRegistryModule from "@/lib/extension-mcp-registry";
import { callHostPrimitive, __resetHostSelfPrimitiveHandlers } from "@/lib/extension-self-mcp";
import { bindArtifactGuardedMcpHandler } from "@/lib/extension-host-context";
import { recordLoadedExtensionIdentity } from "@/lib/extension-capabilities-registry";
import { mcpRequestContextStorage, type McpRequestContext } from "@cinatra-ai/mcp-server";
import type { ExtensionMcpToolConfig } from "@cinatra-ai/sdk-extensions/mcp-contract";

// The host's primitive map, replaced for the retained-version self-invoker
// cases at the foot of this file: `buildHostSelfPrimitiveHandlers` returns the
// map those cases build through the real union plan, the real replay builder
// and the real recording server. Every other case reads `mcp-server.ts` as
// source text only. The replacement is lifted after the file's cases.
const selfInvoker = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }));
vi.mock("@/lib/mcp-server", () => ({
  buildHostSelfPrimitiveHandlers: async () => selfInvoker.handlers,
}));
// cinatra#3745: a run's frame carries the executed-run source the host's loader
// verified, and the step's declared tools are read before the boundary decides;
// the run store answers that source as current and the step as declaring nothing.
vi.mock("@cinatra-ai/agents/store", () => ({
  isRunExecutedSourceCurrent: async () => true,
  readRunStepToolPolicy: async () => ({}),
  assertRunStepToolAllowed: () => ({ kind: "undeclared" }),
  parseRunStepToolPolicy: (policy: unknown) => policy,
  withRunActionPolicyTransaction: async () => {
    throw new Error("no person-gate consumption in these cases");
  },
}));

// ---------------------------------------------------------------------------
// The typed delegated-chat declaration, HOP BY HOP (cinatra#2771).
//
// The #2771 review's plumbing map named the exact hops where a new field on a
// registration is silently dropped. A field that survives the registry but
// dies before the choke point is worse than no field at all: it reads as
// present in the source and is absent in the decision. So each named hop gets
// its own assertion here, and each one fails independently.
//
//   REGISTRY            `ctx.mcp.registerTool` → the default registry, plus
//                       the version-keyed retention sink for a pinned
//                       non-default sibling. Both NORMALIZE structurally, so a
//                       malformed value can never travel further.
//   VERSIONED DISCOVERY `DiscoveryDefaultTool` is a HAND-COPIED field list, so
//                       it drops anything not explicitly carried.
//   REPLAY              the per-request server build reconstructs a fresh
//                       `registerTool` config from scratch — only
//                       title/description/inputSchema used to be rebuilt.
//   CALL-TIME LOOKUP    the self-invoker's name-keyed map, and the retained
//                       union plan that feeds it, were both lossy.
//
// The narrow-only SEMANTICS live with the policy that enforces them and are
// tested there (`packages/mcp-server/.../delegated-chat-declaration*.test.ts`).
// This file is about PRESERVATION: does the value the registration wrote reach
// the place that decides.
// ---------------------------------------------------------------------------

const PKG = "@cinatra-ai/acme";
const handler = async () => ({ ok: true });

afterEach(() => {
  _resetExtensionMcpForTests();
  __resetVersionKeyedServingForTests();
});
beforeEach(() => {
  __resetVersionKeyedServingForTests();
});
afterAll(() => {
  __resetHostSelfPrimitiveHandlers();
  vi.doUnmock("@/lib/mcp-server");
  vi.resetModules();
});

// The two input fields an outward declaration names for the stored item and
// its revision.
const SUBJECT_FIELDS = { artifactId: "itemId", representationRevisionId: "revisionId" };

describe("hop 1a — the DEFAULT extension MCP registry", () => {
  it("carries a declared class through registration", () => {
    registerExtensionMcpTool(PKG, { name: "acme_thing_list", handler, delegatedChat: "read" });
    expect(listExtensionMcpTools()[0]).toMatchObject({
      name: "acme_thing_list",
      packageName: PKG,
      delegatedChat: "read",
    });
  });

  it("leaves an UNDECLARED registration undeclared — absent, not `none`", () => {
    // Every registration in the tree today takes this path. ABSENCE must stay
    // a distinct third state here even though the decision layer now reads it
    // as `none` (owner ruling, cinatra#2771): the plan reads an absent
    // declaration as `undefined` and an explicit `none` as a refusal, so a
    // registry that
    // collapsed the two would make a connector's deliberate opt-out
    // indistinguishable from never having said anything.
    registerExtensionMcpTool(PKG, { name: "acme_thing_list", handler });
    expect(listExtensionMcpTools()[0].delegatedChat).toBeUndefined();
  });

  it("NORMALIZES a malformed declaration at the boundary, toward narrowing", () => {
    registerExtensionMcpTool(PKG, {
      name: "acme_thing_list",
      handler,
      // @ts-expect-error — a connector shipping an off-enum value is the case
      delegatedChat: "superuser",
    });
    expect(listExtensionMcpTools()[0].delegatedChat).toBe("none");
  });

  it("keeps an outward declaration on the registry entry, the very object the registration wrote, and adds none", () => {
    const outward = { subject: { ...SUBJECT_FIELDS } };
    registerExtensionMcpTool(PKG, { name: "example_outward_tool", handler, outward });
    registerExtensionMcpTool(PKG, { name: "acme_thing_list", handler });
    const byName = new Map(listExtensionMcpTools().map((t) => [t.name, t]));
    expect(byName.get("example_outward_tool")?.outward).toBe(outward);
    expect(Object.prototype.hasOwnProperty.call(byName.get("acme_thing_list"), "outward")).toBe(false);
  });
});

describe("hop 1b — the VERSION-KEYED retention sink (a pinned non-default sibling)", () => {
  it("carries and normalizes on the same terms as the default registry", () => {
    const sink = beginVersionKeyedRegistration(PKG, "2.0.0");
    sink.retainMcpTool({ name: "acme_thing_list", handler, packageName: PKG, delegatedChat: "discovery" });
    sink.retainMcpTool({
      name: "acme_other_list",
      handler,
      packageName: PKG,
      // @ts-expect-error — off-enum value
      delegatedChat: 42,
    });
    sink.commit();

    const declared = resolveVersionKeyedMcpTool(PKG, "2.0.0", "acme_thing_list");
    expect(declared.kind).toBe("serve");
    expect(declared.kind === "serve" && declared.value.delegatedChat).toBe("discovery");

    const malformed = resolveVersionKeyedMcpTool(PKG, "2.0.0", "acme_other_list");
    expect(malformed.kind === "serve" && malformed.value.delegatedChat).toBe("none");
  });

  it("keeps an outward declaration on the retained tool, the very object the registration wrote", () => {
    const outward = {};
    const sink = beginVersionKeyedRegistration(PKG, "2.0.0");
    sink.retainMcpTool({ name: "example_outward_tool", handler, packageName: PKG, outward });
    sink.commit();

    const retained = resolveVersionKeyedMcpTool(PKG, "2.0.0", "example_outward_tool");
    expect(retained.kind).toBe("serve");
    expect(retained.kind === "serve" && retained.value.outward).toBe(outward);
  });
});

describe("hop 2 — VERSIONED DISCOVERY (the hand-copied DiscoveryDefaultTool list)", () => {
  const noIdentityDeps: ResolveEdgeBoundExtensionDeps = {
    getDependentInstallId: () => undefined,
    getVerifiedRunId: () => undefined,
    readInstalledExtensionById: async () => null,
    readAgentRunById: async () => null,
    readAgentTemplateById: async () => null,
    readInstalledExtensionsByPackageName: async () => [],
  };

  it("the default replay preserves the declaration", async () => {
    const defaults: DiscoveryDefaultTool[] = [
      { name: "acme_thing_list", packageName: PKG, handler, delegatedChat: "read" },
      { name: "acme_plain_list", packageName: PKG, handler },
    ];
    const plan = await planExtensionToolDiscovery(defaults, noIdentityDeps);
    expect(plan.entries).toHaveLength(2);
    const first = plan.entries[0];
    expect(first.mode).toBe("default");
    expect(first.mode === "default" && first.tool.delegatedChat).toBe("read");
    const second = plan.entries[1];
    expect(second.mode === "default" && second.tool.delegatedChat).toBeUndefined();
  });

  it("the default replay keeps the outward declaration unchanged, and adds none", async () => {
    const outward = { subject: { ...SUBJECT_FIELDS } };
    const defaults: DiscoveryDefaultTool[] = [
      { name: "example_outward_tool", packageName: PKG, handler, outward },
      { name: "acme_plain_list", packageName: PKG, handler },
    ];
    const plan = await planExtensionToolDiscovery(defaults, noIdentityDeps);
    expect(plan.entries).toHaveLength(2);
    const [first, second] = plan.entries;
    expect(first.mode).toBe("default");
    expect(first.tool.outward).toBe(outward);
    expect(second.mode).toBe("default");
    expect(Object.prototype.hasOwnProperty.call(second.tool, "outward")).toBe(false);
  });
});

describe("hop 4 — CALL-TIME LOOKUP: the self-invoker's retained union plan", () => {
  it("carries the retained registration's declaration into the register list", () => {
    // This plan is what the self-invoker's name-keyed map is built from. It
    // used to carry only (name, packageName, version), so a declaration died
    // here and the in-process invoker could not have agreed with the live
    // transport about the same registration.
    const sink = beginVersionKeyedRegistration(PKG, "2.0.0");
    sink.retainMcpTool({ name: "acme_v_only", handler, packageName: PKG, delegatedChat: "none" });
    sink.retainMcpTool({ name: "acme_v_plain", handler, packageName: PKG });
    sink.commit();

    const plan = planSelfInvokerRetainedUnion(listServableVersionKeyedMcpTools(), {
      hostClaimedNames: new Set<string>(),
      extensionClaimedNames: new Set<string>(),
    });
    const byName = new Map(plan.register.map((e) => [e.name, e]));
    expect(byName.get("acme_v_only")?.delegatedChat).toBe("none");
    expect(byName.get("acme_v_plain")?.delegatedChat).toBeUndefined();
  });

  it("carries the retained registration's outward declaration into the register list, subject preserved", () => {
    const sink = beginVersionKeyedRegistration(PKG, "2.0.0");
    sink.retainMcpTool({
      name: "example_outward_tool",
      handler,
      packageName: PKG,
      outward: { subject: { ...SUBJECT_FIELDS } },
    });
    sink.commit();

    const plan = planSelfInvokerRetainedUnion(listServableVersionKeyedMcpTools(), {
      hostClaimedNames: new Set<string>(),
      extensionClaimedNames: new Set<string>(),
    });
    const entry = plan.register.find((e) => e.name === "example_outward_tool");
    expect(entry?.outward).toEqual({ subject: SUBJECT_FIELDS });
  });

  it("writes no outward declaration into the register entry of a retained registration that states none", () => {
    const sink = beginVersionKeyedRegistration(PKG, "2.0.0");
    sink.retainMcpTool({ name: "acme_v_plain", handler, packageName: PKG });
    sink.commit();

    const plan = planSelfInvokerRetainedUnion(listServableVersionKeyedMcpTools(), {
      hostClaimedNames: new Set<string>(),
      extensionClaimedNames: new Set<string>(),
    });
    const entry = plan.register.find((e) => e.name === "acme_v_plain");
    expect(entry).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(entry, "outward")).toBe(false);
  });
});

describe("hop 3 — the REPLAY's freshly constructed registerTool config", () => {
  // WHAT THIS IS NOW. Both halves of this hop — the from-scratch config the
  // replay puts on the wire, and the recording pass that reads it back — used
  // to be inline in `registerAllCapabilities` / `buildHostSelfPrimitiveHandlers`,
  // which need the whole connector/module graph and a database, so they could
  // only be pinned as SOURCE STRINGS. That proved a line existed and nothing
  // about what it did.
  //
  // They are now pure seams in `@/lib/extension-mcp-registry` — the registry
  // the replay replays, and a module already on every route `mcp-server.ts` is
  // on, so reaching them costs no locked route a module. Their
  // BEHAVIOUR — register with a declaration, replay, capture, and have the
  // call-time lookup see the same class — is covered end to end in
  // `delegated-chat-declaration-replay-roundtrip.test.ts`.
  //
  // What is left here is the one thing a behavioural test on the seams cannot
  // see: that the DB-bound call sites still route through them. A `registerTool`
  // call that went back to building its own object literal would leave every
  // seam test green while dropping the declaration in production.
  const source = readFileSync(new URL("../mcp-server.ts", import.meta.url), "utf8");

  it("the replay builds its config with the shared seam", () => {
    // cinatra#2817 slice 1 added the PROVENANCE argument, so the pinned call
    // shape now carries three arguments. Still the same assurance: the DB-bound
    // replay routes through the shared seam rather than building its own
    // literal, which would silently drop the declaration AND the provenance.
    expect(source).toContain("buildReplayedExtensionToolConfig(name, registration, {");
  });

  it("the self-invoker capture runs against the shared recording server", () => {
    // The recording pass and the live pass must not disagree about what a
    // module declared, so both read it with the policy's own reader — which is
    // what the shared seam guarantees.
    expect(source).toContain("createSelfPrimitiveRecordingServer(handlers)");
  });

  it("the retained-version self-invoker replay names the outward declaration next to the delegated-chat one", () => {
    expect(source).toContain("{ delegatedChat: entry.delegatedChat, outward: entry.outward }");
  });

  it("the default self-invoker replay passes the registry entry as it stands", () => {
    expect(source).toContain("buildReplayedExtensionToolConfig(tool.name, tool, {");
  });
});

// ---------------------------------------------------------------------------
// THE RETAINED-VERSION SELF-INVOKER ROAD, END TO END (cinatra#3745).
//
// A pinned non-default version's registration goes through the retention
// sink, the servable listing, the self-invoker's retained union plan, the real
// replay builder with the provenance the self-invoker build writes, and the
// real recording server. `callHostPrimitive` then decides over the captured
// entry with the real `enforceMcpBoundary`; only the audit writer, the
// classification reader and the extension-registry reader are test doubles,
// restored after each case. On an agent run's frame a tool whose registration
// declares outward waits for the person's recorded decision, and a tool that
// declares nothing is served by the boundary's other rules.
// ---------------------------------------------------------------------------
describe("the retained-version self-invoker road holds a declared outward tool on a run's frame", () => {
  const TOOL = "example_outward_tool";
  const VERSION = "2.0.0";
  const REASON = "outward_effect_requires_recorded_decision";
  const FIXTURE_CLASSIFICATION = { resourceType: "agent_run", action: "execute", status: "enforced" } as const;
  const executedSource = {
    contextId: "ctx-1", stepId: "step-1", executionAttemptId: "attempt-1",
    sourceSha256: "a".repeat(64), executedSourceSha256: "b".repeat(64), declarationSourceSha256: "c".repeat(64),
  };
  const runMemberFrame = (): McpRequestContext =>
    ({
      orgId: "org-1", userId: "user-1", runId: "run-1",
      verifiedStepId: "step-1", verifiedExecutedSource: executedSource,
    }) as McpRequestContext;

  let auditSpy: ReturnType<typeof vi.spyOn>;
  let classificationSpy: ReturnType<typeof vi.spyOn>;
  let extensionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    selfInvoker.handlers.clear();
    __resetHostSelfPrimitiveHandlers();
    const realLookup = augmentModule.lookupPrimitiveClassification;
    auditSpy = vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined);
    classificationSpy = vi
      .spyOn(augmentModule, "lookupPrimitiveClassification")
      .mockImplementation((name: string) => (name === TOOL ? { ...FIXTURE_CLASSIFICATION } : realLookup(name)));
    extensionSpy = vi.spyOn(extensionRegistryModule, "getEffectiveExtensionMcpTool").mockReturnValue(undefined);
  });

  afterEach(() => {
    auditSpy.mockRestore();
    classificationSpy.mockRestore();
    extensionSpy.mockRestore();
    vi.restoreAllMocks();
    selfInvoker.handlers.clear();
    __resetHostSelfPrimitiveHandlers();
  });

  /**
   * Retain one registration at a pinned non-default version, plan the
   * self-invoker's retained union, and capture the union entry through the real
   * replay builder and the real recording server with the provenance the
   * self-invoker build writes. The captured map becomes the host's primitive
   * map. Returns the captured entry and the record of the registration's
   * handler calls. `hostBound` binds the handler the way the host's retention
   * sink does for a digest-pinned install whose registration declares the read
   * class: a run's frame reaches only a host-bound guarded leaf (cinatra#3745).
   */
  function captureRetained(outward?: ExtensionMcpToolConfig["outward"], hostBound = false) {
    const handled: string[] = [];
    const sink = beginVersionKeyedRegistration(PKG, VERSION);
    const registration = {
      name: TOOL,
      ...(outward === undefined ? {} : { outward }),
      ...(hostBound ? { delegatedChat: "read" as const } : {}),
    };
    const effect = async () => {
      handled.push(TOOL);
      return { served: true };
    };
    sink.retainMcpTool({
      ...registration,
      packageName: PKG,
      handler: hostBound
        ? bindArtifactGuardedMcpHandler(TOOL, effect, recordLoadedExtensionIdentity({
            packageName: PKG, version: VERSION, installId: "install-1", digest: "f".repeat(64),
          }), registration)
        : effect,
    });
    sink.commit();

    const union = planSelfInvokerRetainedUnion(listServableVersionKeyedMcpTools(), {
      hostClaimedNames: new Set<string>(),
      extensionClaimedNames: new Set<string>(),
    });
    const entry = union.register.find((e) => e.name === TOOL);
    if (!entry) throw new Error(`"${TOOL}" is not in the retained union`);

    const handlers = new Map<string, CapturedHostPrimitive>();
    const recording = createSelfPrimitiveRecordingServer(handlers);
    (recording.registerTool as (...a: unknown[]) => unknown)(
      entry.name,
      buildReplayedExtensionToolConfig(
        entry.name,
        { delegatedChat: entry.delegatedChat, outward: entry.outward },
        {
          ownerPackage: entry.packageName,
          resolvedVersion: entry.version,
          dispatchTarget: {
            kind: "extension-versioned",
            packageName: entry.packageName,
            version: entry.version,
            name: entry.name.toLowerCase(),
          },
        },
      ),
      // Serves the retained registration at its own pinned version.
      async (input: unknown) => {
        const retained = resolveVersionKeyedMcpTool(entry.packageName, entry.version, entry.name);
        if (retained.kind !== "serve") throw new Error(`"${entry.name}" is not served at ${entry.version}`);
        return { structuredContent: await retained.value.handler(input) };
      },
    );
    for (const [name, captured] of handlers) selfInvoker.handlers.set(name, captured);
    __resetHostSelfPrimitiveHandlers();
    const captured = handlers.get(TOOL);
    if (!captured) throw new Error(`"${TOOL}" is not captured`);
    return { captured, handled };
  }

  it("plans `outward: {}` as outward and refuses the call on a run's frame with the named reason, without invoking the handler", async () => {
    const { captured, handled } = captureRetained({});
    expect(captured.planned.declaredOutward).toEqual({ subject: null });
    await expect(
      mcpRequestContextStorage.run(runMemberFrame(), () => callHostPrimitive(TOOL, {})),
    ).rejects.toThrow(REASON);
    expect(handled).toEqual([]);
  });

  it("plans a declared subject as exactly that subject and refuses the call on a run's frame with the named reason", async () => {
    const { captured, handled } = captureRetained({ subject: { ...SUBJECT_FIELDS } });
    expect(captured.planned.declaredOutward).toEqual({ subject: SUBJECT_FIELDS });
    await expect(
      mcpRequestContextStorage.run(runMemberFrame(), () => callHostPrimitive(TOOL, {})),
    ).rejects.toThrow(REASON);
    expect(handled).toEqual([]);
  });

  it("serves a retained registration without the declaration on a run's frame", async () => {
    const { captured, handled } = captureRetained(undefined, true);
    expect(captured.planned.declaredOutward).toBeNull();
    await expect(
      mcpRequestContextStorage.run(runMemberFrame(), () => callHostPrimitive(TOOL, {})),
    ).resolves.toEqual({ served: true });
    expect(handled).toEqual([TOOL]);
  });
});
