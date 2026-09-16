/**
 * THE SUPPLIED-SNAPSHOT WRITER (cinatra#3204 leg 2, convergence round 1).
 *
 * `readSuppliedSnapshot` refuses a `github` row that names no staged snapshot,
 * so the repository road must leave the installed bytes behind or the row it
 * writes is unusable the next time the runtime activates the extension. What
 * this proves is the pair: what the writer stages, the reader reads back, under
 * a name derived from the CONTENT DIGEST alone — never from a repository path.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readSuppliedSnapshot, writeSuppliedSnapshot } from "@/lib/extension-package-store";

const DIGEST = "a".repeat(64);

async function withRoot<T>(run: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "supplied-snapshot-"));
  const previous = process.env.CINATRA_SUPPLIED_SNAPSHOT_ROOT;
  process.env.CINATRA_SUPPLIED_SNAPSHOT_ROOT = dir;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.CINATRA_SUPPLIED_SNAPSHOT_ROOT;
    else process.env.CINATRA_SUPPLIED_SNAPSHOT_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

describe("writeSuppliedSnapshot", () => {
  it("stages bytes the reader reads back unchanged", async () => {
    await withRoot(async () => {
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      const name = await writeSuppliedSnapshot(DIGEST, bytes);
      expect(name).toBe(`${DIGEST}.tgz`);
      const read = await readSuppliedSnapshot({
        type: "github",
        path: name,
        repo: "acme/pkg",
        resolvedSha: "b".repeat(40),
      });
      expect([...read]).toEqual([...bytes]);
    });
  });

  it("names the file from the digest alone and leaves no partial file behind", async () => {
    await withRoot(async () => {
      const root = process.env.CINATRA_SUPPLIED_SNAPSHOT_ROOT as string;
      await writeSuppliedSnapshot(DIGEST, new Uint8Array([9]));
      expect(await readdir(root)).toEqual([`${DIGEST}.tgz`]);
    });
  });

  it("is idempotent — the same digest stages to the same single file", async () => {
    await withRoot(async () => {
      const root = process.env.CINATRA_SUPPLIED_SNAPSHOT_ROOT as string;
      await writeSuppliedSnapshot(DIGEST, new Uint8Array([1]));
      await writeSuppliedSnapshot(DIGEST, new Uint8Array([1]));
      expect(await readdir(root)).toHaveLength(1);
    });
  });

  it("REFUSES a digest that is not a plain hex digest, so nothing shapes the file name but the digest", async () => {
    await withRoot(async () => {
      for (const bad of ["../escape", "a".repeat(63), `${"a".repeat(63)}/x`, "A".repeat(64)]) {
        await expect(writeSuppliedSnapshot(bad, new Uint8Array([1]))).rejects.toThrow(
          /not a 64-character hex digest/,
        );
      }
      const root = process.env.CINATRA_SUPPLIED_SNAPSHOT_ROOT as string;
      expect(await readdir(root)).toEqual([]);
    });
  });
});
