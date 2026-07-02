// Boot-degrade probe (cinatra#789 item 1 — test seam for the degraded-boot health gate).
//
// The health-readiness acceptance requires PROVING the deploy health gate REJECTS a
// DURABLE-degraded boot (a non-fatal `degraded`-policy phase failed) — not merely that
// the JSON represents it. To drive a deterministic durable-degraded boot in the
// prod-boot-e2e WITHOUT a real fault, this phase throws under `degraded` policy — but
// ONLY when DOUBLE-armed: BOTH `CINATRA_BOOT_E2E=1` AND `CINATRA_BOOT_SIMULATE_DEGRADED=1`.
// A real deploy sets neither, so it is inert (returns ok). The double opt-in guards
// against a single stray env var accidentally degrading a production instance.
//
// `degraded` policy is deliberate: it makes the boot readiness DURABLE-degraded, which
// (per the health-contract split) yields top-level status:"degraded" + HTTP 503 — the
// exact deploy-blocking signal the e2e asserts the health gate rejects.
//
// Deliberately NOT importing "server-only": unit tests import the phase list.

import type { BootPhase } from "@/lib/boot/boot-phase";

/** True only when BOTH the e2e arm AND the simulate flag are set. */
export function isDegradeProbeArmed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.CINATRA_BOOT_E2E === "1" && env.CINATRA_BOOT_SIMULATE_DEGRADED === "1";
}

export function bootDegradeProbePhases(): BootPhase[] {
  return [
    {
      name: "boot-degrade-probe",
      // `degraded` => a durable deficit for this process lifetime. When armed, this
      // makes readiness "degraded" with a degraded-policy failure -> deploy-blocking.
      policy: "degraded",
      run: () => {
        if (!isDegradeProbeArmed()) {
          return { skipped: "inert (CINATRA_BOOT_E2E + CINATRA_BOOT_SIMULATE_DEGRADED not both set)" };
        }
        throw new Error(
          "[boot-degrade-probe] simulated durable-degraded boot (CINATRA_BOOT_SIMULATE_DEGRADED=1) — " +
            "TEST SEAM ONLY; a real deploy never arms this.",
        );
      },
    },
  ];
}
