// Unit tests for scripts/ci/merge-readiness.mjs (engineering#658 item 3).
//
// The fixture matrix the card asks for: all expected green -> PASS; one
// missing -> FAIL; one failed -> FAIL; a duplicate source -> FAIL; an unknown
// check -> PASS with a report line; the queue event with a moved head -> FAIL.

import { describe, expect, it } from "vitest";

import {
  DEADLINE_MINUTES,
  DEFAULT_JOB_TIMEOUT_MINUTES,
  EXIT_PENDING,
  MAX_WAIT_MINUTES,
  QUEUE_TIMEOUT_MINUTES,
  WAIT_MARGIN_MINUTES,
  evaluateReadiness,
  exitCodeFor,
  isSettled,
  parseBoundaryRecords,
  pathsApply,
  pullNumberFromQueueRef,
  resolveCandidateSha,
  validateApprovedHead,
  validateInventory,
  verificationBoundaryVerdict,
  waitBudgetMinutes,
} from "../merge-readiness.mjs";
// Namespace import for the sha-splitting road, so a missing export shows up as
// a failing case here instead of a module-load error across the whole file.
import * as readiness from "../merge-readiness.mjs";

const HEAD = "1066982" + "0d282ab57c466cfa8d2c5ab35324d4fd2";

const inventory = () => ({
  version: 1,
  selfContext: "merge-readiness / merge-readiness",
  deadlineMinutes: DEADLINE_MINUTES,
  expected: [
    { context: "build", app: "github-actions", workflow: ".github/workflows/gates.yml", paths: ["**"] },
    { context: "source-leak-gate / source-leak-gate", app: "github-actions", workflow: ".github/workflows/source-leak-gate.yml", paths: ["**"] },
    { context: "design-visual-verify", app: "github-actions", workflow: ".github/workflows/design-visual-verify.yml", paths: ["src/**"] },
  ],
});

const ok = (name, workflow = "wf") => ({ name, status: "completed", conclusion: "success", app: "github-actions", workflow });

const greenChecks = () => [
  ok("build", "gates.yml"),
  ok("source-leak-gate / source-leak-gate", "source-leak-gate.yml"),
  ok("design-visual-verify", "design-visual-verify.yml"),
];

const evalPr = (checks, changedPaths = ["src/app/page.tsx"]) =>
  evaluateReadiness({ inventory: inventory(), checks, changedPaths, eventName: "pull_request" });

