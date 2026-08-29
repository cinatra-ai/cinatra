/**
 * cinatra#3030 (epic #3023 W6) — the run data-root BOOT PHASE.
 *
 * Item 0.21 asks for a root "guarded at boot", beside the artifact root's own
 * guard. The phase does two things and both are proved here:
 *
 *   1. it guards the root — a root it cannot write is a LOUD warning and never a
 *      refused boot (a run folder is a staging area);
 *   2. it REGISTERS the folder's lister into the one global slot the terminal
 *      capture reads. That registration is what carries the file half of the
 *      pickup (item 0.22) across a boundary an import edge may not cross: the
 *      agents runtime is reachable from four route graphs the dev-perf ratchet
 *      locks, so the capture reads a registered runner exactly as the lifecycle
 *      drains and the derivation runner are read.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RUN_DATA_ROOT_ENV } from "@/lib/artifacts/run-data-root";
import { writeRunOutputFile } from "@/lib/artifacts/run-folder";
import {
  readRegisteredRunOutputsLister,
  runDataRootGuardPhases,
} from "@/lib/boot/phases/run-data-root-guard";

let root = "";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cin-runboot-"));
  process.env[RUN_DATA_ROOT_ENV] = root;
  delete (globalThis as { __cinatraRunOutputsLister?: unknown }).__cinatraRunOutputsLister;
});

afterEach(() => {
  delete process.env[RUN_DATA_ROOT_ENV];
  delete (globalThis as { __cinatraRunOutputsLister?: unknown }).__cinatraRunOutputsLister;
  rmSync(root, { recursive: true, force: true });
});

describe("the run data-root boot phase", () => {
  it("is one retryable phase that never blocks boot", () => {
    const phases = runDataRootGuardPhases();
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({ name: "run-data-root-guard", policy: "retryable" });
  });

  it("registers the lister the terminal capture reads, and it lists the run's files", async () => {
    expect(readRegisteredRunOutputsLister()).toBeUndefined();
    await runDataRootGuardPhases()[0]!.run();
    const lister = readRegisteredRunOutputsLister();
    expect(typeof lister).toBe("function");

    await writeRunOutputFile({
      orgId: "org-boot",
      runId: "run-boot",
      relPath: "draft.md",
      bytes: new TextEncoder().encode("# a draft"),
    });
    await expect(lister!({ orgId: "org-boot", runId: "run-boot" })).resolves.toEqual([
      { relPath: "draft.md", byteLength: 9 },
    ]);
  });

  it("warns loudly on a root it cannot write, and still returns", async () => {
    // A root under a path that is a FILE, so the phase's own mkdir fails.
    const blocked = path.join(root, "a-file", "runs");
    await writeRunOutputFile({
      orgId: "org-boot",
      runId: "run-boot",
      relPath: "x.txt",
      bytes: new TextEncoder().encode("x"),
    });
    rmSync(path.join(root, "org-boot"), { recursive: true, force: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(root, "a-file"), "not a directory");
    process.env[RUN_DATA_ROOT_ENV] = blocked;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(runDataRootGuardPhases()[0]!.run()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("run-data-root-guard");
    warn.mockRestore();
    // The lister is registered even then: a root that is not writable YET must
    // not leave the capture unable to see a folder that may exist later.
    expect(typeof readRegisteredRunOutputsLister()).toBe("function");
  });
});
