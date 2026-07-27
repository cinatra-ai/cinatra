// Unit tests for the execution-broker boot phase (exec-plane S1b activation,
// cinatra#2138 deliverables 1 + 5; ACs 1 + 3).
//
// AC1 (the pinned inertness test) is the first describe block: with the
// default-off ROLLOUT flag unset the phase list is EMPTY, nothing registers an
// executor factory, and every environment's readiness stays in the store's
// existing not-ready tri-state value — `disabled` on an instance that never
// opted into the plane, `unavailable` on one that did.
//
// AC3 is the second block: the factory is registered only past a completed
// broker↔worker handshake, and a failed handshake leaves the plane exactly as
// inert as it was.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runBootPhase } from "@/lib/boot/boot-phase";
import { __resetBootStateForTests } from "@/lib/boot/boot-state";
import {
  EXECUTION_BROKER_PHASE,
  executionBrokerPhases,
} from "@/lib/boot/phases/execution-broker";
import {
  _resetExecutionExecutorFactoryForTests,
  PROVENANCE_KEY_ENV,
  resolveExecutionEnvironmentReadiness,
} from "@/lib/execution/environment-execution-service";
import {
  _resetExecutionBrokerStatusForTests,
  getExecutionBrokerStatus,
} from "@/lib/execution/execution-broker-slot";
import type { ExecutionPlaneSettings } from "@/lib/execution/execution-plane-settings";

/** An env that HAS opted into the plane (broker client + provenance key). */
const OPTED_IN_ENV: Record<string, string | undefined> = {
  EXECUTION_BROKER_URL: "https://broker.example",
  EXECUTION_BROKER_SECRET: "broker-secret",
  [PROVENANCE_KEY_ENV]: "provenance-key",
};

let settings: ExecutionPlaneSettings;
let constructResult: { ok: boolean; reason?: string };

vi.mock("@/lib/execution/execution-plane-settings", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/execution/execution-plane-settings")
  >();
  return {
    ...actual,
    readExecutionPlaneSettings: () => settings,
  };
});

vi.mock("@/lib/execution/execution-broker-construct", () => ({
  constructLocalDevExecutionBroker: async () =>
    constructResult.ok
      ? {
          ok: true,
          value: {
            broker: {},
            executor: async () => [],
            handshake: { completedAtMs: 1, imageDigest: "sha256:probe", wallMs: 42 },
            gateway: {
              containerName: "cinatra-exec-gateway",
              proxyPort: 3128,
              adminOrigin: "http://127.0.0.1:3129",
            },
            probeLiveness: async () => ({ ok: true, detail: "up", atMs: 2 }),
            stop: async () => {},
          },
        }
      : { ok: false, reason: constructResult.reason ?? "handshake failed" },
}));

beforeEach(() => {
  settings = { mode: "local-dev", egressMode: "default_internet", egressAllowlist: [] };
  constructResult = { ok: true };
  __resetBootStateForTests();
  _resetExecutionExecutorFactoryForTests();
  _resetExecutionBrokerStatusForTests();
});

afterEach(() => {
  __resetBootStateForTests();
  _resetExecutionExecutorFactoryForTests();
  _resetExecutionBrokerStatusForTests();
});

describe("AC1 — flag unset: the plane is exactly as inert as today", () => {
  it("contributes NO boot phase at all when the ROLLOUT flag is unset", () => {
    expect(executionBrokerPhases({})).toEqual([]);
  });

  it.each([["off"], [""], ["true"], ["1"], ["ON"], ["on "]])(
    "contributes NO boot phase for the near-miss flag value %j",
    (value) => {
      expect(executionBrokerPhases({ CINATRA_EXECUTION_PLANE_ROLLOUT: value })).toEqual([]);
    },
  );

  it("registers NO executor factory, so an OPTED-IN instance's readiness stays `unavailable`", async () => {
    for (const phase of executionBrokerPhases(OPTED_IN_ENV)) await runBootPhase(phase);
    const readiness = resolveExecutionEnvironmentReadiness(OPTED_IN_ENV);
    expect(readiness.state).toBe("unavailable");
    expect(readiness).toMatchObject({ reason: expect.stringContaining("broker-executor") });
  });

  it("leaves a NOT-opted-in instance's readiness at `disabled`", async () => {
    for (const phase of executionBrokerPhases({})) await runBootPhase(phase);
    expect(resolveExecutionEnvironmentReadiness({}).state).toBe("disabled");
  });

  it("leaves the broker status slot at its inert default", async () => {
    for (const phase of executionBrokerPhases(OPTED_IN_ENV)) await runBootPhase(phase);
    expect(getExecutionBrokerStatus().state).toBe("inert");
    expect(getExecutionBrokerStatus().rolloutEnabled).toBe(false);
  });
});

