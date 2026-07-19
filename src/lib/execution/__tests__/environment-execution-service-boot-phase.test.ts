// Unit tests for the environment-execution-service boot phase (exec-plane S3 A2,
// cinatra#1708). Proves the tri-state registration + policy: `disabled` for
// today's instances (skipped, byte-unchanged), `unavailable` for an opted-in
// instance that cannot instantiate (declared-env runs fail closed; a REQUIRED
// class makes it deploy-blocking), and the phase is never `fatal`.

import { afterEach, describe, expect, it } from "vitest";

import { runBootPhase } from "@/lib/boot/boot-phase";
import { __resetBootStateForTests } from "@/lib/boot/boot-state";
import {
  ENVIRONMENT_EXECUTION_SERVICE_PHASE,
  environmentExecutionServicePhases,
} from "@/lib/boot/phases/environment-execution-service";
import {
  getExecutionServiceState,
  registerExecutionEnvironmentService,
} from "@/lib/execution/register-execution-environment-service";
import { PROVENANCE_KEY_ENV } from "@/lib/execution/environment-execution-service";

afterEach(() => {
  __resetBootStateForTests();
  registerExecutionEnvironmentService({ state: "unavailable" });
});

describe("environment-execution-service boot phase", () => {
  it("disabled (skipped) + registers the disabled slot when not opted in", async () => {
    __resetBootStateForTests();
    const [phase] = environmentExecutionServicePhases({});
    expect(phase.name).toBe(ENVIRONMENT_EXECUTION_SERVICE_PHASE);
    expect(phase.policy).toBe("retryable");
    await runBootPhase(phase);
    expect(getExecutionServiceState()).toBe("disabled");
  });

  it("unavailable (registered) + retryable when opted in without a provenance key, not required", async () => {
    __resetBootStateForTests();
    const [phase] = environmentExecutionServicePhases({ EXECUTION_BROKER_URL: "https://b", EXECUTION_BROKER_SECRET: "s" });
    expect(phase.policy).toBe("retryable");
    await runBootPhase(phase);
    // No provenance key + no executor factory → fail-closed unavailable.
    expect(getExecutionServiceState()).toBe("unavailable");
  });

  it("degraded policy + THROWS (deploy-blocking) when REQUIRED but unavailable", async () => {
    __resetBootStateForTests();
    const env = { EXECUTION_PLANE_REQUIRED: "1", [PROVENANCE_KEY_ENV]: "" };
    const [phase] = environmentExecutionServicePhases(env);
    expect(phase.policy).toBe("degraded");
    // The phase throws (a degraded-policy failure is deploy-visible); the slot
    // is still registered unavailable so declared-env runs fail closed.
    await expect(Promise.resolve(phase.run())).rejects.toThrow(/deploy-blocking/);
    expect(getExecutionServiceState()).toBe("unavailable");
  });
});