describe("merge-readiness fixture matrix", () => {
  it("PASSes when every applicable expected context is green", () => {
    const r = evalPr(greenChecks());
    expect(r.failures).toEqual([]);
    expect(r.verdict).toBe("PASS");
    expect(r.waitedOn).toHaveLength(3);
  });

  it("FAILs when one expected context is missing", () => {
    const r = evalPr(greenChecks().filter((c) => c.name !== "build"));
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join("\n")).toMatch(/^missing: no check run named 'build'/m);
  });

  it("FAILs when one expected context failed", () => {
    const checks = greenChecks();
    checks[0] = { ...checks[0], conclusion: "failure" };
    const r = evalPr(checks);
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join("\n")).toMatch(/failed: 'build'/);
  });

  it("FAILs on a skipped conclusion for a context that is not marked skippable", () => {
    const checks = greenChecks();
    checks[0] = { ...checks[0], conclusion: "skipped" };
    const r = evalPr(checks);
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join("\n")).toMatch(/was skipped: 'build'/);
  });

  it("PASSes on a skipped conclusion for a guarded (skippable) context, with a report line", () => {
    const inv = inventory();
    inv.expected[0] = { ...inv.expected[0], skippable: true };
    const checks = greenChecks();
    checks[0] = { ...checks[0], conclusion: "skipped" };
    const r = evaluateReadiness({ inventory: inv, checks, changedPaths: ["src/a.ts"], eventName: "pull_request" });
    expect(r.verdict).toBe("PASS");
    expect(r.reports.join("\n")).toMatch(/skipped \(guarded job, accepted\): 'build'/);
  });

  it("FAILs on a cancelled and on a timed-out conclusion", () => {
    for (const [conclusion, label] of [["cancelled", "cancelled"], ["timed_out", "timed out"]]) {
      const checks = greenChecks();
      checks[0] = { ...checks[0], conclusion };
      const r = evalPr(checks);
      expect(r.verdict).toBe("FAIL");
      expect(r.failures.join("\n")).toContain(`${label}: 'build'`);
    }
  });

  // A deadline is never a readiness verdict (cinatra#3391): a required run that
  // is still queued or in progress when the wait runs out is PENDING — the
  // candidate is not red, and a re-run picks up where this one left off.
  const running = (status) => {
    const checks = greenChecks();
    checks[0] = { name: "build", status, conclusion: null, app: "github-actions", workflow: "gates.yml" };
    return checks;
  };

  it("reports PENDING, never a failure, when an expected context is still in progress at the deadline", () => {
    const r = evalPr(running("in_progress"));
    expect(r.verdict).toBe("PENDING");
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([]);
    expect(r.pending.join("\n")).toMatch(
      /^pending: 'build' is still 'in_progress' after 90 minutes — not a failure$/m,
    );
  });

  it("reports PENDING when an expected context is still queued at the deadline", () => {
    const r = evalPr(running("queued"));
    expect(r.verdict).toBe("PENDING");
    expect(r.failures).toEqual([]);
    expect(r.pending.join("\n")).toMatch(
      /^pending: 'build' is still 'queued' after 90 minutes — not a failure$/m,
    );
  });

  it("names the minutes actually waited in the pending text", () => {
    const r = evaluateReadiness({
      inventory: inventory(),
      checks: running("queued"),
      changedPaths: ["src/app/page.tsx"],
      eventName: "pull_request",
      waitedMinutes: 105,
    });
    expect(r.pending.join("\n")).toContain("after 105 minutes");
  });

  it("stays a FAIL when a real red sits beside a still-queued context", () => {
    const checks = running("queued");
    checks[1] = { ...checks[1], conclusion: "failure" };
    const r = evalPr(checks);
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join("\n")).toMatch(/failed: 'source-leak-gate/);
  });

  it("FAILs on a duplicate source for one expected context", () => {
    const r = evalPr([...greenChecks(), ok("build", "gates-copy.yml")]);
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join("\n")).toMatch(/duplicate-source: 'build' was reported 2 times from 2 source/);
  });

  it("PASSes when a re-run left two runs of one name from ONE source and the latest succeeded", () => {
    const first = { id: 101, name: "build", status: "completed", conclusion: "failure", completedAt: "2026-09-10T09:00:00Z", app: "github-actions", workflow: "gates.yml" };
    const latest = { ...first, id: 102, conclusion: "success", completedAt: "2026-09-10T10:00:00Z" };
    const r = evalPr([...greenChecks().filter((c) => c.name !== "build"), first, latest]);
    expect(r.failures).toEqual([]);
    expect(r.verdict).toBe("PASS");
    expect(r.reports.join("\n")).toMatch(/re-run \(the latest of 2 runs from one source decides\): 'build'/);
  });

  it("FAILs when the latest of two same-source runs of one name is the failed one", () => {
    const first = { id: 101, name: "build", status: "completed", conclusion: "success", completedAt: "2026-09-10T09:00:00Z", app: "github-actions", workflow: "gates.yml" };
    const latest = { ...first, id: 102, conclusion: "failure", completedAt: "2026-09-10T10:00:00Z" };
    const r = evalPr([...greenChecks().filter((c) => c.name !== "build"), latest, first]);
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join("\n")).toMatch(/failed: 'build'/);
  });

  it("falls back to completedAt when two same-source runs of one name carry no id", () => {
    const first = { name: "build", status: "completed", conclusion: "failure", completedAt: "2026-09-10T09:00:00Z", app: "github-actions", workflow: "gates.yml" };
    const latest = { ...first, conclusion: "success", completedAt: "2026-09-10T10:00:00Z" };
    const r = evalPr([...greenChecks().filter((c) => c.name !== "build"), latest, first]);
    expect(r.verdict).toBe("PASS");
    expect(r.failures).toEqual([]);
  });

  it("keeps duplicate-source for two runs of one name from DIFFERENT sources, whatever their ids", () => {
    const a = { id: 201, name: "build", status: "completed", conclusion: "failure", completedAt: "2026-09-10T09:00:00Z", app: "github-actions", workflow: "gates.yml" };
    const b = { ...a, id: 202, conclusion: "success", completedAt: "2026-09-10T10:00:00Z", workflow: "gates-copy.yml" };
    const r = evalPr([...greenChecks().filter((c) => c.name !== "build"), a, b]);
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join("\n")).toMatch(/duplicate-source: 'build' was reported 2 times from 2 source/);
  });

  it("FAILs when an expected context comes from an untrusted app", () => {
    const checks = greenChecks();
    checks[0] = { ...checks[0], app: "some-other-app" };
    const r = evalPr(checks);
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join("\n")).toMatch(/untrusted-source: 'build' was reported by app 'some-other-app'/);
  });

  it("PASSes with a report line for an unknown check, and never waits on it", () => {
    const r = evalPr([...greenChecks(), ok("some-new-experiment", "experiment.yml")]);
    expect(r.verdict).toBe("PASS");
    expect(r.reports.join("\n")).toMatch(/unknown check .*reported, not waited on\): some-new-experiment/);
    expect(r.waitedOn).not.toContain("some-new-experiment");
  });

  it("excludes itself: its own context is never waited on, even when reported", () => {
    const r = evalPr([...greenChecks(), { name: "merge-readiness / merge-readiness", status: "in_progress", conclusion: null, app: "github-actions", workflow: "merge-readiness.yml" }]);
    expect(r.verdict).toBe("PASS");
    expect(r.waitedOn).not.toContain("merge-readiness / merge-readiness");
    expect(r.reports.join("\n")).not.toContain("merge-readiness / merge-readiness");
  });

  it("skips a path-inapplicable expected context and records why", () => {
    const r = evalPr(greenChecks().filter((c) => c.name !== "design-visual-verify"), ["README.md"]);
    expect(r.verdict).toBe("PASS");
    expect(r.waitedOn).not.toContain("design-visual-verify");
    expect(r.reports.join("\n")).toMatch(/not applicable to this candidate .*: design-visual-verify/);
  });
});

