import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  registerExtensionMcpTool,
  listExtensionMcpTools,
  _resetExtensionMcpForTests,
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
    // as `none` (owner ruling, cinatra#2771): the policy's
    // `resolveDelegatedChatClass` fills in an interim class for an absent
    // declaration and must NOT for an explicit `none`, so a registry that
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
});
