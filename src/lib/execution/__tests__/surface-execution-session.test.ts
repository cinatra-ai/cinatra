// Unit tests for the trusted surface-layer execution-session issuer (exec-plane
// S1b activation, cinatra#2138 deliverable 2).
//
// Proves the three postures both entry paths inherit: byte-identical inertness
// with the flag off, the #1192 run binding carried (never re-invented) for an
// agent run, and the fail-closed no-session / no-executor split that keeps the
// model usable either way.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetExecutionExecutorFactoryForTests,
  registerExecutionExecutorFactory,
} from "@/lib/execution/environment-execution-service";
import {
  observeSurfaceExecutionDispatches,
  resolveSurfaceExecutionBinding,
} from "@/lib/execution/surface-execution-session";

const executor = async () => [];

beforeEach(() => {
  _resetExecutionExecutorFactoryForTests();
});

afterEach(() => {
  _resetExecutionExecutorFactoryForTests();
});

describe("surface execution-session issuance", () => {
  it("flag off ⇒ an EMPTY binding, so every call site stays byte-identical", () => {
    registerExecutionExecutorFactory(() => executor);
    expect(
      resolveSurfaceExecutionBinding({
        surface: "chat",
        orgId: "org-1",
        userId: "user-1",
        rolloutOverride: "off",
      }),
    ).toEqual({});
    expect(
      resolveSurfaceExecutionBinding({
        surface: "chat",
        orgId: "org-1",
        userId: "user-1",
        rolloutOverride: undefined,
      }),
    ).toEqual({});
  });

  it("chat: mints a session with NO run binding", () => {
    registerExecutionExecutorFactory(() => executor);
    const binding = resolveSurfaceExecutionBinding({
      surface: "chat",
      orgId: "org-1",
      userId: "user-1",
      rolloutOverride: "on",
    });
    expect(binding.executionSession).toEqual({
      orgId: "org-1",
      userId: "user-1",
      surface: "chat",
    });
    expect(binding.executionSession).not.toHaveProperty("runId");
    expect(binding.executionExecutor).toBe(executor);
  });

  it("agent run: carries the caller's already-verified run id into the session", () => {
    registerExecutionExecutorFactory(() => executor);
    const binding = resolveSurfaceExecutionBinding({
      surface: "agent_run",
      orgId: "org-1",
      userId: "run-owner",
      runId: "run-42",
      rolloutOverride: "on",
    });
    expect(binding.executionSession).toEqual({
      orgId: "org-1",
      userId: "run-owner",
      surface: "agent_run",
      runId: "run-42",
    });
  });

  it("unattributable caller ⇒ NO session (the injection layer emits `no_session`)", () => {
    registerExecutionExecutorFactory(() => executor);
    for (const identity of [
      { orgId: null, userId: "user-1" },
      { orgId: "org-1", userId: null },
      { orgId: "  ", userId: "user-1" },
      { orgId: undefined, userId: undefined },
    ]) {
      const binding = resolveSurfaceExecutionBinding({
        surface: "agent_run",
        ...identity,
        rolloutOverride: "on",
      });
      expect(binding.executionSession).toBeUndefined();
      // The executor is still offered — the two failure modes stay distinguishable.
      expect(binding.executionExecutor).toBe(executor);
    }
  });

  it("plane not wired ⇒ session but NO executor (`capability_unavailable`)", () => {
    const binding = resolveSurfaceExecutionBinding({
      surface: "chat",
      orgId: "org-1",
      userId: "user-1",
      rolloutOverride: "on",
    });
    expect(binding.executionSession).toBeDefined();
    expect(binding.executionExecutor).toBeUndefined();
  });

  it("never throws, whatever the identity", () => {
    expect(() =>
      resolveSurfaceExecutionBinding({
        surface: "chat",
        orgId: "",
        userId: "",
        rolloutOverride: "on",
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Dispatch observation (cinatra#2175) — the provenance signal a surface needs
// before it can honestly render a turn that claims code ran.
// ---------------------------------------------------------------------------

describe("surface execution-dispatch observation", () => {
  it("no executor: the binding comes back UNCHANGED with a zero log", () => {
    const binding = resolveSurfaceExecutionBinding({
      surface: "chat",
      orgId: "org-1",
      userId: "user-1",
      rolloutOverride: "on",
    });
    const observed = observeSurfaceExecutionDispatches(binding);
    expect(observed.binding).toBe(binding);
    expect(observed.readLog()).toEqual({ attempted: 0, executed: 0, refused: 0 });
  });

  it("flag off: the empty binding is passed through untouched", () => {
    const observed = observeSurfaceExecutionDispatches(
      resolveSurfaceExecutionBinding({
        surface: "chat",
        orgId: "org-1",
        userId: "user-1",
        rolloutOverride: "off",
      }),
    );
    expect(observed.binding).toEqual({});
    expect(observed.readLog()).toEqual({ attempted: 0, executed: 0, refused: 0 });
  });

  it("counts each executed dispatch and passes input/outputs through verbatim", async () => {
    const seen: unknown[] = [];
    const outputs = [
      { stdout: "ok", stderr: "", outcome: { type: "exit", exitCode: 0 } },
    ];
    registerExecutionExecutorFactory(() => async (input) => {
      seen.push(input);
      return outputs as never;
    });
    const observed = observeSurfaceExecutionDispatches(
      resolveSurfaceExecutionBinding({
        surface: "chat",
        orgId: "org-1",
        userId: "user-1",
        rolloutOverride: "on",
      }),
    );
    const call = { sessionCarrier: "v1.x.y" as never, commands: ["echo hi"] };
    const returned = await observed.binding.executionExecutor!(call);
    expect(returned).toBe(outputs);
    expect(seen).toEqual([call]);
    expect(observed.readLog()).toEqual({ attempted: 1, executed: 1, refused: 0 });

    await observed.binding.executionExecutor!(call);
    expect(observed.readLog()).toEqual({ attempted: 2, executed: 2, refused: 0 });
  });

  it("a PLANE REFUSAL is attempted but NOT executed (nothing ran, no audit row)", async () => {
    // The broker executor never throws: a refused open / refused command comes
    // back as an ordinary non-zero-exit output. Counting resolution alone would
    // read that as proof of execution.
    registerExecutionExecutorFactory(() => async () => [
      {
        stdout: "",
        stderr: "The execution plane refused to open a job",
        outcome: { type: "exit", exitCode: 126 },
        refusedByPlane: true,
      },
    ] as never);
    const observed = observeSurfaceExecutionDispatches(
      resolveSurfaceExecutionBinding({
        surface: "chat",
        orgId: "org-1",
        userId: "user-1",
        rolloutOverride: "on",
      }),
    );
    await observed.binding.executionExecutor!({
      sessionCarrier: "v1.x.y" as never,
      commands: ["echo hi"],
    });
    expect(observed.readLog()).toEqual({ attempted: 1, executed: 0, refused: 1 });
  });

  it("a batch that ran at least one command COUNTS, even with a refused sibling", async () => {
    registerExecutionExecutorFactory(() => async () => [
      {
        stdout: "",
        stderr: "The execution plane refused the command",
        outcome: { type: "exit", exitCode: 126 },
        refusedByPlane: true,
      },
      { stdout: "hi", stderr: "", outcome: { type: "exit", exitCode: 0 } },
    ] as never);
    const observed = observeSurfaceExecutionDispatches(
      resolveSurfaceExecutionBinding({
        surface: "chat",
        orgId: "org-1",
        userId: "user-1",
        rolloutOverride: "on",
      }),
    );
    await observed.binding.executionExecutor!({
      sessionCarrier: "v1.x.y" as never,
      commands: ["a", "b"],
    });
    expect(observed.readLog()).toEqual({ attempted: 1, executed: 1, refused: 0 });
  });

  it("an EMPTY batch ran nothing", async () => {
    registerExecutionExecutorFactory(() => async () => [] as never);
    const observed = observeSurfaceExecutionDispatches(
      resolveSurfaceExecutionBinding({
        surface: "chat",
        orgId: "org-1",
        userId: "user-1",
        rolloutOverride: "on",
      }),
    );
    await observed.binding.executionExecutor!({
      sessionCarrier: "v1.x.y" as never,
      commands: [],
    });
    expect(observed.readLog()).toEqual({ attempted: 1, executed: 0, refused: 0 });
  });

  it("a REJECTED dispatch is attempted but NOT executed (no audit row to point at)", async () => {
    registerExecutionExecutorFactory(() => async () => {
      throw new Error("broker refused");
    });
    const observed = observeSurfaceExecutionDispatches(
      resolveSurfaceExecutionBinding({
        surface: "chat",
        orgId: "org-1",
        userId: "user-1",
        rolloutOverride: "on",
      }),
    );
    await expect(
      observed.binding.executionExecutor!({
        sessionCarrier: "v1.x.y" as never,
        commands: ["boom"],
      }),
    ).rejects.toThrow("broker refused");
    expect(observed.readLog()).toEqual({ attempted: 1, executed: 0, refused: 0 });
  });

  it("wrapping does not disturb the rest of the binding (session carried as minted)", () => {
    registerExecutionExecutorFactory(() => executor);
    const binding = resolveSurfaceExecutionBinding({
      surface: "chat",
      orgId: "org-1",
      userId: "user-1",
      rolloutOverride: "on",
    });
    const observed = observeSurfaceExecutionDispatches(binding);
    expect(observed.binding.executionSession).toBe(binding.executionSession);
    expect(observed.binding.executionExecutor).not.toBe(executor);
  });
});
