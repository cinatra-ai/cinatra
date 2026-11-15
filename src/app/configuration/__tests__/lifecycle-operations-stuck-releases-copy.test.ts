/**
 * The "Stuck review releases" card on /configuration/lifecycle-operations tells
 * an admin what happens to a stuck release. The upgrade recovery tries a
 * release the upgrade left stuck once more, so the card must not say that
 * nothing retries it. A source-level contract, as the sibling gate table: the
 * page is an async server component that cannot be imported in isolation.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const PAGE = path.join(REPO_ROOT, "src", "app", "configuration", "lifecycle-operations", "page.tsx");

const DESCRIPTION =
  "A review decision was made, but the resume delivery that releases the run exhausted every attempt and was dead-lettered. The run is waiting. A release the upgrade left stuck is tried once more, with a new set of attempts; after that, nothing retries it.";

function stuckReleasesDescription(): string {
  const source = readFileSync(PAGE, "utf8");
  const card = source.indexOf("<CardTitle>Stuck review releases</CardTitle>");
  expect(card).toBeGreaterThan(-1);
  const match = /<CardDescription>([\s\S]*?)<\/CardDescription>/.exec(source.slice(card));
  expect(match).not.toBeNull();
  return match![1].replace(/\s+/g, " ").trim();
}

describe("lifecycle operations: the stuck review releases card", () => {
  it("says a release the upgrade left stuck is tried once more, then nothing retries it", () => {
    expect(stuckReleasesDescription()).toBe(DESCRIPTION);
  });
});
