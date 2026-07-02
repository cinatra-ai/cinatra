import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// REAL-SURFACE health-contract test (cinatra#789 item 1): drive the ACTUAL
// boot-phase runner + the ACTUAL process-local boot-state (no mocks) through
// representative outcomes, then invoke the ACTUAL /api/health GET route handler and
// assert the top-level status + HTTP code the deploy gate polls. This proves the
// health contract end to end through the real code path (runBootPhase -> boot-state ->
// health route), which is the acceptance the prod-boot-e2e ALSO enforces at the
// container level (7a).
// ---------------------------------------------------------------------------

import { runBootPhase } from "@/lib/boot/boot-phase";
import {
  __resetBootStateForTests,
  beginBoot,
  markBootReady,
} from "@/lib/boot/boot-state";
import { bootDegradeProbePhases } from "@/lib/boot/phases/boot-degrade-probe";

async function callHealth(): Promise<{ status: number; body: Record<string, unknown> }> {
  const { GET } = await import("../route");
  const res = await GET();
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("/api/health real-surface readiness contract", () => {
  beforeEach(() => {
    __resetBootStateForTests();
    delete process.env.CINATRA_BOOT_E2E;
    delete process.env.CINATRA_BOOT_SIMULATE_DEGRADED;
  });
  afterEach(() => {
    __resetBootStateForTests();
    delete process.env.CINATRA_BOOT_E2E;
    delete process.env.CINATRA_BOOT_SIMULATE_DEGRADED;
  });

  it("a clean boot -> 200 status:ok (deploy gate accepts)", async () => {
    beginBoot();
    markBootReady();
    const { status, body } = await callHealth();
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.degraded).toBe(false);
  });

  it("still-booting -> 503 status:starting (gate keeps waiting / rejects)", async () => {
    beginBoot();
    // No markBootReady yet.
    const { status, body } = await callHealth();
    expect(status).toBe(503);
    expect(body.status).toBe("starting");
  });

  it("DURABLE-degraded boot (armed degrade probe) -> 503 status:degraded, blockingPhases lists the probe", async () => {
    // Arm the double-opt-in probe so the REAL degraded-policy phase fails through the
    // REAL runner into the REAL boot-state — exactly what the e2e drives in a container.
    process.env.CINATRA_BOOT_E2E = "1";
    process.env.CINATRA_BOOT_SIMULATE_DEGRADED = "1";
    beginBoot();
    for (const phase of bootDegradeProbePhases()) {
      await runBootPhase(phase);
    }
    markBootReady();

    const { status, body } = await callHealth();
    // The deploy health gate polling top-level status (and/or HTTP code) REJECTS this.
    expect(status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.degraded).toBe(true);
    const boot = body.boot as { blockingPhases: string[]; degradedPhases: string[] };
    expect(boot.blockingPhases).toContain("boot-degrade-probe");
  });

  it("the degrade probe is INERT unless double-armed (a real deploy stays 200 ok)", async () => {
    // Only one flag set -> probe is a no-op skip -> boot stays ready/ok.
    process.env.CINATRA_BOOT_SIMULATE_DEGRADED = "1"; // CINATRA_BOOT_E2E unset
    beginBoot();
    for (const phase of bootDegradeProbePhases()) {
      await runBootPhase(phase);
    }
    markBootReady();

    const { status, body } = await callHealth();
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
  });
});
