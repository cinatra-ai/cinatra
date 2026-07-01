// User-store durable-mount check boot phase (cinatra#789 item 5).
//
// Probes the durable user-install store (`USER_STORE_ROOT`, the SAME path the
// required-extension reconcile refuses to write into) and WARNS clearly if it is
// missing or not writable. `retryable` (NON-deploy-blocking): a fresh instance may
// not have created the dir yet, and a deploy that has not mounted the volume must not
// be health-gated out — but the deficit is surfaced in logs + the boot phase log
// (health `degradedPhases`) so it is never SILENT.
//
// PROD-only: dev uses a local, non-durable store and this check is not meaningful.
//
// Deliberately NOT importing "server-only": unit tests import the phase list.

import { accessSync, constants as fsConstants, existsSync } from "node:fs";

import type { BootPhase } from "@/lib/boot/boot-phase";
import { evaluateUserStoreMount } from "@/lib/boot/user-store-mount-check";
import { getAppRuntimeMode } from "@/lib/runtime-mode";

function inProdMode(): boolean {
  // Consistent with the required-env preflight (honors CINATRA_RUNTIME_MODE +
  // APP_RUNTIME_MODE; unset -> development).
  return getAppRuntimeMode() === "production";
}

export function userStoreMountCheckPhases(): BootPhase[] {
  return [
    {
      name: "user-store-mount-check",
      // retryable => a failure logs + is recorded but does NOT abort boot and does
      // NOT make the health gate reject the boot (see the health-contract split).
      policy: "retryable",
      run: async () => {
        if (!inProdMode()) {
          return { skipped: "dev uses a local non-durable store" };
        }
        const { USER_STORE_ROOT } = await import("@/lib/required-extension-materialize");

        const exists = existsSync(USER_STORE_ROOT);
        let writable = false;
        if (exists) {
          try {
            accessSync(USER_STORE_ROOT, fsConstants.W_OK);
            writable = true;
          } catch {
            writable = false;
          }
        }

        const verdict = evaluateUserStoreMount(USER_STORE_ROOT, { exists, writable });
        if (verdict.kind === "ok") {
          console.info(
            `[user-store-mount-check] durable user store ${USER_STORE_ROOT} present + writable.`,
          );
          return;
        }
        // Warn clearly. Throwing here would abort boot, which we do NOT want (see
        // header) — but a `retryable` phase records the failure without aborting. We
        // want the deficit VISIBLE in the phase log, so throw a clear error that the
        // runner records as a `retryable` failure (logged + swallowed).
        throw new Error(verdict.message);
      },
    },
  ];
}
