// cinatra#3924: the Drupal connector pin tracks the merged commit that hands over the node's
// language from the live node read and binds a path-only language to the node's translations
// (drupal-mcp-connector#104), on top of the save through the host's owner binding (#101).
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

describe("the Drupal connector pin for the node language change (cinatra#3924)", () => {
  it("pins drupal-mcp-connector in the dev lock to its merged commit", () => {
    expect(shaOf(readLock("cinatra-dev-extensions.lock.json"), "@cinatra-ai/drupal-mcp-connector")).toBe(
      "78e71e78db8f218fa17e0944d44951ad90eaf328",
    );
  });

  it("keeps drupal-mcp-connector out of the required lock", () => {
    expect(shaOf(readLock("cinatra-required-extensions.lock.json"), "@cinatra-ai/drupal-mcp-connector")).toBeUndefined();
  });
});