describe("merge-readiness queue arm", () => {
  const queueEval = (queue, checks = greenChecks()) =>
    evaluateReadiness({ inventory: inventory(), checks, changedPaths: ["src/a.ts"], eventName: "merge_group", queue });

  const record = (state, sha) => `**In simple words:** x\n\nVerification boundary: ${state} at ${sha}\n`;

  it("PASSes on the queue event when the head is unmoved and the boundary is candidate", () => {
    const r = queueEval({ approvedHead: HEAD, pullRequestHead: HEAD, recordText: record("candidate", HEAD) });
    expect(r.failures).toEqual([]);
    expect(r.verdict).toBe("PASS");
  });

  it("FAILs on the queue event when the approved head moved", () => {
    const moved = "a".repeat(40);
    const r = queueEval({ approvedHead: HEAD, pullRequestHead: moved, recordText: record("candidate", moved) });
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join("\n")).toMatch(/approved-head: the approved head moved/);
  });

  it("FAILs when the last boundary record for the head is not candidate or promoted", () => {
    const text = `${record("candidate", HEAD)}Verification boundary: proof-failed at ${HEAD}\n`;
    const r = queueEval({ approvedHead: HEAD, pullRequestHead: HEAD, recordText: text });
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join("\n")).toMatch(/verification-boundary: the last verification-boundary record .* is 'proof-failed'/);
  });

  it("does not evaluate the queue arm on a pull_request event", () => {
    const r = evalPr(greenChecks());
    expect(r.failures.join("\n")).not.toMatch(/approved-head|verification-boundary/);
  });
});

