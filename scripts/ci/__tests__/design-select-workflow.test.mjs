// THE SELECTOR AT THE WORKFLOW BOUNDARY (cinatra#3268 item 2).
//
// The selector alone only narrows the PLAYWRIGHT INVOCATION — the install, the
// build and the boot are paid before it ever speaks. The saving is real only
// when the decision is taken in a cheap job IN FRONT of the expensive one, so
// this suite guards the shape of that boundary in the workflow file itself:
//
//   * a first job `select` that runs after the checkout and NOTHING else —
//     no pnpm, no node setup, no extension clone, no install, no build;
//   * the two dependency-free contract checks MOVED into it (moved, not
//     copied: a check that runs twice is a check nobody maintains);
//   * the selection bound to the event's FROZEN base commit, refusing to run
//     when that commit is absent, exactly as the ratchet step does;
//   * the expensive job gated on the published mode and consuming the SAME
//     published plan, so one selection governs the whole run.
//
// Dependency-free by construction (this repo carries no YAML parser): the
// scanner below reads the file as indented text, the way the sibling
// workflow-shape guards under scripts/ci/__tests__ and scripts/audit/__tests__
// already do.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "../design-select.mjs";

const WORKFLOW = ".github/workflows/design-visual-verify.yml";
const TEXT = readFileSync(join(REPO_ROOT, WORKFLOW), "utf8");
const LINES = TEXT.split("\n");

const JOBS_LINE = LINES.findIndex((line) => line === "jobs:");
const JOB_HEADER = /^ {2}([A-Za-z0-9_-]+):\s*$/;

/** Job ids in file order — the order IS the boundary, so it is asserted. */
function jobIds() {
  const ids = [];
  for (let index = JOBS_LINE + 1; index < LINES.length; index += 1) {
    const match = JOB_HEADER.exec(LINES[index]);
    if (match) ids.push(match[1]);
  }
  return ids;
}

/**
 * A whole-line YAML comment. The scanner must be blind to these: a mutation
 * that comments the real condition out and leaves the expected text in a
 * comment would otherwise satisfy every substring assertion below while the
 * expensive job could never run again.
 */
export const isComment = (line) => /^\s*#/.test(line);

/** One job's own block, from its header to the next job header, comments out. */
function jobBlock(id) {
  const start = LINES.findIndex(
    (line, index) => index > JOBS_LINE && JOB_HEADER.exec(line)?.[1] === id,
  );
  if (start === -1) return null;
  let end = start + 1;
  while (end < LINES.length && !JOB_HEADER.test(LINES[end])) end += 1;
  return LINES.slice(start, end)
    .filter((line) => !isComment(line))
    .join("\n");
}

/** The `on.pull_request.paths` list, as the quoted values it carries. */
function triggerPaths() {
  const start = LINES.findIndex((line) => line === "    paths:");
  if (start === -1) return [];
  const paths = [];
  for (let index = start + 1; index < LINES.length; index += 1) {
    const line = LINES[index];
    if (/^\s*#/.test(line)) continue;
    const match = /^ {6}- "([^"]+)"\s*$/.exec(line);
    if (!match) break;
    paths.push(match[1]);
  }
  return paths;
}

const SELECT = jobBlock("select");
const PIXEL_DIFF = jobBlock("pixel-diff");

const TESTID_CHECK = "node scripts/design/check-conformance-testids.mjs";
const RATCHET_CHECK = "node scripts/design/check-conformance-ratchet.mjs";
const PLAN_FILE = "design-select.json";
const PLAN_ARTIFACT = "design-select-plan";

describe("the cheap job comes first", () => {
  it("declares `select` as the workflow's first job", () => {
    expect(jobIds()[0]).toBe("select");
    expect(jobIds()).toContain("pixel-diff");
  });

  it("gives `select` and the expensive job each their own runner class", () => {
    // The four-class routing form. The cheap selection job takes the gate
    // class; the expensive job takes the end-to-end class, which is the
    // class that stays on the self-hosted box.
    expect(SELECT).toContain(
      "runs-on: ${{ fromJSON(vars.CI_RUNNER_GATE || '\"ubuntu-latest\"') }}",
    );
    expect(PIXEL_DIFF).toContain(
      "runs-on: ${{ fromJSON(vars.CI_RUNNER_E2E || '\"ubuntu-latest\"') }}",
    );
  });

  it("pays no install, no build, no browser and no boot in `select`", () => {
    expect(SELECT).toContain("uses: actions/checkout@");
    // A pinned node is the sibling cheap gate's own shape (design-pin-drift):
    // it costs seconds and it keeps the two moved contract checks on the node
    // version they run on today. Everything that costs MINUTES stays out —
    // except the pinned companion clone, which is not an optimisation but the
    // precondition of the decision itself (see the test below).
    for (const expensive of [
      "pnpm/action-setup",
      "pnpm install",
      "pnpm build",
      "playwright install",
    ]) {
      expect(SELECT).not.toContain(expensive);
    }
    // ...and no dependency cache restore, which is an install by another name.
    expect(SELECT).not.toContain('cache: "pnpm"');
  });

  it("checks out enough history for an honest diff", () => {
    expect(SELECT).toContain("fetch-depth: 0");
  });

  it("materializes the pinned extension tree BEFORE it selects", () => {
    // THE REGRESSION THIS PINS. extensions/ is not in this repository, and
    // tsconfig maps every "@cinatra-ai/*" alias into it. On a bare checkout the
    // walk reaches src/lib/generated/extensions.server.ts, cannot resolve
    // "@cinatra-ai/anthropic-connector/register", and selectFamilies widens to
    // ALL on the spot (see "an untrustworthy graph widens" in the unit suite).
    // A `select` job without this step therefore answers "all" to EVERY diff,
    // including a docs-only one — measured on a bare checkout of this branch's
    // base — so the job in front of the cost would never skip anything and the
    // change would save nothing at all.
    expect(SELECT).toContain("uses: ./.github/actions/clone-extensions");
    const clone = SELECT.indexOf("uses: ./.github/actions/clone-extensions");
    const decide = SELECT.indexOf("node scripts/ci/design-select.mjs --out");
    expect(clone).toBeGreaterThan(-1);
    expect(decide).toBeGreaterThan(-1);
    expect(clone).toBeLessThan(decide);
    // ...and after the two dependency-free contract checks, so a contract
    // break still fails in seconds without paying for the clone.
    expect(SELECT.indexOf(TESTID_CHECK)).toBeLessThan(clone);
    expect(SELECT.indexOf(RATCHET_CHECK)).toBeLessThan(clone);
  });
});

