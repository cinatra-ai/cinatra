/**
 * cinatra#3030 (epic #3023 W6) — ACCEPTANCE 5: "A run folder is gone after
 * pickup plus the grace period."
 *
 * Plan sentences:
 *
 *   item 0.21: "[...] and a retention tier of its own — deleted after pickup plus
 *   a grace period, never by artifact reachability."
 *
 *   §8.2: "The run folder has no table: its retention job lists the folders under
 *   the root and deletes those past pickup plus the grace period [...]"
 *
 * The clock is INJECTED, so "past the grace period" is proved without a suite
 * that sleeps.
 */
import { mkdirSync, mkdtempSync, existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RUN_DATA_ROOT_ENV } from "../run-data-root";
import { RUN_PICKUP_RECEIPT } from "../run-folder";
import {
  RUN_FOLDER_ABANDONED_MS,
  RUN_FOLDER_GRACE_MS,
  sweepRunFolders,
} from "../run-folder-retention";

const ORG = "org-3030";
const NOW = new Date("2026-03-01T12:00:00.000Z");
let root = "";

function seedFolder(runId: string, opts: { pickedUpAt?: Date; mtime?: Date }): string {
  const folder = path.join(root, ORG, runId);
  mkdirSync(path.join(folder, "outputs"), { recursive: true });
  writeFileSync(path.join(folder, "outputs", "draft.md"), "# a draft");
  if (opts.pickedUpAt) {
    writeFileSync(
      path.join(folder, RUN_PICKUP_RECEIPT),
      JSON.stringify({ pickedUpAt: opts.pickedUpAt.toISOString(), files: 1 }),
    );
  }
  if (opts.mtime) {
    const seconds = opts.mtime.getTime() / 1000;
    utimesSync(folder, seconds, seconds);
  }
  return folder;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cin-runsweep-"));
  process.env[RUN_DATA_ROOT_ENV] = root;
});

afterEach(() => {
  delete process.env[RUN_DATA_ROOT_ENV];
  rmSync(root, { recursive: true, force: true });
});

describe("the run folder's retention tier", () => {
  it("deletes a folder past pickup plus the grace period, and keeps one inside it", async () => {
    const past = seedFolder("run-past", {
      pickedUpAt: new Date(NOW.getTime() - RUN_FOLDER_GRACE_MS - 1000),
    });
    const inside = seedFolder("run-inside", {
      pickedUpAt: new Date(NOW.getTime() - 60_000),
    });

    const summary = await sweepRunFolders({ now: NOW });

    expect(existsSync(past)).toBe(false);
    expect(existsSync(inside)).toBe(true);
    expect(summary.deleted).toBe(1);
    expect(summary.decisions).toEqual(
      expect.arrayContaining([
        { orgId: ORG, runId: "run-past", reason: "picked_up_past_grace", deleted: true },
        { orgId: ORG, runId: "run-inside", reason: "within_grace", deleted: false },
      ]),
    );
  });

  it("keeps a folder no pickup has reached, and collects one abandoned past its bound", async () => {
    const fresh = seedFolder("run-fresh", { mtime: new Date(NOW.getTime() - 60_000) });
    const abandoned = seedFolder("run-abandoned", {
      mtime: new Date(NOW.getTime() - RUN_FOLDER_ABANDONED_MS - 1000),
    });

    const summary = await sweepRunFolders({ now: NOW });

    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(abandoned)).toBe(false);
    expect(summary.decisions).toEqual(
      expect.arrayContaining([
        { orgId: ORG, runId: "run-fresh", reason: "not_picked_up", deleted: false },
        { orgId: ORG, runId: "run-abandoned", reason: "abandoned_past_bound", deleted: true },
      ]),
    );
  });

  it("counts the grace period from the PICKUP, never from the folder's own age", async () => {
    // Written long ago, picked up a minute ago: the folder stays.
    const folder = seedFolder("run-old-but-fresh-pickup", {
      pickedUpAt: new Date(NOW.getTime() - 60_000),
      mtime: new Date(NOW.getTime() - RUN_FOLDER_ABANDONED_MS - 1000),
    });
    const summary = await sweepRunFolders({ now: NOW });
    expect(existsSync(folder)).toBe(true);
    expect(summary.deleted).toBe(0);
  });

  it("is a no-op on a root with nothing in it", async () => {
    const summary = await sweepRunFolders({ now: NOW });
    expect(summary).toMatchObject({ scanned: 0, deleted: 0 });
  });
});
