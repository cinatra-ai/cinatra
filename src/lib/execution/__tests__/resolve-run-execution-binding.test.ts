// Unit tests for the A2 run-seam fail-closed decision matrix (exec-plane S3,
// cinatra#1708 §1.1). Proves: no declared env → L0; an invalid declaration →
// refuse; a declared env with the service not `ready` → refuse (never a silent
// L0 downgrade); a declared env + `ready` → mount; and the impossible
// no-environment build result → refuse.

import { afterEach, describe, expect, it } from "vitest";

import type { SandboxEnvironmentMount, SandboxExecutor } from "@cinatra-ai/llm";
import { resolveRunExecutionBinding } from "@/lib/execution/resolve-run-execution-binding";
import {
  registerExecutionEnvironmentService,
  type ExecutionEnvironmentServiceSlot,
  type ExecutionServiceState,
} from "@/lib/execution/register-execution-environment-service";

const fakeExecutor: SandboxExecutor = async () => [];
const fakeMount: SandboxEnvironmentMount = { imageRef: "cinatra-sandbox-l1:r", provenance: {} };

function register(state: ExecutionServiceState, over: Partial<ExecutionEnvironmentServiceSlot> = {}) {
  registerExecutionEnvironmentService({ state, ...over });
}

afterEach(() => {
  // Reset the slot to the fail-closed default for the next test.
  registerExecutionEnvironmentService({ state: "unavailable" });
});

describe("resolveRunExecutionBinding matrix", () => {
  it("no declared environment → L0 (regardless of state)", async () => {
    register("disabled");
    expect(await resolveRunExecutionBinding({ orgId: "o", holder: {} })).toEqual({ kind: "l0" });
    register("ready", {
      resolveRunExecutionMount: async () => fakeMount,
      getRunExecutionExecutor: () => fakeExecutor,
    });
    expect(
      await resolveRunExecutionBinding({ liveTemplateEnvironment: null, orgId: "o", holder: {} }),
    ).toEqual({ kind: "l0" });
  });

  it("an invalid declaration → refuse (environment_invalid)", async () => {
    register("ready", {
      resolveRunExecutionMount: async () => fakeMount,
      getRunExecutionExecutor: () => fakeExecutor,
    });
    const r = await resolveRunExecutionBinding({
      liveTemplateEnvironment: { pip: "not-an-array" },
      orgId: "o",
      holder: {},
    });
    expect(r.kind).toBe("refuse");
    expect(r.kind === "refuse" && r.auditReason).toBe("environment_invalid");
  });

  it("declared env + service DISABLED → refuse (never a silent L0)", async () => {
    register("disabled");
    const r = await resolveRunExecutionBinding({
      liveTemplateEnvironment: { pip: ["pandas"] },
      orgId: "o",
      holder: {},
    });
    expect(r.kind).toBe("refuse");
    expect(r.kind === "refuse" && r.auditReason).toBe("environment_unavailable");
  });

  it("declared env + service UNAVAILABLE → refuse", async () => {
    register("unavailable");
    const r = await resolveRunExecutionBinding({
      liveTemplateEnvironment: { pip: ["pandas"] },
      orgId: "o",
      holder: {},
    });
    expect(r.kind).toBe("refuse");
    expect(r.kind === "refuse" && r.auditReason).toBe("environment_unavailable");
  });

  it("declared env + READY + mount resolved → mount (executor + environment supplied)", async () => {
    register("ready", {
      resolveRunExecutionMount: async () => fakeMount,
      getRunExecutionExecutor: () => fakeExecutor,
    });
    const r = await resolveRunExecutionBinding({
      liveTemplateEnvironment: { pip: ["pandas"] },
      orgId: "o",
      holder: { templateId: "t1" },
    });
    expect(r).toEqual({ kind: "mount", executor: fakeExecutor, environment: fakeMount });
  });

  it("declared env + READY but the resolver returns undefined (impossible) → refuse", async () => {
    register("ready", {
      resolveRunExecutionMount: async () => undefined,
      getRunExecutionExecutor: () => fakeExecutor,
    });
    const r = await resolveRunExecutionBinding({
      liveTemplateEnvironment: { pip: ["pandas"] },
      orgId: "o",
      holder: {},
    });
    expect(r.kind).toBe("refuse");
    expect(r.kind === "refuse" && r.auditReason).toBe("environment_unavailable");
  });

  it("a PINNED snapshot's environment is used exclusively (never the live template)", async () => {
    register("ready", {
      resolveRunExecutionMount: async () => fakeMount,
      getRunExecutionExecutor: () => fakeExecutor,
    });
    // Pinned snapshot declared NO env → L0, even though the live template declared one.
    const r = await resolveRunExecutionBinding({
      pinnedSnapshot: { executionEnvironment: null },
      liveTemplateEnvironment: { pip: ["pandas"] },
      orgId: "o",
      holder: {},
    });
    expect(r).toEqual({ kind: "l0" });
  });

  it("a PACKAGED MANIFEST declaration binds a mount (the #1705 fail-open, inverted)", async () => {
    register("ready", {
      resolveRunExecutionMount: async () => fakeMount,
      getRunExecutionExecutor: () => fakeExecutor,
    });
    // The template row declares nothing (on `main` it cannot — the column is a
    // later slice); the PACKAGE's manifest is where a packaged agent declares.
    const r = await resolveRunExecutionBinding({
      packagedManifestEnvironment: { pip: ["pandas==2.2.1"] },
      liveTemplateEnvironment: undefined,
      orgId: "o",
      holder: { packageName: "@acme/agent" },
    });
    expect(r).toEqual({ kind: "mount", executor: fakeExecutor, environment: fakeMount });
  });

  it("a PACKAGED MANIFEST declaration that cannot be honored REFUSES (never L0)", async () => {
    register("disabled");
    const r = await resolveRunExecutionBinding({
      packagedManifestEnvironment: { pip: ["pandas==2.2.1"] },
      liveTemplateEnvironment: undefined,
      orgId: "o",
      holder: { packageName: "@acme/agent" },
    });
    expect(r.kind).toBe("refuse");
    expect(r.kind === "refuse" && r.auditReason).toBe("environment_unavailable");
  });

  it("an UNREADABLE declaration source refuses — UNKNOWN is not 'declared nothing'", async () => {
    register("ready", {
      resolveRunExecutionMount: async () => fakeMount,
      getRunExecutionExecutor: () => fakeExecutor,
    });
    const r = await resolveRunExecutionBinding({
      declarationUnreadable: { detail: "store read failed" },
      orgId: "o",
      holder: {},
    });
    expect(r.kind).toBe("refuse");
    expect(r.kind === "refuse" && r.auditReason).toBe("environment_declaration_unreadable");
    expect(r.kind === "refuse" && r.detail).toBe("store read failed");
  });

  it("an UNDECLARED run stays L0 with every source supplied (byte-identical)", async () => {
    register("ready", {
      resolveRunExecutionMount: async () => fakeMount,
      getRunExecutionExecutor: () => fakeExecutor,
    });
    expect(
      await resolveRunExecutionBinding({
        packagedManifestEnvironment: null,
        pinnedSnapshot: null,
        declarationUnreadable: null,
        liveTemplateEnvironment: undefined,
        orgId: "o",
        holder: {},
      }),
    ).toEqual({ kind: "l0" });
  });
});
