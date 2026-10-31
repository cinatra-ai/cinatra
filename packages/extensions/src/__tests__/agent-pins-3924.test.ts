// cinatra#3924: the Drupal agent pin tracks the merged commit that ends a run as failed when a
// reviewed edit saved nothing (drupal-agent#50), so a dev boot's reading can no longer show a
// refused or empty write as a completed run with an empty change list.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

type LockEntry = { packageName: string; resolvedSha: string };

function readLock(file: string): LockEntry[] {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, file), "utf8")).packages as LockEntry[];
}

function shaOf(entries: LockEntry[], packageName: string): string | undefined {
  return entries.find((p) => p.packageName === packageName)?.resolvedSha;
}

describe("the Drupal agent pin for the settled write outcome (cinatra#3924)", () => {
  it("pins drupal-agent in the dev lock to its merged commit", () => {
    expect(shaOf(readLock("cinatra-dev-extensions.lock.json"), "@cinatra-ai/drupal-agent")).toBe(
      "a79215352f3e49da395a1d5a87bb4b8c8f60dc46",
    );
  });

  it("keeps drupal-agent out of the required lock", () => {
    expect(shaOf(readLock("cinatra-required-extensions.lock.json"), "@cinatra-ai/drupal-agent")).toBeUndefined();
  });
});
