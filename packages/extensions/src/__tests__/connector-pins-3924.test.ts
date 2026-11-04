// cinatra#3924: the Drupal connector pin tracks the merged commit that saves the dev
// instance through the host's owner binding (drupal-mcp-connector#101), so the dev
// boot's Drupal writes are no longer denied for a missing org binding.
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

describe("the Drupal connector pin for the owner-binding change (cinatra#3924)", () => {
  it("pins drupal-mcp-connector in the dev lock to its merged commit", () => {
    expect(shaOf(readLock("cinatra-dev-extensions.lock.json"), "@cinatra-ai/drupal-mcp-connector")).toBe(
      "3c8d082d98afb47ff9aa7f38fe739873518d8669",
    );
  });

  it("keeps drupal-mcp-connector out of the required lock", () => {
    expect(shaOf(readLock("cinatra-required-extensions.lock.json"), "@cinatra-ai/drupal-mcp-connector")).toBeUndefined();
  });
});