describe("the check runs are read from the sha that carries them", () => {
  // The pull request's ephemeral TEST MERGE commit: GitHub reports no check
  // runs on it, which is exactly why the evaluator may not look there.
  const MERGE_SHA = "e".repeat(40);
  const PR_HEAD = "f".repeat(40);
  const QUEUE_SHA = "b".repeat(40);

  const runsOnPullRequest = { [PR_HEAD]: greenChecks(), [MERGE_SHA]: [] };
  const runsOnQueue = { [QUEUE_SHA]: greenChecks(), [PR_HEAD]: [], [MERGE_SHA]: [] };

  it("reads a pull_request candidate's runs from the head sha and still records the test-merge sha", () => {
    const { lookupSha, recordedSha } = readiness.resolveCandidateShas({
      eventName: "pull_request",
      githubSha: MERGE_SHA,
      headSha: PR_HEAD,
      payload: {},
    });
    expect(lookupSha).toBe(PR_HEAD);
    expect(recordedSha).toBe(MERGE_SHA);

    const r = evaluateReadiness({
      inventory: inventory(),
      checks: runsOnPullRequest[lookupSha],
      changedPaths: ["src/a.ts"],
      eventName: "pull_request",
    });
    expect(r.failures).toEqual([]);
    expect(r.verdict).toBe("PASS");

    // The converse: looking the runs up on the test-merge sha reports every
    // applicable expected context as missing — the measured failure shape.
    const onMerge = evaluateReadiness({
      inventory: inventory(),
      checks: runsOnPullRequest[recordedSha],
      changedPaths: ["src/a.ts"],
      eventName: "pull_request",
    });
    expect(onMerge.verdict).toBe("FAIL");
    expect(onMerge.failures).toHaveLength(3);
    expect(onMerge.failures.every((f) => f.startsWith("missing:"))).toBe(true);
  });

  it("keeps the merge_group road on the queue's own commit, which carries its runs", () => {
    const { lookupSha, recordedSha } = readiness.resolveCandidateShas({
      eventName: "merge_group",
      githubSha: MERGE_SHA,
      headSha: PR_HEAD,
      payload: { merge_group: { head_sha: QUEUE_SHA } },
    });
    expect(lookupSha).toBe(QUEUE_SHA);
    expect(recordedSha).toBe(QUEUE_SHA);

    const r = evaluateReadiness({
      inventory: inventory(),
      checks: runsOnQueue[lookupSha],
      changedPaths: ["src/a.ts"],
      eventName: "merge_group",
      queue: {
        approvedHead: HEAD,
        pullRequestHead: HEAD,
        recordText: `Verification boundary: candidate at ${HEAD}\n`,
      },
    });
    expect(r.failures).toEqual([]);
    expect(r.verdict).toBe("PASS");
  });

  it("fails closed on a pull_request event whose head sha the workflow did not pass", () => {
    expect(() =>
      readiness.resolveCandidateShas({ eventName: "pull_request", githubSha: MERGE_SHA, headSha: "", payload: {} }),
    ).toThrow(/without the pull request's head sha/);
    expect(() =>
      readiness.resolveCandidateShas({ eventName: "pull_request", githubSha: MERGE_SHA, payload: {} }),
    ).toThrow(/without the pull request's head sha/);
  });

  it("names both shas in the summary: the recorded candidate and the sha the runs were read from", () => {
    const summary = readiness.renderSummary({
      candidateSha: MERGE_SHA,
      lookupSha: PR_HEAD,
      eventName: "pull_request",
      result: evalPr(greenChecks()),
    });
    expect(summary).toContain(`candidate: ${MERGE_SHA}`);
    expect(summary).toContain(`checks read from: ${PR_HEAD}`);

    // On the queue road the two are one sha and no second line is rendered.
    const queued = readiness.renderSummary({
      candidateSha: QUEUE_SHA,
      lookupSha: QUEUE_SHA,
      eventName: "merge_group",
      result: evalPr(greenChecks()),
    });
    expect(queued).not.toContain("checks read from:");
  });
});

describe("candidate sha resolution", () => {
  it("uses github.sha for the pull-request test merge", () => {
    expect(resolveCandidateSha({ eventName: "pull_request", githubSha: HEAD, payload: {} })).toBe(HEAD);
  });

  it("uses merge_group.head_sha for the queue candidate", () => {
    const queued = "b".repeat(40);
    expect(
      resolveCandidateSha({ eventName: "merge_group", githubSha: HEAD, payload: { merge_group: { head_sha: queued } } }),
    ).toBe(queued);
  });

  it("fails closed on an unsupported event and on a missing payload field", () => {
    expect(() => resolveCandidateSha({ eventName: "push", githubSha: HEAD, payload: {} })).toThrow(/unsupported event 'push'/);
    expect(() => resolveCandidateSha({ eventName: "merge_group", githubSha: HEAD, payload: {} })).toThrow(/merge_group.head_sha/);
  });

  it("reads the queued pull-request number out of the queue ref", () => {
    expect(pullNumberFromQueueRef("refs/heads/gh-readonly-queue/main/pr-3350-1066982")).toBe(3350);
    expect(pullNumberFromQueueRef("refs/heads/main")).toBeNull();
  });
});

describe("the deadline is shorter than the queue timeout", () => {
  it("keeps DEADLINE_MINUTES under the queue's 120-minute check_response_timeout_minutes", () => {
    expect(QUEUE_TIMEOUT_MINUTES).toBe(120);
    expect(DEADLINE_MINUTES).toBeLessThan(QUEUE_TIMEOUT_MINUTES);
  });
});

describe("the wait follows the longest job budget of the evaluated workflows", () => {
  // Each expected entry carries the `timeout-minutes` of the job that reports
  // it, derived into the inventory by scripts/ci/merge-readiness-inventory.mjs.
  const withBudgets = (budgets) => {
    const inv = inventory();
    inv.expected = inv.expected.map((e, i) => ({ ...e, timeoutMinutes: budgets[i] }));
    return inv;
  };

  it("reads the bound from the inventory: the longest applicable job budget plus the margin", () => {
    const inv = withBudgets([25, 45, 70]);
    expect(waitBudgetMinutes({ inventory: inv, changedPaths: ["src/a.ts"] })).toBe(70 + WAIT_MARGIN_MINUTES);
  });

  it("ignores the budget of a context this candidate's paths do not apply to", () => {
    const inv = withBudgets([25, 45, 70]);
    expect(waitBudgetMinutes({ inventory: inv, changedPaths: ["README.md"] })).toBe(45 + WAIT_MARGIN_MINUTES);
  });

  it("treats a job with no declared timeout-minutes as GitHub's own default budget", () => {
    const inv = withBudgets([25, null, 45]);
    expect(DEFAULT_JOB_TIMEOUT_MINUTES).toBe(360);
    expect(waitBudgetMinutes({ inventory: inv, changedPaths: ["README.md"] })).toBe(MAX_WAIT_MINUTES);
  });

  it("never waits past the upper bound the evaluator's own job timeout allows", () => {
    const inv = withBudgets([600, 600, 600]);
    expect(waitBudgetMinutes({ inventory: inv, changedPaths: ["src/a.ts"] })).toBe(MAX_WAIT_MINUTES);
    expect(MAX_WAIT_MINUTES).toBeLessThan(QUEUE_TIMEOUT_MINUTES);
    expect(MAX_WAIT_MINUTES).toBeGreaterThan(DEADLINE_MINUTES);
  });

  it("falls back to the inventory's deadlineMinutes when no expected context applies", () => {
    const inv = withBudgets([25, 45, 70]);
    inv.expected = inv.expected.map((e) => ({ ...e, paths: ["src/**"] }));
    expect(waitBudgetMinutes({ inventory: inv, changedPaths: ["README.md"] })).toBe(inv.deadlineMinutes);
  });
});

describe("a pending outcome exits non-zero, and distinctly from a failure", () => {
  it("gives PASS, PENDING and FAIL three different exit codes", () => {
    expect(exitCodeFor({ verdict: "PASS" })).toBe(0);
    expect(exitCodeFor({ verdict: "PENDING" })).toBe(EXIT_PENDING);
    expect(exitCodeFor({ verdict: "FAIL" })).toBe(1);
    expect(EXIT_PENDING).not.toBe(0);
    expect(EXIT_PENDING).not.toBe(1);
  });

  it("renders the pending lines in the job summary", () => {
    const checks = greenChecks();
    checks[0] = { name: "build", status: "queued", conclusion: null, app: "github-actions", workflow: "gates.yml" };
    const summary = readiness.renderSummary({
      candidateSha: HEAD,
      lookupSha: HEAD,
      eventName: "pull_request",
      result: evalPr(checks),
    });
    expect(summary).toContain("merge-readiness: PENDING");
    expect(summary).toContain("pending: 'build' is still 'queued' after 90 minutes — not a failure");
  });
});

describe("verification-boundary parser", () => {
  it("reads column-0 records in document order", () => {
    const text = `Verification boundary: candidate-pending-ci at ${HEAD} (checks: build; proof)\nVerification boundary: candidate at ${HEAD}\n`;
    expect(parseBoundaryRecords(text)).toEqual([
      { state: "candidate-pending-ci", sha: HEAD },
      { state: "candidate", sha: HEAD },
    ]);
  });

  it("accepts a promoted last record and rejects a pending-ci last record", () => {
    expect(verificationBoundaryVerdict(`Verification boundary: promoted at ${HEAD}`, HEAD).ok).toBe(true);
    expect(verificationBoundaryVerdict(`Verification boundary: candidate-pending-ci at ${HEAD}`, HEAD).ok).toBe(false);
  });

  it("fails closed when no record names the head", () => {
    const v = verificationBoundaryVerdict(`Verification boundary: candidate at ${"c".repeat(40)}`, HEAD);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/no verification-boundary record names the head/);
  });
});

describe("approved-head revalidation", () => {
  it("fails closed when no approval could be resolved", () => {
    expect(validateApprovedHead({ approvedHead: null, pullRequestHead: HEAD }).ok).toBe(false);
    expect(validateApprovedHead({ approvedHead: HEAD, pullRequestHead: null }).ok).toBe(false);
  });
});

describe("path applicability", () => {
  it("treats ['**'] as always-on and matches nested globs", () => {
    expect(pathsApply(["**"], ["anything"])).toBe(true);
    expect(pathsApply(["src/**"], ["src/a/b.ts"])).toBe(true);
    expect(pathsApply(["src/**"], ["docs/a.md"])).toBe(false);
    expect(pathsApply(["packages/*/src/**"], ["packages/cli/src/x.ts"])).toBe(true);
  });

  it("treats an unknown diff as applicable (fails closed onto waiting)", () => {
    expect(pathsApply(["src/**"], null)).toBe(true);
  });
});

describe("settling predicate", () => {
  it("is unsettled while an applicable context is missing or running", () => {
    const inv = inventory();
    const paths = ["src/a.ts"];
    expect(isSettled({ inventory: inv, checks: greenChecks(), changedPaths: paths })).toBe(true);
    expect(isSettled({ inventory: inv, checks: greenChecks().slice(1), changedPaths: paths })).toBe(false);
    const running = greenChecks();
    running[0] = { ...running[0], status: "in_progress", conclusion: null };
    expect(isSettled({ inventory: inv, checks: running, changedPaths: paths })).toBe(false);
  });
});

describe("inventory validation fails closed", () => {
  it("accepts the fixture inventory", () => {
    expect(validateInventory(inventory()).ok).toBe(true);
  });

  it("rejects a deadline at or beyond the queue timeout", () => {
    const inv = { ...inventory(), deadlineMinutes: QUEUE_TIMEOUT_MINUTES };
    expect(validateInventory(inv).problems.join("\n")).toMatch(/must be shorter than the queue timeout/);
  });

  it("rejects an entry without a trusted app, a duplicate context, and a self-listing", () => {
    const noApp = inventory();
    noApp.expected[0] = { ...noApp.expected[0], app: "" };
    expect(validateInventory(noApp).problems.join("\n")).toMatch(/names no trusted GitHub App/);

    const dup = inventory();
    dup.expected.push({ ...dup.expected[0] });
    expect(validateInventory(dup).problems.join("\n")).toMatch(/is listed twice/);

    const self = inventory();
    self.expected.push({ context: self.selfContext, app: "github-actions", workflow: "w", paths: ["**"] });
    expect(validateInventory(self).problems.join("\n")).toMatch(/would wait on itself/);
  });

  it("rejects a non-object and a malformed paths applicability", () => {
    expect(validateInventory(null).ok).toBe(false);
    const bad = inventory();
    bad.expected[0] = { ...bad.expected[0], paths: [] };
    expect(validateInventory(bad).problems.join("\n")).toMatch(/malformed 'paths' applicability/);
    const badFlag = inventory();
    badFlag.expected[0] = { ...badFlag.expected[0], skippable: "yes" };
    expect(validateInventory(badFlag).problems.join("\n")).toMatch(/non-boolean 'skippable' flag/);
  });

  it("accepts a per-entry job budget and rejects a malformed one", () => {
    const good = inventory();
    good.expected[0] = { ...good.expected[0], timeoutMinutes: 30 };
    good.expected[1] = { ...good.expected[1], timeoutMinutes: null };
    expect(validateInventory(good).ok).toBe(true);

    const bad = inventory();
    bad.expected[0] = { ...bad.expected[0], timeoutMinutes: 0 };
    expect(validateInventory(bad).problems.join("\n")).toMatch(/malformed 'timeoutMinutes'/);
  });
});
