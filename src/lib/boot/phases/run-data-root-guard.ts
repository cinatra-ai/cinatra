// Run data-root boot phase (cinatra#3030, epic #3023 W6; item 0.21: the run
// folder is "guarded at boot").
//
// A deliberate mirror of `./artifact-data-root-guard.ts`. The run folder root is
// configurable the same way (env CINATRA_RUN_DATA_ROOT > DB metadata
// `run_data_root` > cwd-relative `data/agents/runs`), and the same
// misconfiguration is possible: a root pointed away from the mounted volume
// makes every in-flight run's staged files invisible to the pickup, which looks
// like an agent that wrote nothing. This phase warns LOUDLY when the resolved
// root cannot be created or written.
//
// `retryable` and non-blocking: a run folder is a staging area, so an
// unavailable root is never a reason to refuse boot — but it is always a reason
// to say so. Deliberately NOT importing "server-only": unit tests import the
// phase list.

import fsp from "node:fs/promises";
import path from "node:path";

import type { BootPhase } from "@/lib/boot/boot-phase";

/** The probe file the phase writes and removes. Named so an operator who finds
 *  one left behind by a hard kill knows what wrote it. */
export const RUN_DATA_ROOT_BOOT_PROBE = ".boot-probe";

export function runDataRootGuardPhases(): BootPhase[] {
  return [
    {
      name: "run-data-root-guard",
      policy: "retryable",
      run: async () => {
        const { resolveRunDataRoot, RUN_DATA_ROOT_ENV, RUN_DATA_ROOT_METADATA_KEY } = await import(
          "@/lib/artifacts/run-data-root"
        );
        const root = resolveRunDataRoot();
        try {
          await fsp.mkdir(root, { recursive: true });
          const probe = path.join(root, RUN_DATA_ROOT_BOOT_PROBE);
          await fsp.writeFile(probe, "");
          await fsp.rm(probe, { force: true });
          return;
        } catch (err) {
          console.warn(
            `[run-data-root-guard] the resolved run data root ${root} is not writable ` +
              `(${err instanceof Error ? err.message : String(err)}). Agents cannot stage files for ` +
              `the pickup until it is. Check env ${RUN_DATA_ROOT_ENV} or the metadata key ` +
              `"${RUN_DATA_ROOT_METADATA_KEY}" — this is CONFIGURATION, not lost data.`,
          );
        }
      },
    },
  ];
}
