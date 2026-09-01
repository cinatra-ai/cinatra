// Run data-root boot phase (cinatra#3030, epic #3023 W6; item 0.21: the run
// folder is "guarded at boot").
//
// TWO THINGS HAPPEN HERE, and the second is what keeps a locked route's graph
// where it is.
//
// 1. THE GUARD, a deliberate mirror of `./artifact-data-root-guard.ts`. The run
//    folder root is configurable the same way (env CINATRA_RUN_DATA_ROOT > DB
//    metadata `run_data_root` > cwd-relative `data/agents/runs`), and the same
//    misconfiguration is possible: a root pointed away from the mounted volume
//    makes every in-flight run's staged files invisible to the pickup, which
//    looks like an agent that wrote nothing. This phase warns LOUDLY when the
//    resolved root cannot be created or written.
//
// 2. THE LISTER, REGISTERED rather than imported. The terminal capture in the
//    agents runtime has to know which files a run emitted (item 0.22), but that
//    runtime is reachable from four route graphs the dev-perf ratchet locks
//    (`scripts/audit/route-graph-ratchet.mjs`), and an import edge from it to
//    the host's run-folder module would grow all four. The repository already
//    solves exactly this with a BOOT-REGISTERED runner slot (the lifecycle
//    review orchestration drains and the unbound-output derivation runner do the
//    same, for the same reason). So the phase registers the folder's lister into
//    one global slot and the capture reads that slot: no import edge, no graph
//    growth, and the pickup still runs where the folder lives.
//
// `retryable` and non-blocking: a run folder is a staging area, so an
// unavailable root is never a reason to refuse boot — but it is always a reason
// to say so. Deliberately NOT importing "server-only": unit tests import the
// phase list.

import fsp from "node:fs/promises";
import path from "node:path";

import type { BootPhase } from "@/lib/boot/boot-phase";

/** One file of a run's outputs folder, as the terminal capture reads it. */
export type RunOutputListing = { relPath: string; byteLength: number };

/** The registered lister's shape. */
export type RunOutputsLister = (input: {
  orgId: string;
  runId: string;
}) => Promise<RunOutputListing[]>;

/** The ONE global slot the terminal capture reads. Declared here, beside the
 *  phase that fills it, so the capture's untyped read has a typed home. */
export type RunOutputsListerSlot = { __cinatraRunOutputsLister?: RunOutputsLister };

export function readRegisteredRunOutputsLister(): RunOutputsLister | undefined {
  return (globalThis as RunOutputsListerSlot).__cinatraRunOutputsLister;
}

export function registerRunOutputsLister(lister: RunOutputsLister): void {
  (globalThis as RunOutputsListerSlot).__cinatraRunOutputsLister = lister;
}

export function runDataRootGuardPhases(): BootPhase[] {
  return [
    {
      name: "run-data-root-guard",
      policy: "retryable",
      run: async () => {
        const { resolveRunDataRoot, RUN_DATA_ROOT_ENV, RUN_DATA_ROOT_METADATA_KEY } = await import(
          "@/lib/artifacts/run-data-root"
        );
        // The lister is registered FIRST and unconditionally: a root that cannot
        // be written yet is a reason to warn, never a reason to leave the
        // capture unable to see a folder that may exist by the time a run ends.
        const { listRunOutputFiles } = await import("@/lib/artifacts/run-folder");
        registerRunOutputsLister(async (input) => {
          const files = await listRunOutputFiles(input);
          return files.map((file) => ({
            relPath: file.relPath,
            byteLength: file.byteLength,
          }));
        });
        const root = resolveRunDataRoot();
        try {
          await fsp.mkdir(root, { recursive: true });
          const probe = path.join(root, ".boot-probe");
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