describe("the dependency-free contract checks move, they are not copied", () => {
  it("runs both of them in `select`", () => {
    expect(SELECT).toContain(TESTID_CHECK);
    expect(SELECT).toContain(RATCHET_CHECK);
  });

  it("no longer runs either of them in the expensive job", () => {
    expect(PIXEL_DIFF).not.toContain(TESTID_CHECK);
    expect(PIXEL_DIFF).not.toContain(RATCHET_CHECK);
  });

  it("keeps the ratchet's fail-closed base guard with them", () => {
    expect(SELECT).toContain("BASE_SHA: ${{ github.event.pull_request.base.sha }}");
    expect(SELECT).toMatch(/conformance ratchet FAILED[\s\S]*exit 1/);
  });
});

describe("the selection is bound to the event's frozen base commit", () => {
  it("hands the selector the frozen base sha, not a live branch tip", () => {
    expect(SELECT).toContain(
      "DESIGN_SELECT_DIFF_BASE: ${{ github.event.pull_request.base.sha }}",
    );
    expect(SELECT).not.toContain("DESIGN_SELECT_DIFF_BASE: origin/");
  });

  it("refuses to select at all when that sha is absent", () => {
    expect(SELECT).toMatch(/if \[ -z "\$\{DESIGN_SELECT_DIFF_BASE:-\}" \][\s\S]*?exit 1/);
  });

  it("writes the plan to a file and publishes it for the expensive job", () => {
    expect(SELECT).toContain(`node scripts/ci/design-select.mjs --out ${PLAN_FILE}`);
    expect(SELECT).toContain("uses: actions/upload-artifact@");
    expect(SELECT).toContain(`name: ${PLAN_ARTIFACT}`);
  });

  it("lets a selector failure fail the job rather than degrade to a skip", () => {
    expect(SELECT).not.toContain("continue-on-error");
    expect(SELECT).not.toMatch(/design-select\.mjs[^\n]*\|\|/);
  });

  it("exposes the decision as job outputs", () => {
    expect(SELECT).toMatch(/^ {4}outputs:$/m);
    for (const output of ["mode:", "families:", "summary:"]) {
      expect(SELECT).toContain(`      ${output} $`);
    }
  });
});

describe("the expensive job is gated on the decision and consumes the same plan", () => {
  it("waits for `select`", () => {
    expect(PIXEL_DIFF).toMatch(/^ {4}needs: select$/m);
  });

  it("does not start at all when the selection is `none`", () => {
    // Anchored at JOB indentation on a line of its own, not merely present
    // somewhere in the block: a substring scan passes on a commented-out
    // condition, and on a condition buried in a step, while the job is in
    // truth ungated or permanently disabled.
    expect(PIXEL_DIFF).toMatch(
      /^ {4}if: \$\{\{ needs\.select\.outputs\.mode != 'none' \}\}$/m,
    );
  });

  it("downloads the published plan and runs Playwright from it", () => {
    expect(PIXEL_DIFF).toContain("uses: actions/download-artifact@");
    expect(PIXEL_DIFF).toContain(`name: ${PLAN_ARTIFACT}`);
    expect(PIXEL_DIFF).toContain(`node scripts/ci/design-select.mjs --run --plan ${PLAN_FILE}`);
  });
});

describe("the workflow runs when the selection logic changes", () => {
  it("triggers on the selector and on the selector's own suites", () => {
    const paths = triggerPaths();
    expect(paths).toContain("scripts/ci/design-select.mjs");
    expect(paths).toContain("scripts/ci/__tests__/design-select.test.mjs");
    expect(paths).toContain("scripts/ci/__tests__/design-select-workflow.test.mjs");
    expect(paths).toContain(WORKFLOW);
  });
});

describe("the scanner reads steps, not prose about steps", () => {
  it("drops commented-out lines before anything is asserted", () => {
    // The exact mutation that survived this suite before: comment the real
    // condition out, leave the expected text behind in a comment, and every
    // `toContain` still passed while no UI change could ever run the suite.
    const mutated = [
      "  pixel-diff:",
      "    needs: select",
      "    # if: ${{ needs.select.outputs.mode != 'none' }}",
      "    if: ${{ false }}",
    ];
    const scanned = mutated.filter((line) => !isComment(line)).join("\n");
    expect(scanned).not.toContain("needs.select.outputs.mode");
    expect(scanned).not.toMatch(
      /^ {4}if: \$\{\{ needs\.select\.outputs\.mode != 'none' \}\}$/m,
    );
  });

  it("keeps the real workflow's own condition visible through that filter", () => {
    expect(PIXEL_DIFF).toMatch(/^ {4}needs: select$/m);
    expect(PIXEL_DIFF).toMatch(
      /^ {4}if: \$\{\{ needs\.select\.outputs\.mode != 'none' \}\}$/m,
    );
  });
});
