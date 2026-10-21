// The clone-back pin of the blog-pipeline-agent companion repository
// (cinatra#3773). cinatra-dev-extensions.lock.json carries exactly one entry
// for the package, a 40-hex resolvedSha and nothing else that is coupled to it
// (no integrity or hash field; pnpm-lock.yaml does not name the package).
// This suite holds the pin to the commit the issue asks for and the entry to
// the lock format, so a later bump has to change this expectation on purpose.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PACKAGE = "@cinatra-ai/blog-pipeline-agent";
const PINNED = "08623790f53efb112433577fb6e8e11ad7a36dea";

const lockText = readFileSync(join(ROOT, "cinatra-dev-extensions.lock.json"), "utf8");
const entries = JSON.parse(lockText).packages.filter((p) => p.packageName === PACKAGE);

describe("blog-pipeline-agent dev-extension pin", () => {
  it("has exactly one lock entry, for the right repository", () => {
    expect(entries).toHaveLength(1);
    expect(entries[0].repo).toBe("cinatra-ai/blog-pipeline-agent");
  });

  it("pins the commit 08623790 (line 88 of the lock)", () => {
    expect(entries[0].resolvedSha).toBe(PINNED);
    expect(lockText.split("\n")[87]).toContain(PINNED);
  });

  it("keeps the entry to the lock format: three keys, a full lowercase sha", () => {
    expect(Object.keys(entries[0]).sort()).toEqual(["packageName", "repo", "resolvedSha"]);
    expect(entries[0].resolvedSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("leaves no trace of the old pin anywhere in the lock", () => {
    expect(lockText).not.toContain("19cb2cd1");
  });
});
