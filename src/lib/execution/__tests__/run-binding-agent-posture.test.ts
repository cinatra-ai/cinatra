// The per-agent execution POSTURE arm of the run-seam matrix (exec-plane S3
// slice B, cinatra#1708).
//
// The config surface refuses to author "execution off" together with a declared
// environment. This suite covers the defence-in-depth arm for a declaration that
// arrives some other way (a packaged manifest, a pinned version snapshot): the
// run REFUSES rather than quietly running the agent without the packages it
// declared it cannot work without.

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

function registerReady(over: Partial<ExecutionEnvironmentServiceSlot> = {}) {
  const state: ExecutionServiceState = "ready";
  registerExecutionEnvironmentService({
    state,
    resolveRunExecutionMount: async () => fakeMount,
    getRunExecutionExecutor: () => fakeExecutor,
    ...over,
  });
}

afterEach(() => {
  registerExecutionEnvironmentService({ state: "unavailable" });
});

describe("per-agent execution posture at the run seam", () => {
  it("an agent explicitly OFF with a declared environment → refuse (environment_agent_disabled)", async () => {
    registerReady();
    const r = await resolveRunExecutionBinding({
      liveTemplateEnvironment: { pip: ["pandas"] },
      executionEnabled: false,
      orgId: "o",
      holder: {},
    });
    expect(r.kind).toBe("refuse");
    expect(r.kind === "refuse" && r.auditReason).toBe("environment_agent_disabled");
    expect(r.kind === "refuse" && r.detail).toMatch(/opted out of execution/i);
  });

  it("an agent explicitly OFF with NO declared environment → L0, exactly as before", async () => {
    registerReady();
    expect(
      await resolveRunExecutionBinding({ executionEnabled: false, orgId: "o", holder: {} }),
    ).toEqual({ kind: "l0" });
  });

  it("posture INHERIT (null/absent) is byte-identical to the pre-slice-B behaviour", async () => {
    registerReady();
    const inherited = await resolveRunExecutionBinding({
      liveTemplateEnvironment: { pip: ["pandas"] },
      executionEnabled: null,
      orgId: "o",
      holder: {},
    });
    const absent = await resolveRunExecutionBinding({
      liveTemplateEnvironment: { pip: ["pandas"] },
      orgId: "o",
      holder: {},
    });
    expect(inherited.kind).toBe("mount");
    expect(absent.kind).toBe("mount");
  });

  it("posture ON mounts the declared layer", async () => {
    registerReady();
    const r = await resolveRunExecutionBinding({
      liveTemplateEnvironment: { pip: ["pandas"] },
      executionEnabled: true,
      orgId: "o",
      holder: {},
    });
    expect(r.kind).toBe("mount");
  });

  it("an OFF agent whose PINNED SNAPSHOT declares an environment is refused too", async () => {
    registerReady();
    const r = await resolveRunExecutionBinding({
      pinnedSnapshot: { executionEnvironment: { os: ["pandoc"] } },
      executionEnabled: false,
      orgId: "o",
      holder: {},
    });
    expect(r.kind === "refuse" && r.auditReason).toBe("environment_agent_disabled");
  });
});
