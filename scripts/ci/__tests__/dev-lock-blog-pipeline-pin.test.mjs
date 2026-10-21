// The clone-back pin of the blog-pipeline-agent companion repository
// (cinatra#3773). cinatra-dev-extensions.lock.json carries exactly one entry
// for the package, a 40-hex resolvedSha and nothing else that is coupled to it
// (no integrity or hash field; pnpm-lock.yaml does not name the package).
// The entry is found by its package and repository name, never by its line, so
// adding, removing or reordering any other entry does not disturb this suite.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PACKAGE = "@cinatra-ai/blog-pipeline-agent";
const REPO = "cinatra-ai/blog-pipeline-agent";
const PINNED = "08623790f53efb112433577fb6e8e11ad7a36dea";
const OLD_PIN_PREFIX = "19cb2cd1";

// The entries that name the package or the repository, in either field.
const blogEntries = (lockText) =>
  JSON.parse(lockText).packages.filter((p) => p.packageName === PACKAGE || p.repo === REPO);

const lockText = readFileSync(join(ROOT, "cinatra-dev-extensions.lock.json"), "utf8");

describe("blog-pipeline-agent dev-extension pin", () => {
  it("has exactly one lock entry, naming the package and the repository", () => {
    const entries = blogEntries(lockText);
    expect(entries).toHaveLength(1);
    expect(entries[0].packageName).toBe(PACKAGE);
    expect(entries[0].repo).toBe(REPO);
  });

  it("pins the commit 08623790", () => {
    expect(blogEntries(lockText)[0].resolvedSha).toBe(PINNED);
  });

  it("keeps the entry to the lock format: three keys, a full lowercase sha", () => {
    const [entry] = blogEntries(lockText);
    expect(Object.keys(entry).sort()).toEqual(["packageName", "repo", "resolvedSha"]);
    expect(entry.resolvedSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("leaves no trace of the old pin anywhere in the lock", () => {
    expect(lockText).not.toContain(OLD_PIN_PREFIX);
  });

  it("does not depend on the entry position: an extra earlier entry changes nothing", () => {
    const copy = JSON.parse(lockText);
    copy.packages.unshift({
      packageName: "@cinatra-ai/a2a-server-connector",
      repo: "cinatra-ai/a2a-server-connector",
      resolvedSha: "1".repeat(40),
    });
    const shifted = JSON.stringify(copy, null, 2);
    const entries = blogEntries(shifted);
    expect(entries).toHaveLength(1);
    expect(entries[0].resolvedSha).toBe(PINNED);
  });

  it("is fail-closed on a duplicate: two entries for the package are refused", () => {
    const copy = JSON.parse(lockText);
    copy.packages.push({ ...copy.packages.find((p) => p.packageName === PACKAGE) });
    expect(blogEntries(JSON.stringify(copy))).toHaveLength(2);
  });
});
