// THE REGENERATE DRIVER ASSERTS WHAT THE PRODUCT DRAWS (cinatra#3080 fold,
// pre-review finding 8).
//
// The floor's Regenerate is declared by its manifest as
// `regenerate-review -> successor-gate-opened`: that is the action's NAME and
// its eventual effect. What the floor draws when the press lands is the
// changes-requested notice (`data-review-outcome="changes-requested"`,
// review-decision-bar.tsx): the gate resolves and the work goes back for
// repair. The successor gate is opened LATER, by the producer's response, and
// no element ever carries `data-review-outcome="successor-gate-opened"`. A
// driver that waits for that attribute can never pass; its skipped mount hid it.
//
// This test reds if the driver waits on an outcome attribute the product never
// renders, or stops asserting the real sequence (the notice, then no floor).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const contract = readFileSync(path.join(REPO_ROOT, "tests", "e2e", "design", "conformance", "contract.ts"), "utf8");
const bar = readFileSync(path.join(REPO_ROOT, "packages", "agents", "src", "review-decision-bar.tsx"), "utf8");

const renderedOutcomes = new Set([...bar.matchAll(/data-review-outcome="([a-z-]+)"/g)].map((m) => m[1]));

/** The `"regenerate-review": { ... }` entry of ratifiedFloorActions(). */
function regenerateDriver() {
  const fn = contract.indexOf("function ratifiedFloorActions(");
  expect(fn).toBeGreaterThan(-1);
  const start = contract.indexOf('"regenerate-review": {', fn);
  const end = contract.indexOf('"continue-review": {', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return contract.slice(start, end);
}

describe("the floor's Regenerate conformance driver", () => {
  it("the product renders changes-requested and never successor-gate-opened as an outcome", () => {
    expect(renderedOutcomes.has("changes-requested")).toBe(true);
    expect(renderedOutcomes.has("successor-gate-opened")).toBe(false);
  });

  it("waits only on outcome attributes the floor actually renders", () => {
    const waited = [...contract.matchAll(/data-review-outcome="([a-z-]+)"/g)].map((m) => m[1]);
    for (const outcome of waited) expect(renderedOutcomes.has(outcome), `contract waits on data-review-outcome="${outcome}"`).toBe(true);
  });

  it("asserts the real sequence: the requested changes-requested notice, then no floor control and no Continued notice", () => {
    const driver = regenerateDriver();
    // Still pressed by the manifest's own action-and-outcome pair.
    expect(driver).toContain('floorControl(root, "regenerate-review", "successor-gate-opened").click()');
    const notice = driver.indexOf('[data-review-outcome="changes-requested"]');
    expect(notice).toBeGreaterThan(-1);
    expect(driver).toMatch(/toHaveAttribute\(\s*"data-changes-status",\s*"requested"\s*\)/);
    const gone = driver.indexOf('toHaveCount(0)');
    expect(gone).toBeGreaterThan(notice);
    expect(driver).toContain('[data-review-outcome="decided"]');
  });
});
