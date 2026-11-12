// cinatra#3924: the Drupal connector pin tracks the merged commit that saves the dev
// instance through the host's owner binding (drupal-mcp-connector#101), so the dev
// boot's Drupal writes are no longer denied for a missing org binding.
// The pin has since moved to the connector's development-site leg (cinatra#4226), a later
// commit of the connector's main branch that still holds that change.
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
  it("pins drupal-mcp-connector in the dev lock to a merged commit that holds the owner binding", () => {
    expect(shaOf(readLock("cinatra-dev-extensions.lock.json"), "@cinatra-ai/drupal-mcp-connector")).toBe(
      "f0964ebee76a43ee1f9116745c0911a4925060b3",
    );
  });

  it("keeps drupal-mcp-connector out of the required lock", () => {
    expect(shaOf(readLock("cinatra-required-extensions.lock.json"), "@cinatra-ai/drupal-mcp-connector")).toBeUndefined();
  });
});
