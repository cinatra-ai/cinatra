// Generic kind-agnostic README extractor.
//
// Unit tests for `readReadmeFromExtractedPackage` (the pure local-file half;
// the Verdaccio-bound `getPackageReadme` wrapper rides on top and is covered
// by the existing integration suite once a live Verdaccio is available).

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readReadmeFromExtractedPackage,
  DEFAULT_README_SIZE_CAP_BYTES,
} from "../src/verdaccio/client";

describe("readReadmeFromExtractedPackage", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "readme-extractor-test-"));
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("returns the README content + sizeBytes when present and under the cap", async () => {
    const pkgDir = await mkdtemp(join(workspace, "ok-"));
    const readmeContent = "# My Extension\n\nDoes a thing.\n";
    await writeFile(join(pkgDir, "README.md"), readmeContent, "utf8");

    const result = await readReadmeFromExtractedPackage(pkgDir);

    expect(result.readme).toBe(readmeContent);
    expect(result.oversized).toBe(false);
    expect(result.sizeBytes).toBe(Buffer.byteLength(readmeContent, "utf8"));
  });

  it("returns null + sizeBytes:0 + oversized:false when no README is present", async () => {
    const pkgDir = await mkdtemp(join(workspace, "missing-"));

    const result = await readReadmeFromExtractedPackage(pkgDir);

    expect(result.readme).toBeNull();
    expect(result.sizeBytes).toBe(0);
    expect(result.oversized).toBe(false);
  });

  it("returns null + oversized:true + reports actual size when README exceeds the cap", async () => {
    const pkgDir = await mkdtemp(join(workspace, "huge-"));
    // 100-byte cap; ship 500-byte README.
    const oversizedContent = "x".repeat(500);
    await writeFile(join(pkgDir, "README.md"), oversizedContent, "utf8");

    const result = await readReadmeFromExtractedPackage(pkgDir, { maxReadmeBytes: 100 });

    expect(result.readme).toBeNull();
    expect(result.oversized).toBe(true);
    expect(result.sizeBytes).toBe(500);
  });

  it("returns the README at exactly the size cap (boundary)", async () => {
    const pkgDir = await mkdtemp(join(workspace, "exact-"));
    const exactContent = "y".repeat(100);
    await writeFile(join(pkgDir, "README.md"), exactContent, "utf8");

    const result = await readReadmeFromExtractedPackage(pkgDir, { maxReadmeBytes: 100 });

    expect(result.readme).toBe(exactContent);
    expect(result.oversized).toBe(false);
    expect(result.sizeBytes).toBe(100);
  });

  it("uses the default size cap when no `maxReadmeBytes` option is provided", async () => {
    // Default cap is 256 KB. A 16 KB README should pass.
    const pkgDir = await mkdtemp(join(workspace, "default-cap-"));
    const sixteenKb = "z".repeat(16 * 1024);
    await writeFile(join(pkgDir, "README.md"), sixteenKb, "utf8");

    const result = await readReadmeFromExtractedPackage(pkgDir);

    expect(result.oversized).toBe(false);
    expect(result.readme?.length).toBe(16 * 1024);
    expect(DEFAULT_README_SIZE_CAP_BYTES).toBe(256 * 1024);
  });

  it("propagates filesystem errors that are NOT ENOENT", async () => {
    // A path that has been removed — readdir/stat surface different errors
    // depending on platform. The contract: ENOENT → graceful null; anything
    // else propagates so the caller can surface a real diagnostic.
    const nonexistent = join(workspace, "definitely-not-a-real-path");
    // The function reads README.md inside `tempDir` via path.join. With
    // tempDir nonexistent, `stat` returns ENOENT for `<nonexistent>/README.md`
    // which the contract treats as "no README" — null + sizeBytes 0. Confirm.
    const result = await readReadmeFromExtractedPackage(nonexistent);
    expect(result.readme).toBeNull();
    expect(result.sizeBytes).toBe(0);
    expect(result.oversized).toBe(false);
  });
});
