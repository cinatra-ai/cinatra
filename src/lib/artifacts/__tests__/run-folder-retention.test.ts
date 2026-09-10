/**
 * cinatra#3030 (epic #3023, lifecycle-c W6) — ACCEPTANCE ITEM 5: "A run folder
 * is gone after pickup plus the grace period."
 *
 * Proved with an INJECTED CLOCK and no sleeps. The sweep is a pure function over
 * the root: it reads each folder's own receipt (the run folder has no table,
 * plan §8.2) and decides. A test that waited on a wall clock could only ever
 * prove the grace period is short.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@/lib/database", () => ({
  readMetadataValueFromDatabase: (_key: string, fallback: unknown) => fallback,
  writeMetadataValueToDatabase: () => {},
}));

let ROOT = "";
let folder: typeof import("@/lib/artifacts/run-folder");
let retention: typeof import("@/lib/artifacts/run-folder-retention");

const ORG = "org-3030r";
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), "cinatra-run-retention-"));
  process.env.CINATRA_RUN_DATA_ROOT = ROOT;
  folder = await import("@/lib/artifacts/run-folder");
  retention = await import("@/lib/artifacts/run-folder-retention");
});

afterEach(async () => {
  await fsp.rm(path.join(ROOT, ORG), { recursive: true, force: true });
});

afterAll(async () => {
  delete process.env.CINATRA_RUN_DATA_ROOT;
  await fsp.rm(ROOT, { recursive: true, force: true });
});

/** One run folder holding one output file, optionally already picked up. */
async function seedRun(runId: string, pickedUpAt: Date | null): Promise<string> {
  await folder.writeRunOutputFile({
    orgId: ORG,
    runId,
    relPath: "report.md",
    bytes: new TextEncoder().encode("# Report\n"),
  });
  if (pickedUpAt !== null) {
    await folder.markRunFolderPickedUp({ orgId: ORG, runId, at: pickedUpAt, files: 1 });
  }
  return folder.runFolderPath(ORG, runId);
}

const exists = async (p: string) => !!(await fsp.stat(p).catch(() => null));

describe("acceptance item 5 — a run folder is gone after pickup plus the grace period", () => {
  it("deletes a folder whose pickup is older than the grace period", async () => {
    const now = new Date("2026-03-01T12:00:00.000Z");
    const dir = await seedRun("run-old", new Date(now.getTime() - 25 * HOUR));
    const summary = await retention.sweepRunFolders({ now });
    expect(summary.deleted).toBe(1);
    expect(summary.decisions).toContainEqual({
      orgId: ORG,
      runId: "run-old",
      reason: "picked_up_past_grace",
      deleted: true,
    });
    expect(await exists(dir)).toBe(false);
  });

  it("keeps a folder still inside its grace period", async () => {
    const now = new Date("2026-03-01T12:00:00.000Z");
    const dir = await seedRun("run-fresh", new Date(now.getTime() - 1 * HOUR));
    const summary = await retention.sweepRunFolders({ now });
    expect(summary.deleted).toBe(0);
    expect(summary.decisions).toContainEqual({
      orgId: ORG,
      runId: "run-fresh",
      reason: "within_grace",
      deleted: false,
    });
    expect(await exists(dir)).toBe(true);
  });

  it("keeps a folder no pickup has reached, until the abandoned bound", async () => {
    const now = new Date("2026-03-01T12:00:00.000Z");
    const dir = await seedRun("run-never", null);
    const kept = await retention.sweepRunFolders({ now });
    expect(kept.decisions).toContainEqual({
      orgId: ORG,
      runId: "run-never",
      reason: "not_picked_up",
      deleted: false,
    });
    expect(await exists(dir)).toBe(true);

    // The second bound: a run that failed before its terminal transition leaves
    // a folder nothing else would ever collect. A folder with NO receipt is aged
    // by its own mtime, which is a real filesystem fact — so the clock this
    // sweep is given is measured FROM that mtime rather than from the injected
    // instant above, which is what makes the bound a decision about the folder
    // and not about when the suite happens to run.
    const stat = await fsp.stat(dir);
    const later = new Date(stat.mtimeMs + 8 * 24 * HOUR);
    const swept = await retention.sweepRunFolders({ now: later });
    expect(swept.decisions).toContainEqual({
      orgId: ORG,
      runId: "run-never",
      reason: "abandoned_past_bound",
      deleted: true,
    });
    expect(await exists(dir)).toBe(false);
  });

  it("honours an injected grace period, so the bound is a decision and not a constant", async () => {
    const now = new Date("2026-03-01T12:00:00.000Z");
    const dir = await seedRun("run-tight", new Date(now.getTime() - 2 * HOUR));
    const summary = await retention.sweepRunFolders({ now, graceMs: 1 * HOUR });
    expect(summary.deleted).toBe(1);
    expect(await exists(dir)).toBe(false);
  });

  it("reports every folder it scanned, deleted or not", async () => {
    const now = new Date("2026-03-01T12:00:00.000Z");
    await seedRun("run-a", new Date(now.getTime() - 25 * HOUR));
    await seedRun("run-b", new Date(now.getTime() - 1 * HOUR));
    const summary = await retention.sweepRunFolders({ now });
    expect(summary.scanned).toBe(2);
    expect(summary.deleted).toBe(1);
    expect(summary.root).toBe(ROOT);
  });
});
