import "server-only";

// THE RUN FOLDER'S RETENTION TIER (cinatra#3030, epic #3023 W6; plan (C) item
// 0.21 and technical notes §8.2, §8.3, §8.9).
//
//   item 0.21: "[...] and a retention tier of its own — deleted after pickup
//   plus a grace period, never by artifact reachability."
//
//   §8.2: "The run folder has no table: its retention job lists the folders
//   under the root and deletes those past pickup plus the grace period; the
//   pickup records, on each ledger row, which folder and file it read."
//
//   §8.3: "[a failure in the artifact write's second stage] leaves the first
//   committed and the bytes on disk, an orphan nothing collects today [...] so
//   the retention job of item 0.21 takes the representation-less resource of a
//   failed write into its sweep."
//
// The sweep is a FUNCTION over the root with an injected clock: it never sleeps,
// never reads a table, and reports what it deleted and what it left. That is
// what makes "past pickup plus the grace period" provable without a wall clock.

import fsp from "node:fs/promises";
import path from "node:path";

import { resolveRunDataRoot } from "./run-data-root";
import { RUN_PICKUP_RECEIPT, readRunFolderPickup } from "./run-folder";

/** The grace period after pickup (item 0.21 names one and leaves its value open;
 *  see the pull request's decisions). Overridable per deployment. */
export const RUN_FOLDER_GRACE_MS = 24 * 60 * 60 * 1000;

/** The bound on a folder that was NEVER picked up — a run that failed before its
 *  terminal transition leaves one behind, and nothing else would ever collect
 *  it. Deliberately far longer than the grace period. */
export const RUN_FOLDER_ABANDONED_MS = 7 * 24 * 60 * 60 * 1000;

export const RUN_FOLDER_GRACE_ENV = "CINATRA_RUN_FOLDER_GRACE_MS";
export const RUN_FOLDER_ABANDONED_ENV = "CINATRA_RUN_FOLDER_ABANDONED_MS";

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export type RunFolderSweepDecision = {
  orgId: string;
  runId: string;
  /** Why the folder was deleted, or why it was kept. */
  reason: "picked_up_past_grace" | "abandoned_past_bound" | "within_grace" | "not_picked_up";
  deleted: boolean;
};

export type RunFolderSweepSummary = {
  root: string;
  scanned: number;
  deleted: number;
  decisions: RunFolderSweepDecision[];
};

/**
 * Sweep the run-folder root once.
 *
 * A folder is deleted when its pickup receipt is older than the grace period, or
 * when it carries NO receipt and its own mtime is older than the abandoned
 * bound. Everything else is kept, with the reason recorded — a folder inside its
 * grace period and a folder a pickup has not reached yet are BOTH still live.
 */
export async function sweepRunFolders(opts?: {
  root?: string;
  now?: Date;
  graceMs?: number;
  abandonedMs?: number;
}): Promise<RunFolderSweepSummary> {
  const root = opts?.root ?? resolveRunDataRoot();
  const now = (opts?.now ?? new Date()).getTime();
  const graceMs = opts?.graceMs ?? envMs(RUN_FOLDER_GRACE_ENV, RUN_FOLDER_GRACE_MS);
  const abandonedMs = opts?.abandonedMs ?? envMs(RUN_FOLDER_ABANDONED_ENV, RUN_FOLDER_ABANDONED_MS);
  const decisions: RunFolderSweepDecision[] = [];
  let deleted = 0;

  const orgs = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const org of orgs) {
    if (!org.isDirectory()) continue;
    const orgDir = path.join(root, org.name);
    const runs = await fsp.readdir(orgDir, { withFileTypes: true }).catch(() => []);
    for (const run of runs) {
      if (!run.isDirectory()) continue;
      const folder = path.join(orgDir, run.name);
      const receipt = await readRunFolderPickup(folder);
      let decision: RunFolderSweepDecision;
      if (receipt) {
        const pickedUpAt = Date.parse(receipt.pickedUpAt);
        const past = Number.isFinite(pickedUpAt) && now - pickedUpAt >= graceMs;
        decision = {
          orgId: org.name,
          runId: run.name,
          reason: past ? "picked_up_past_grace" : "within_grace",
          deleted: past,
        };
      } else {
        const st = await fsp.stat(folder).catch(() => null);
        const age = st ? now - st.mtimeMs : 0;
        const past = age >= abandonedMs;
        decision = {
          orgId: org.name,
          runId: run.name,
          reason: past ? "abandoned_past_bound" : "not_picked_up",
          deleted: past,
        };
      }
      if (decision.deleted) {
        await fsp.rm(folder, { recursive: true, force: true });
        deleted += 1;
      }
      decisions.push(decision);
    }
  }
  decisions.sort((a, b) =>
    a.orgId === b.orgId ? (a.runId < b.runId ? -1 : 1) : a.orgId < b.orgId ? -1 : 1,
  );
  return { root, scanned: decisions.length, deleted, decisions };
}

/** Exported for the suite and for an operator reading a folder by hand. */
export const RUN_FOLDER_PICKUP_RECEIPT_NAME = RUN_PICKUP_RECEIPT;
