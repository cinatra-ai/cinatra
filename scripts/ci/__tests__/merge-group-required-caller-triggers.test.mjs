// Merge-queue trigger coverage for the required callers and the two
// path-filtered suites (engineering#658 item 1).
//
// A GitHub merge-queue candidate runs its checks under the `merge_group`
// event. A required context whose workflow does not trigger on that event
// never reports on the candidate and the queue entry hangs forever. The
// sibling guard (merge-group-coverage-guard.mjs) enforces this for the
// contexts in its committed branch-protection mirror; the four callers below
// are required on `main` but are NOT resolvable through that mirror today
// (the toast-banner caller shares its job name with the reusable workflow it
// calls, which the guard fails closed on as ambiguous), so their coverage is
// pinned here instead — file by file, on the parser the guard already owns.
//
// The two path-filtered suites are pinned here too: GitHub does not apply a
// `paths:` filter to a `merge_group` event, so each carries its changed-path
// detection INSIDE the workflow and must end on a deterministic conclusion —
// never a skipped required check.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTriggers } from "../merge-group-coverage-guard.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const read = (file) => fs.readFileSync(path.join(REPO_ROOT, ".github", "workflows", file), "utf8");

/** Whole-line YAML comments are invisible: a commented-out trigger is not one. */
const uncommented = (text) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

const REQUIRED_CALLERS = [
  "actions-pinned-gate.yml",
  "gitignore-gate.yml",
  "secret-scan-gate.yml",
  "toast-banner-gate.yml",
];

const PATH_FILTERED_SUITES = ["design-visual-verify.yml", "execution-plane-e2e.yml"];

describe("the required callers report on a merge-queue candidate", () => {
  for (const file of REQUIRED_CALLERS) {
    it(`${file} triggers on merge_group and on pull_request`, () => {
      const triggers = parseTriggers(read(file));
      expect(triggers, `${file}: no parseable top-level on:`).not.toBeNull();
      expect(triggers).toContain("merge_group");
      expect(triggers).toContain("pull_request");
    });
  }
});

describe("secret scanning receives the queue's own base and head", () => {
  const TEXT = uncommented(read("secret-scan-gate.yml"));

  it("reads merge_group.base_sha / head_sha on the queue event", () => {
    expect(TEXT).toMatch(/base_sha:.*github\.event\.merge_group\.base_sha/);
    expect(TEXT).toMatch(/head_sha:.*github\.event\.merge_group\.head_sha/);
  });

  it("still reads the pull request's own base and head on a pull_request run", () => {
    expect(TEXT).toMatch(/base_sha:.*github\.event\.pull_request\.base\.sha/);
    expect(TEXT).toMatch(/head_sha:.*github\.event\.pull_request\.head\.sha/);
  });

  it("keeps the permanent path exclusion untouched", () => {
    expect(TEXT).toContain("extra_args: --exclude-paths=.trufflehog-exclude");
  });
});

describe("the path-filtered suites detect the changed paths themselves", () => {
  for (const file of PATH_FILTERED_SUITES) {
    it(`${file} triggers on merge_group`, () => {
      expect(parseTriggers(read(file))).toContain("merge_group");
    });
  }

  it("design-visual-verify binds its selection and its ratchet to the queue's base", () => {
    const TEXT = uncommented(read("design-visual-verify.yml"));
    expect(TEXT).toMatch(/DESIGN_SELECT_DIFF_BASE:.*github\.event\.merge_group\.base_sha/);
    expect(TEXT).toMatch(/DESIGN_SELECT_DIFF_BASE:.*github\.event\.pull_request\.base\.sha/);
    expect(TEXT).toMatch(/BASE_SHA:.*github\.event\.merge_group\.base_sha/);
    expect(TEXT).toMatch(/BASE_SHA:.*github\.event\.pull_request\.base\.sha/);
  });

  it("design-visual-verify concludes on an always-running verdict job", () => {
    const TEXT = uncommented(read("design-visual-verify.yml"));
    expect(TEXT).toMatch(/^ {2}verdict:$/m);
    expect(TEXT).toMatch(/^ {4}if: \$\{\{ always\(\) \}\}$/m);
  });

  it("execution-plane-e2e gates its discovery on an in-workflow path selection", () => {
    const TEXT = uncommented(read("execution-plane-e2e.yml"));
    expect(TEXT).toMatch(/^ {2}select:$/m);
    expect(TEXT).toContain("node scripts/ci/merge-group-path-select.mjs");
    expect(TEXT).toMatch(
      /^ {4}if: \$\{\{ needs\.select\.outputs\.applies == 'true' \}\}$/m,
    );
    // The verdict never reports a healthy tier on a group the selection let
    // through: every battery guard is conditioned on the selection saying yes.
    expect(TEXT).toMatch(/needs\.select\.outputs\.applies == 'true' &&/);
  });
});
