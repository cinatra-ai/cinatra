// cinatra#4226: the Drupal connector pin tracks a merged commit of the connector that
// contains its development-site leg (drupal-mcp-connector#103), which the dev boot runs
// with the development-site marker of docker-compose.yml. The pin moves forward with later
// connector commits; connector-pins-3924.test.ts asserts the same current commit.
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

describe("the Drupal connector pin for the development-site leg (cinatra#4226)", () => {
  it("pins drupal-mcp-connector in the dev lock to a merged commit that contains its development-site leg", () => {
    expect(shaOf(readLock("cinatra-dev-extensions.lock.json"), "@cinatra-ai/drupal-mcp-connector")).toBe(
      "78e71e78db8f218fa17e0944d44951ad90eaf328",
    );
  });

  it("keeps drupal-mcp-connector out of the required lock", () => {
    expect(shaOf(readLock("cinatra-required-extensions.lock.json"), "@cinatra-ai/drupal-mcp-connector")).toBeUndefined();
  });
});