describe("flag on — mode gating", () => {
  const on = { ...OPTED_IN_ENV, CINATRA_EXECUTION_PLANE_ROLLOUT: "on" };

  it("mode `disabled`: skips, wires nothing, readiness stays `unavailable`", async () => {
    settings = { mode: "disabled", egressMode: "none", egressAllowlist: [] };
    const [phase] = executionBrokerPhases(on);
    expect(phase.name).toBe(EXECUTION_BROKER_PHASE);
    await runBootPhase(phase);
    expect(getExecutionBrokerStatus().state).toBe("inert");
    expect(resolveExecutionEnvironmentReadiness(on).state).toBe("unavailable");
  });

  it("mode `remote`: renders in the vocabulary but does NOT activate", async () => {
    settings = { mode: "remote", egressMode: "default_internet", egressAllowlist: [] };
    const [phase] = executionBrokerPhases(on);
    await runBootPhase(phase);
    const status = getExecutionBrokerStatus();
    expect(status.state).toBe("unavailable");
    expect(status.detail).toMatch(/not operable/i);
    expect(resolveExecutionEnvironmentReadiness(on).state).toBe("unavailable");
  });

  it("mode `remote` on a REQUIRED instance class is deploy-blocking", async () => {
    settings = { mode: "remote", egressMode: "default_internet", egressAllowlist: [] };
    const [phase] = executionBrokerPhases({ ...on, EXECUTION_PLANE_REQUIRED: "1" });
    expect(phase.policy).toBe("degraded");
    await expect(Promise.resolve(phase.run())).rejects.toThrow(/not operable/i);
  });
});

describe("AC3 — readiness reports `ready` only after a completed handshake", () => {
  const on = { ...OPTED_IN_ENV, CINATRA_EXECUTION_PLANE_ROLLOUT: "on" };

  it("registers the factory and reports `ready` when the handshake completes", async () => {
    const [phase] = executionBrokerPhases(on);
    await runBootPhase(phase);
    const status = getExecutionBrokerStatus();
    expect(status.state).toBe("running");
    expect(status.handshake).toMatchObject({ imageDigest: "sha256:probe", wallMs: 42 });
    expect(resolveExecutionEnvironmentReadiness(on).state).toBe("ready");
  });

  it("registers NOTHING when the handshake fails — the fail-closed refusal is preserved", async () => {
    constructResult = { ok: false, reason: "handshake command did not complete on a live worker" };
    const [phase] = executionBrokerPhases(on);
    await runBootPhase(phase);
    const status = getExecutionBrokerStatus();
    expect(status.state).toBe("unavailable");
    expect(status.detail).toMatch(/did not complete on a live worker/);
    expect(resolveExecutionEnvironmentReadiness(on).state).toBe("unavailable");
  });

  it("a failed handshake is deploy-blocking on a REQUIRED instance class", async () => {
    constructResult = { ok: false, reason: "docker is unavailable" };
    const [phase] = executionBrokerPhases({ ...on, EXECUTION_PLANE_REQUIRED: "1" });
    expect(phase.policy).toBe("degraded");
    await expect(Promise.resolve(phase.run())).rejects.toThrow(/deploy-blocking/);
    expect(resolveExecutionEnvironmentReadiness(on).state).toBe("unavailable");
  });

  it("is never fatal on a non-required instance class", async () => {
    constructResult = { ok: false, reason: "docker is unavailable" };
    const [phase] = executionBrokerPhases(on);
    expect(phase.policy).toBe("retryable");
    await expect(runBootPhase(phase)).resolves.not.toThrow();
  });
});
