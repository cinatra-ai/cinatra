/**
 * The host's in-tree `artifact-action-check/v1` provider (cinatra#3745).
 *
 * On an agent run's frame a guarded leaf the host reads as outward (a named
 * tool, or a declared or unreadable declaration) needs exactly one CHECK
 * provider for the loaded identity that executes. Without one from the
 * extension, the in-tree provider admits only a digest-pinned install's
 * primitive whose bound registration declares the read class. A call the host
 * does not read as outward needs no CHECK, as on main (the same posture): an
 * undeclared tool, a legacy or dev load and a stale load are served behind the
 * source and step fences. Two providers, or an extension's own outward reading,
 * still refuse.
 *
 * These cases drive the real guarded leaf (`bindArtifactGuardedMcpHandler` ->
 * `withGuardedRunActionInvocation`), the real capability registry, the real
 * provider resolution and the real boundary prerequisites. The audit writer,
 * the classification reader and the run store are test doubles.
 */
import "server-only";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cinatra-ai/agents/store", () => ({
  parseRunStepToolPolicy: (p: unknown) => p,
  assertRunStepToolAllowed: () => ({ kind: "undeclared" }),
  readRunStepToolPolicy: async () => ({}),
  isRunExecutedSourceCurrent: async () => true,
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
import { bindArtifactGuardedMcpHandler } from "@/lib/extension-host-context";
import { mcpRequestContextStorage, type McpRequestContext } from "@cinatra-ai/mcp-server/request-context";

const PKG = "@example-org/read-pack";
const TOOL = "example_read_tool";
const FIXTURE_CLASSIFICATION = { resourceType: "agent_run", action: "execute", status: "enforced" } as const;
const MISSING = "action_checker_missing_or_ambiguous";
const proof = {
  contextId: "ctx", stepId: "step", executionAttemptId: "attempt",
  sourceSha256: "a".repeat(64), executedSourceSha256: "b".repeat(64), declarationSourceSha256: "c".repeat(64),
};
const runFrame = (): McpRequestContext =>
  ({
    runId: "run", orgId: "org", userId: "person",
    verifiedStepId: "step", verifiedExecutedSource: proof,
  }) as unknown as McpRequestContext;

let installSeq = 0;
/** A digest-pinned install: the identity the host's loader stamps from a verified install id and digest. */
function pinnedIdentity(): LoadedExtensionIdentity {
  installSeq += 1;
  return recordLoadedExtensionIdentity({
    packageName: PKG, version: "1.0.0", installId: `install-${installSeq}`, digest: "f".repeat(64),
  });
}

function leafFor(identity: LoadedExtensionIdentity | undefined, registration: Record<string, unknown> | undefined) {
  const effects: unknown[] = [];
  const leaf = bindArtifactGuardedMcpHandler(TOOL, async (input: unknown) => {
    effects.push(input);
    return { served: true };
  }, identity, registration === undefined ? undefined : { name: TOOL, ...registration });
  const call = (input: unknown = { q: "x" }) => mcpRequestContextStorage.run(runFrame(), () => leaf(input));
  return { call, effects };
}

