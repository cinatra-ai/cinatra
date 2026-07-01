// Required-env note boot phase (cinatra#789 item 3, soft half).
//
// The HARD-required env vars are enforced at import time by
// `@/lib/boot/required-env-preflight` (before register()), because a boot phase runs
// too late (env-sensitive binders import first). This phase covers the SOFT-required
// set: it re-checks the soft vars (currently CINATRA_BRIDGE_TOKEN) and, when one is
// missing in prod, records a `retryable` (NON-deploy-blocking) failure so the deficit
// is VISIBLE in the boot phase log / health `degradedPhases` — not only in an
// import-time console.warn that an operator may miss. A WayFlow deploy therefore sees
// "CINATRA_BRIDGE_TOKEN missing" in the readiness surface; a non-WayFlow deploy is not
// blocked (retryable, not fatal, not the deploy-blocking `degraded` class).
//
// Deliberately NOT importing "server-only": unit tests import the phase list.

import type { BootPhase } from "@/lib/boot/boot-phase";
import { getAppRuntimeMode } from "@/lib/runtime-mode";

function inProdMode(): boolean {
  // Consistent with the required-env preflight (honors CINATRA_RUNTIME_MODE +
  // APP_RUNTIME_MODE; unset -> development).
  return getAppRuntimeMode() === "production";
}

export function requiredEnvNotePhases(): BootPhase[] {
  return [
    {
      name: "required-env-soft-check",
      policy: "retryable",
      run: async () => {
        if (!inProdMode()) {
          return { skipped: "soft-env check is prod-only" };
        }
        const { checkRequiredEnv } = await import("@/lib/boot/required-env-preflight");
        const { softMissing } = checkRequiredEnv(process.env);
        if (softMissing.length === 0) {
          return; // all soft vars present -> ok
        }
        const detail = softMissing.map((s) => `${s.name} (${s.why})`).join("; ");
        // A `retryable` failure: recorded + logged, boot continues, health NOT
        // deploy-blocked. Surfaces the config deficit in the readiness surface.
        throw new Error(
          `[required-env-soft-check] ${softMissing.length} optional-in-prod env var(s) not set: ${detail}`,
        );
      },
    },
  ];
}
