/**
 * cinatra#3745: a guarded leaf's call the host does not read as outward
 * needs no CHECK provider, as on main.
 *
 * The host reads a call as outward when its name is in the boundary's
 * outward-effect set, its registration declares `outward`, or its registration
 * cannot be read. Such a call keeps the person gate: with no current loaded
 * identity it refuses before any effect. Every other call is served behind the
 * executed-source fence, the step's tool offer and the ordinary boundary, under
 * a pinned owner or, for a legacy, dev, bundled or stale load, an unpinned one.
 * An extension's own provider still decides for its identity.
 *
 * These cases drive the real guarded leaf (`bindArtifactGuardedMcpHandler` ->
 * `withGuardedRunActionInvocation`), the real capability registry, the real
 * provider resolution and the real boundary prerequisites. The audit writer,
 * the classification reader and the run store are test doubles.
 */
import "server-only";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sourceCurrent: true as boolean | "throw",
  declared: ["example_write_tool", "example_unclassified_tool", "email_send"] as string[],
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  parseRunStepToolPolicy: (p: unknown) => p,
  assertRunStepToolAllowed: (input: { toolName: string }) => {
    if (!h.declared.includes(input.toolName)) throw new Error("step_tool_not_declared");
    return { kind: "declared" };
  },
  readRunStepToolPolicy: async () => ({}),
  isRunExecutedSourceCurrent: async () => {
    if (h.sourceCurrent === "throw") throw new Error("store unavailable");
    return h.sourceCurrent;
  },
  withRunActionPolicyTransaction: async () => {
    throw new Error("no person-gate consumption in these cases");
  },
}));

import * as auditModule from "@/lib/authz/audit";
import * as augmentModule from "@/lib/authz/inventory-augment";
import * as registryModule from "@/lib/extension-capabilities-registry";
import {
  bindLoadedCapabilityProvider,
  recordLoadedExtensionIdentity,
  type LoadedExtensionIdentity,
} from "@/lib/extension-capabilities-registry";
import { bindArtifactGuardedMcpHandler, currentGuardedActionOwner } from "@/lib/extension-host-context";
import { mcpRequestContextStorage, type McpRequestContext } from "@cinatra-ai/mcp-server/request-context";

const PKG = "@example-org/write-pack";
const TOOL = "example_write_tool";
const UNCLASSIFIED = "example_unclassified_tool";
const FIXTURE_CLASSIFICATION = { resourceType: "agent_run", action: "execute", status: "enforced" } as const;
const proof = {
  contextId: "ctx", stepId: "step", executionAttemptId: "attempt",
  sourceSha256: "a".repeat(64), executedSourceSha256: "b".repeat(64), declarationSourceSha256: "c".repeat(64),
};
const runFrame = (): McpRequestContext =>
  ({ runId: "run", orgId: "org", userId: "person", verifiedStepId: "step", verifiedExecutedSource: proof }) as unknown as McpRequestContext;

let installSeq = 0;
function pinnedIdentity(): LoadedExtensionIdentity {
  installSeq += 1;
  return recordLoadedExtensionIdentity({
    packageName: PKG, version: "1.0.0", installId: `mf2-install-${installSeq}`, digest: "e".repeat(64),
  });
}
function staleOf(identity: LoadedExtensionIdentity): LoadedExtensionIdentity {
  return { ...identity, generation: identity.generation + 1000 } as LoadedExtensionIdentity;
}

/** A guarded leaf; `registration` null binds an unreadable registration. */
function leafFor(identity: LoadedExtensionIdentity | undefined, registration: Record<string, unknown> | null | undefined,
  name = TOOL) {
  const effects: unknown[] = [];
  const owners: unknown[] = [];
  const leaf = bindArtifactGuardedMcpHandler(name, async (input: unknown) => {
    effects.push(input);
    owners.push(currentGuardedActionOwner());
    return { served: true };
  }, identity, registration === null ? null : registration === undefined ? undefined : { name, ...registration });
  const call = (input: unknown = { q: "x" }) => mcpRequestContextStorage.run(runFrame(), () => leaf(input));
  return { call, effects, owners };
}

