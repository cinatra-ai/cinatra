// PIN-CONSISTENCY guard for the truthful-attribution gate's four coupled pins.
//
// The reusable engine matches the resolved Actions run's referenced_workflows[]
// entry against the suite's pinned SHA EXACTLY, so a suite pin that lags the
// caller `uses:@` (or the reverse) fails the gate arm CLOSED on every merge.
// Four values must therefore advance in ONE commit:
//   1. .github/workflows/truthful-attribution-gate.yml  `uses: ...@<sha>`
//   2. the same caller's `with.ref` engine-checkout input
//   3. .github/gate-suite.json requiredContexts[].pinned for the
//      "truthful-attribution-gate / truthful-attribution-gate" context
//   4. .github/workflows/attribution-record-reverify.yml's gate-engine checkout
//      (a re-verification on a different engine than the one the repo gates on
//      would answer a question nobody asked)
//
// EXPECTED_PIN is deliberately a literal, the same pattern the sibling suite
// gate-suite-highrisk-authz-credential-globs.test.mjs uses for the CalVer: a
// later advance reds here and sends the editor back to move all four together
// rather than discovering the mismatch as a fail-closed gate arm in CI.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXPECTED_PIN = "416a75707fdcfeb768b41c3a54f944078d1ab8fc";

const CALLER_PATH = ".github/workflows/truthful-attribution-gate.yml";
const REVERIFY_PATH = ".github/workflows/attribution-record-reverify.yml";
const SUITE_PATH = ".github/gate-suite.json";
const CONTEXT = "truthful-attribution-gate / truthful-attribution-gate";

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

describe("truthful-attribution gate engine pins advance together", () => {
  const caller = read(CALLER_PATH);

  it("pins the caller `uses:` to the expected cinatra-ai/ci commit", () => {
    const m = caller.match(
      /uses:\s*cinatra-ai\/ci\/\.github\/workflows\/truthful-attribution-gate\.yml@([0-9a-f]{40})/,
    );
    expect(m, `no pinned uses: line in ${CALLER_PATH}`).not.toBeNull();
    expect(m[1]).toBe(EXPECTED_PIN);
  });

  it("pins the caller's `ref:` engine-checkout input to the same commit", () => {
    const m = caller.match(/\n\s*ref:\s*([0-9a-f]{40})/);
    expect(m, `no with.ref pin in ${CALLER_PATH}`).not.toBeNull();
    expect(m[1]).toBe(EXPECTED_PIN);
  });

  it("carries a version comment whose short SHA matches the pin", () => {
    const m = caller.match(/truthful-attribution-gate\.yml@[0-9a-f]{40}\s*#\s*(\S+)/);
    expect(m, `no version comment on the uses: line in ${CALLER_PATH}`).not.toBeNull();
    expect(m[1].endsWith(`.${EXPECTED_PIN.slice(0, 7)}`)).toBe(true);
  });

  it("pins gate-suite.json requiredContexts[].pinned to the same commit", () => {
    const suite = JSON.parse(read(SUITE_PATH));
    const entry = suite.requiredContexts.find((c) => c.context === CONTEXT);
    expect(entry, `no ${CONTEXT} entry in ${SUITE_PATH}`).toBeTruthy();
    expect(entry.pinned).toBe(EXPECTED_PIN);
  });

  it("pins the record-reverify gate-engine checkout to the same commit", () => {
    const m = read(REVERIFY_PATH).match(/repository:\s*cinatra-ai\/ci\s*\n\s*ref:\s*([0-9a-f]{40})/);
    expect(m, `no cinatra-ai/ci engine checkout pin in ${REVERIFY_PATH}`).not.toBeNull();
    expect(m[1]).toBe(EXPECTED_PIN);
  });
});
