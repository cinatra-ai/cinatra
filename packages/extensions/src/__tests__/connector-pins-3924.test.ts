// cinatra#3924: the Drupal connector pin tracks the merged commit that reads a node through
// the Cinatra module reader when the endpoint serves only the module tools
// (drupal-mcp-connector#105), on top of the node language hand-over (#104) and the save
// through the host's owner binding (#101). The pin has since moved to the merged commit that
// writes a reviewed page edit only if the page is unchanged since its read
// (drupal-mcp-connector#108, cinatra#3745); it still contains #105.
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

describe("the Drupal connector pin for the module reader fallback (cinatra#3924)", () => {
  it("pins drupal-mcp-connector in the dev lock to its merged commit", () => {
    expect(shaOf(readLock("cinatra-dev-extensions.lock.json"), "@cinatra-ai/drupal-mcp-connector")).toBe(
      "344ca79e5e497a57a7387df3809ce0c337438ec0",
    );
  });

  it("keeps drupal-mcp-connector out of the required lock", () => {
    expect(shaOf(readLock("cinatra-required-extensions.lock.json"), "@cinatra-ai/drupal-mcp-connector")).toBeUndefined();
  });
});
