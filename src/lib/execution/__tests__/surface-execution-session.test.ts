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
import { resolveSurfaceExecutionBinding } from "@/lib/execution/surface-execution-session";

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