describe("a non-outward guarded call on a run's frame (cinatra#3745)", () => {
  beforeEach(() => {
    h.sourceCurrent = true;
    const realLookup = augmentModule.lookupPrimitiveClassification;
    vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined);
    vi.spyOn(augmentModule, "lookupPrimitiveClassification").mockImplementation((name: string) =>
      name === TOOL ? { ...FIXTURE_CLASSIFICATION } : name === UNCLASSIFIED ? undefined : realLookup(name));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("pinned identity, no provider of its own", () => {
    it.each([
      ["no class", {}],
      ["the write class", { delegatedChat: "none" }],
      ["no registration", undefined],
    ])("serves an undeclared or write tool (%s) once", async (_label, registration) => {
      const { call, effects } = leafFor(pinnedIdentity(), registration);
      await expect(call({ q: "x" })).resolves.toEqual({ served: true });
      expect(effects).toEqual([{ q: "x" }]);
    });

    it("runs the ordinary boundary: an unclassified tool refuses before any effect", async () => {
      const { call, effects } = leafFor(pinnedIdentity(), {}, UNCLASSIFIED);
      await expect(call()).rejects.toThrow("action_ordinary_authorization_denied");
      expect(effects).toEqual([]);
    });

    it("keeps the step's tool offer: an undeclared tool name refuses before any effect", async () => {
      h.declared = ["another_tool"];
      try {
        const { call, effects } = leafFor(pinnedIdentity(), {});
        await expect(call()).rejects.toThrow("step_tool_not_declared");
        expect(effects).toEqual([]);
      } finally {
        h.declared = ["example_write_tool", "example_unclassified_tool", "email_send"];
      }
    });

    it.each([
      ["a declared outward registration", { outward: {} }],
      ["an unreadable registration", null],
    ])("refuses %s before any effect", async (_label, registration) => {
      const { call, effects } = leafFor(pinnedIdentity(), registration);
      await expect(call()).rejects.toThrow("action_checker_missing_or_ambiguous");
      expect(effects).toEqual([]);
    });

    it("refuses a tool the boundary names as outward before any effect", async () => {
      const { OUTWARD_EFFECT_TOOL_NAMES } = await import("@/lib/authz/mcp-boundary");
      expect(OUTWARD_EFFECT_TOOL_NAMES.has("email_send")).toBe(true);
      const { call, effects } = leafFor(pinnedIdentity(), {}, "email_send");
      await expect(call()).rejects.toThrow();
      expect(effects).toEqual([]);
    });

    it("sets the pinned owner only inside the effect", async () => {
      const identity = pinnedIdentity();
      const { call, owners } = leafFor(identity, {});
      await call();
      expect(owners).toEqual([expect.objectContaining({ packageName: PKG, installId: identity.installId, toolName: TOOL, wrapper: "primitive" })]);
      expect(owners[0]).not.toHaveProperty("unpinned");
      await mcpRequestContextStorage.run(runFrame(), async () => expect(currentGuardedActionOwner()).toBeUndefined());
    });
  });

  describe("no current loaded identity (legacy, dev, bundled or stale)", () => {
    it.each([
      ["no identity", () => undefined],
      ["a stale identity", () => staleOf(pinnedIdentity())],
    ])("serves a non-outward call under an unpinned owner (%s)", async (_label, make) => {
      const { call, effects, owners } = leafFor(make(), {});
      await expect(call()).resolves.toEqual({ served: true });
      expect(effects).toEqual([{ q: "x" }]);
      expect(owners).toEqual([expect.objectContaining({ unpinned: true, toolName: TOOL, wrapper: "primitive" })]);
    });

    it.each([
      ["no identity, declared outward", () => undefined, { outward: {} }, TOOL],
      ["a stale identity, declared outward", () => staleOf(pinnedIdentity()), { outward: {} }, TOOL],
      ["no identity, unreadable registration", () => undefined, null, TOOL],
      ["no identity, a named outward tool", () => undefined, {}, "email_send"],
    ] as const)("refuses an outward call before any effect (%s)", async (_label, make, registration, name) => {
      const { call, effects } = leafFor(make(), registration as Record<string, unknown> | null, name);
      await expect(call()).rejects.toThrow("action_loaded_identity_missing_or_stale");
      expect(effects).toEqual([]);
    });

    it("an unpinned owner still takes the executed-source fence", async () => {
      h.sourceCurrent = false;
      const { call, effects } = leafFor(undefined, {});
      await expect(call()).rejects.toThrow("action_executed_source_missing_or_stale");
      expect(effects).toEqual([]);
    });
  });

  describe("the executed-source fence", () => {
    it.each([
      ["not current", false],
      ["unreadable", "throw"],
    ] as const)("refuses a pinned non-outward call when the source is %s", async (_label, state) => {
      h.sourceCurrent = state;
      const { call, effects } = leafFor(pinnedIdentity(), {});
      await expect(call()).rejects.toThrow();
      expect(effects).toEqual([]);
    });
  });

  describe("an extension's own provider still decides for its identity", () => {
    function withProviders(identity: LoadedExtensionIdentity, impls: unknown[]) {
      const bound = impls.map((impl) => bindLoadedCapabilityProvider({ packageName: PKG, impl }, identity, "artifact-action-check/v1"));
      vi.spyOn(registryModule, "resolveCapabilityProviders").mockReturnValue(bound as never);
    }
    const reading = (kind: unknown) => ({ classify: () => ({ kind }), check: () => ({ kind: "refused", reason: "x" }) });

    it("two providers refuse a non-outward call", async () => {
      const identity = pinnedIdentity();
      withProviders(identity, [reading("read-only"), reading("read-only")]);
      const { call, effects } = leafFor(identity, {});
      await expect(call()).rejects.toThrow("action_checker_missing_or_ambiguous");
      expect(effects).toEqual([]);
    });

    it("its outward reading holds a non-outward call for the person gate", async () => {
      const identity = pinnedIdentity();
      withProviders(identity, [reading("outward")]);
      const { call, effects } = leafFor(identity, {});
      await expect(call()).rejects.toThrow();
      expect(effects).toEqual([]);
    });

    it("its read-only reading serves the call once", async () => {
      const identity = pinnedIdentity();
      withProviders(identity, [reading("read-only")]);
      const { call, effects } = leafFor(identity, {});
      await expect(call()).resolves.toEqual({ served: true });
      expect(effects).toHaveLength(1);
    });

    it("an unknown reading refuses", async () => {
      const identity = pinnedIdentity();
      withProviders(identity, [reading("garbage")]);
      const { call, effects } = leafFor(identity, {});
      await expect(call()).rejects.toThrow("action_classification_incompatible");
      expect(effects).toEqual([]);
    });
  });
});