describe("the in-tree artifact-action-check/v1 provider on a run's frame", () => {
  let spies: { mockRestore: () => void }[] = [];
  beforeEach(() => {
    const realLookup = augmentModule.lookupPrimitiveClassification;
    spies = [
      vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined),
      vi.spyOn(augmentModule, "lookupPrimitiveClassification").mockImplementation((name: string) =>
        name === TOOL ? { ...FIXTURE_CLASSIFICATION } : realLookup(name)),
    ];
  });
  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    vi.restoreAllMocks();
  });

  it("admits a digest-pinned install's tool whose registration declares the read class, with no provider of its own", async () => {
    const { call, effects } = leafFor(pinnedIdentity(), { delegatedChat: "read" });
    await expect(call({ q: "x" })).resolves.toEqual({ served: true });
    expect(effects).toEqual([{ q: "x" }]);
  });

  it("refuses a digest-pinned tool that declares outward, even with the read class", async () => {
    const { call, effects } = leafFor(pinnedIdentity(), { delegatedChat: "read", outward: {} });
    await expect(call()).rejects.toThrow(MISSING);
    expect(effects).toEqual([]);
  });

  it("serves a digest-pinned tool that declares no class and is not outward, as on main", async () => {
    const { call, effects } = leafFor(pinnedIdentity(), {});
    await expect(call()).resolves.toEqual({ served: true });
    expect(effects).toEqual([{ q: "x" }]);
  });

  it("serves a digest-pinned tool bound without a registration, as on main", async () => {
    const { call, effects } = leafFor(pinnedIdentity(), undefined);
    await expect(call()).resolves.toEqual({ served: true });
    expect(effects).toEqual([{ q: "x" }]);
  });

  it.each([
    ["discovery", { delegatedChat: "discovery" }],
    ["dispatch", { delegatedChat: "dispatch" }],
    ["none", { delegatedChat: "none" }],
    ["a malformed class", { delegatedChat: "READ" }],
    ["readOnlyHint false", { delegatedChat: "read", annotations: { readOnlyHint: false } }],
    ["destructiveHint true", { delegatedChat: "read", annotations: { destructiveHint: true } }],
  ])("serves a digest-pinned, non-outward tool declaring %s, as on main", async (_label, registration) => {
    const { call, effects } = leafFor(pinnedIdentity(), registration);
    await expect(call()).resolves.toEqual({ served: true });
    expect(effects).toEqual([{ q: "x" }]);
  });

  it("the same identity bound once as read and once as outward: the read leaf serves, the outward leaf refuses", async () => {
    const identity = pinnedIdentity();
    const read = leafFor(identity, { delegatedChat: "read" });
    const outward = leafFor(identity, { delegatedChat: "read", outward: {} });
    await expect(read.call()).resolves.toEqual({ served: true });
    expect(read.effects).toEqual([{ q: "x" }]);
    await expect(outward.call()).rejects.toThrow(MISSING);
    expect(outward.effects).toEqual([]);
  });

  it("a digest-pinned read tool named by the boundary's outward list still needs the person's gate", async () => {
    const { OUTWARD_EFFECT_TOOL_NAMES } = await import("@/lib/authz/mcp-boundary");
    const name = [...OUTWARD_EFFECT_TOOL_NAMES][0]!;
    const identity = pinnedIdentity();
    const effects: unknown[] = [];
    const leaf = bindArtifactGuardedMcpHandler(name, async (input: unknown) => {
      effects.push(input);
      return { served: true };
    }, identity, { name, delegatedChat: "read" });
    await expect(mcpRequestContextStorage.run(runFrame(), () => leaf({}))).rejects.toThrow();
    expect(effects).toEqual([]);
  });

  it("serves a legacy or dev load with no loaded identity when the call is not outward", async () => {
    const { call, effects } = leafFor(undefined, { delegatedChat: "read" });
    await expect(call()).resolves.toEqual({ served: true });
    expect(effects).toEqual([{ q: "x" }]);
  });

  it("refuses a legacy or dev load with no loaded identity when the call is outward", async () => {
    const { call, effects } = leafFor(undefined, { delegatedChat: "read", outward: {} });
    await expect(call()).rejects.toThrow("action_loaded_identity_missing_or_stale");
    expect(effects).toEqual([]);
  });

  it("never stamps a loaded identity without an install id or a digest", () => {
    expect(() => recordLoadedExtensionIdentity({ packageName: PKG, version: "1.0.0", installId: "", digest: "f".repeat(64) }))
      .toThrow("action_loaded_identity_invalid");
    expect(() => recordLoadedExtensionIdentity({ packageName: PKG, version: "1.0.0", installId: "install", digest: "" }))
      .toThrow("action_loaded_identity_invalid");
  });

  it("serves a non-outward read tool whose identity is no longer the current one, under an unpinned owner", async () => {
    const identity = pinnedIdentity();
    const stale = { ...identity, generation: identity.generation + 1000 };
    const { call, effects } = leafFor(stale as LoadedExtensionIdentity, { delegatedChat: "read" });
    await expect(call()).resolves.toEqual({ served: true });
    expect(effects).toEqual([{ q: "x" }]);
  });

  it("refuses an outward tool whose identity is no longer the current one", async () => {
    const identity = pinnedIdentity();
    const stale = { ...identity, generation: identity.generation + 1000 };
    const { call, effects } = leafFor(stale as LoadedExtensionIdentity, { outward: {} });
    await expect(call()).rejects.toThrow("action_loaded_identity_missing_or_stale");
    expect(effects).toEqual([]);
  });

  it("refuses with two providers for the identity, even for a read tool", async () => {
    const identity = pinnedIdentity();
    const impl = () => ({ classify: () => ({ kind: "read-only" }), check: () => ({ kind: "refused", reason: "x" }) });
    const two = [
      bindLoadedCapabilityProvider({ packageName: PKG, impl: impl() }, identity, "artifact-action-check/v1"),
      bindLoadedCapabilityProvider({ packageName: PKG, impl: impl() }, identity, "artifact-action-check/v1"),
    ];
    vi.spyOn(registryModule, "resolveCapabilityProviders").mockReturnValue(two as never);
    const { call, effects } = leafFor(identity, { delegatedChat: "read" });
    await expect(call()).rejects.toThrow(MISSING);
    expect(effects).toEqual([]);
  });

  it("an extension's own provider decides for its identity: its outward reading holds a read-declared tool", async () => {
    const identity = pinnedIdentity();
    const own = bindLoadedCapabilityProvider({ packageName: PKG,
      impl: { classify: () => ({ kind: "outward" }), check: () => ({ kind: "refused", reason: "x" }) } },
    identity, "artifact-action-check/v1");
    vi.spyOn(registryModule, "resolveCapabilityProviders").mockReturnValue([own] as never);
    const { call, effects } = leafFor(identity, { delegatedChat: "read" });
    await expect(call()).rejects.toThrow();
    expect(effects).toEqual([]);
  });
});
