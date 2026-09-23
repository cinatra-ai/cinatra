// Unit tests for scripts/ci/merge-readiness.mjs (engineering#658 item 3).
//
// The fixture matrix the card asks for: all expected green -> PASS; one
// missing -> FAIL; one failed -> FAIL; a duplicate source -> FAIL; an unknown
// check -> PASS with a report line; the queue event with a moved head -> FAIL.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  pathsApply,
  resolveCandidateSha,
  validateInventory,
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

const GROUP = "b".repeat(40), BASE = "c".repeat(40), TREE = "d".repeat(40), REPO = "cinatra-ai/cinatra";
const queueBinding = () => ({ schema: "cinatra.queue-binding/v1", repository: REPO, repositoryId: 10, pullRequest: 7,
  headSha: HEAD, headRepositoryId: 10, baseRef: "main", baseSha: BASE, groupHeadSha: GROUP, parents: [BASE, HEAD], groupTree: TREE, authority: "delegated-v1" });
const boundaryBinding = () => ({ schema: "cinatra.verification-boundary-current/v1", repository: REPO, repositoryId: 10,
  pullRequest: 7, headSha: HEAD, state: "candidate", commentId: 100, digest: "e".repeat(64) });
const queueSnapshot = () => ({ binding: queueBinding(), boundary: boundaryBinding(), identity: [7], files: [], changedPaths: ["src/a.ts"] });
const queuePair = () => { const before = queueSnapshot(); return { before, after: structuredClone(before) }; };

describe("authenticated merge-readiness queue arm", () => {
  const queueEval = (queue, checks = greenChecks()) => evaluateReadiness({ inventory: inventory(), checks,
    changedPaths: ["src/a.ts"], eventName: "merge_group", queue });
  it("accepts unchanged authenticated queue and boundary snapshots while retaining real CI verdicts", () => {
    expect(queueEval(queuePair()).verdict).toBe("PASS");
    const checks = greenChecks(); checks[0].conclusion = "failure";
    expect(queueEval(queuePair(), checks).verdict).toBe("FAIL");
    checks[0].status = "in_progress"; checks[0].conclusion = null;
    expect(queueEval(queuePair(), checks).verdict).toBe("PENDING");
  });
  it("rejects editable-body, prefix-head and missing before/after authority", () => {
    for (const value of [undefined, { approvedHead: HEAD, pullRequestHead: HEAD, recordText: `Verification boundary: candidate at ${HEAD}` },
      { before: queueSnapshot() }]) expect(queueEval(value).verdict).toBe("FAIL");
    const value = queuePair(); value.after.boundary.headSha = HEAD.slice(0, 7);
    expect(queueEval(value).verdict).toBe("FAIL");
  });
  it("rejects any final authority, receipt, identity or file change, including another positive receipt", () => {
    for (const change of [s => { s.binding.groupTree = "f".repeat(40); }, s => { s.binding.authority = "review"; },
      s => { s.boundary.commentId++; }, s => { s.boundary.digest = "f".repeat(64); }, s => { s.boundary.state = "promoted"; },
      s => { s.identity.push("changed"); }, s => { s.files.push({ filename: "other" }); }, s => { s.changedPaths = []; }]) {
      const value = queuePair(); change(value.after); expect(queueEval(value).verdict).toBe("FAIL");
    }
  });
  it("keeps ordinary PR readiness independent of boundary publication", () => {
    expect(evalPr(greenChecks()).verdict).toBe("PASS");
  });
});

describe("strict engine report binding", () => {
  const expected = { repository: REPO, groupHeadSha: GROUP, baseSha: BASE, baseRef: "main" };
  const report = () => ({ arm: "merge-group", mode: "enforce", repo: REPO, apiSkippedReason: null, findingCount: 0, findings: [], queueBinding: queueBinding() });
  it("accepts both engine authority paths and only exact boundary scope", () => {
    const value = report(); expect(readiness.validateQueueBinding(value, expected)).toEqual(queueBinding());
    value.queueBinding.authority = "review"; value.queueBinding.headRepositoryId = 11;
    expect(readiness.validateQueueBinding(value, expected).headRepositoryId).toBe(11);
    expect(readiness.validateBoundaryBinding(boundaryBinding(), queueBinding())).toEqual(boundaryBinding());
  });
  it("refuses warn, offline, failed, malformed and mismatched engine reports", () => {
    for (const change of [r => { r.mode = "warn"; }, r => { r.apiSkippedReason = "offline"; }, r => { r.findings = [{}]; },
      r => { r.findingCount = 1; }, r => { r.arm = "pre-merge"; }, r => { r.repo = "cinatra-ai/ci"; },
      r => { r.queueBinding.extra = true; }, r => { r.queueBinding.pullRequest = "7"; }, r => { r.queueBinding.headSha = HEAD.slice(0, 12); },
      r => { r.queueBinding.repositoryId = 0; }, r => { r.queueBinding.headRepositoryId = 11; },
      r => { r.queueBinding.baseSha = GROUP; }, r => { r.queueBinding.baseRef = "release"; },
      r => { r.queueBinding.groupHeadSha = BASE; }, r => { r.queueBinding.parents.reverse(); }]) {
      const value = report(); change(value); expect(() => readiness.validateQueueBinding(value, expected)).toThrow();
    }
    for (const field of Object.keys(queueBinding())) {
      const value = report(); delete value.queueBinding[field]; expect(() => readiness.validateQueueBinding(value, expected)).toThrow();
    }
  });
  it("requires full authenticated boundary identity and eligible state without a body fallback", () => {
    for (const change of [b => { b.schema = "other/v1"; }, b => { b.repository = "cinatra-ai/ci"; }, b => { b.repositoryId++; },
      b => { b.pullRequest++; }, b => { b.headSha = GROUP; }, b => { b.state = "not-a-lane"; }, b => { b.state = "proof-failed"; },
      b => { b.state = "candidate-pending-ci"; }, b => { b.commentId = "100"; }, b => { b.digest = "e".repeat(63); },
      b => { b.recordText = `Verification boundary: candidate at ${HEAD}`; }]) {
      const value = boundaryBinding(); change(value); expect(() => readiness.validateBoundaryBinding(value, queueBinding())).toThrow();
    }
  });
});

function queueTransport() {
  const calls = [], engineCalls = [];
  const pull = { number: 7, state: "open", merged: false, draft: false, changed_files: 1,
    head: { sha: HEAD, ref: "feature/change", repo: { id: 10, full_name: REPO } },
    base: { ref: "main", sha: "f".repeat(40), repo: { id: 10, full_name: REPO } } };
  const file = { filename: "docs/new.md", previous_filename: "src/old.ts", status: "renamed", sha: HEAD, additions: 0, deletions: 0, changes: 0 };
  const state = { pull, pages: [[file]], final: null };
  const get = async endpoint => {
    calls.push(endpoint);
    if (endpoint.endsWith("/pulls/7")) return structuredClone(calls.filter(c => c === endpoint).length > 1 && state.final ? state.final : state.pull);
    const page = /\/files\?per_page=100&page=(\d+)$/.exec(endpoint);
    if (page) return structuredClone(state.pages[Number(page[1]) - 1] ?? []);
    throw new Error("unexpected test endpoint");
  };
  const engine = (kind, args, group) => {
    engineCalls.push({ kind, args, group });
    return kind === "attribution" ? { arm: "merge-group", mode: "enforce", repo: REPO, apiSkippedReason: null, findingCount: 0, findings: [], queueBinding: queueBinding() } : boundaryBinding();
  };
  const args = { repo: REPO, payload: { merge_group: { head_sha: GROUP, base_sha: BASE, base_ref: "refs/heads/main", head_ref: "untrusted/pr-999-ref" } }, lookupSha: GROUP, recordedSha: GROUP, get, engine };
  return { state, calls, engineCalls, get, args, file };
}

describe("queue collector uses verified identity and complete file inventory", () => {
  it("emits exact engine argv and uses its PR identity rather than the ref or a review-list guess", async () => {
    const f = queueTransport(), value = await readiness.readQueueEvidence(f.args);
    expect(f.engineCalls).toEqual([
      { kind: "attribution", group: GROUP, args: ["--arm", "merge-group", "--mode", "enforce", "--format", "json", "--repo", REPO, "--merge-group-head", GROUP, "--merge-group-base", BASE, "--gate-arm-wait-ms", "0"] },
      { kind: "boundary", group: GROUP, args: ["--repo", REPO, "--pr", "7", "--head", HEAD] },
    ]);
    expect(value.changedPaths).toEqual(["docs/new.md", "src/old.ts"]);
    expect(readiness.pathsApply(["src/**"], value.changedPaths)).toBe(true);
    expect(f.calls.some(c => c.includes("999") || c.includes("reviews"))).toBe(false);
  });
  it("finishes terminal pagination and matches the exact live count", async () => {
    const f = queueTransport(); f.state.pages = [Array.from({ length: 100 }, (_, i) => ({ ...f.file, filename: `src/${i}.ts` })), [{ ...f.file, filename: "src/last.ts" }]];
    f.state.pull.changed_files = 101;
    expect((await readiness.readQueuedFiles(f.get, queueBinding())).files).toHaveLength(101);
    expect(f.calls.at(-2)).toMatch(/page=2$/);
  });
  it("refuses truncated, duplicate, malformed and over-limit file responses", async () => {
    for (const change of [f => { f.state.pull.changed_files = 2; }, f => { f.state.pages = [[f.file, f.file]]; },
      f => { f.state.pages = [[]]; }, f => { f.state.pages = [{}]; }, f => { f.state.pages[0][0].sha = "short"; },
      f => { delete f.state.pages[0][0].previous_filename; }, f => { f.state.pages[0][0].filename = "../escape"; },
      f => { f.state.pull.changed_files = 3001; }]) {
      const f = queueTransport(); change(f); await expect(readiness.readQueuedFiles(f.get, queueBinding())).rejects.toThrow();
    }
  });
  it("binds initial and final PR identity independently of valid helper reports", async () => {
    for (const change of [p => { p.head.sha = GROUP; }, p => { p.head.repo.id++; }, p => { p.base.repo.id++; },
      p => { p.head.ref = "retargeted"; }, p => { p.head.repo.full_name = "cinatra-ai/ci"; }, p => { p.base.ref = "release"; },
      p => { p.state = "closed"; }, p => { p.merged = true; }, p => { p.draft = true; }, p => { p.changed_files++; }]) {
      const f = queueTransport(); f.state.final = structuredClone(f.state.pull); change(f.state.final);
      await expect(readiness.readQueueEvidence(f.args)).rejects.toThrow();
    }
    const f = queueTransport(); f.state.pull.head.repo.id++;
    await expect(readiness.readQueueEvidence(f.args)).rejects.toThrow();
  });
  it("refuses malformed event identity before invoking either helper", async () => {
    for (const change of [a => { a.recordedSha = HEAD; }, a => { a.lookupSha = HEAD; }, a => { a.payload.merge_group.base_sha = "short"; },
      a => { a.payload.merge_group.base_ref = "main"; }, a => { a.repo = "foreign/../repo"; }]) {
      const f = queueTransport(); change(f.args); await expect(readiness.readQueueEvidence(f.args)).rejects.toThrow(); expect(f.engineCalls).toEqual([]);
    }
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
      queue: queuePair(),
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

describe("a check run's source is the workflow that produced it, not its check suite", () => {
  // A draft-to-ready flip runs every `ready_for_review` workflow a second time
  // at ONE head: two check suites, one workflow, one context. Keying the source
  // on the check-suite id read that as two sources (cinatra#3391).
  const suiteIndex = () =>
    readiness.workflowPathsBySuite([
      { check_suite_id: 93602180530, path: ".github/workflows/gates.yml" },
      { check_suite_id: 93601966667, path: ".github/workflows/gates.yml" },
      { check_suite_id: 93601966999, path: ".github/workflows/source-leak-gate.yml" },
    ]);

  const suiteRun = (id, suiteId, over = {}) => ({
    id,
    name: "build",
    status: "completed",
    conclusion: "success",
    completedAt: "2026-09-11T01:55:00Z",
    app: "github-actions",
    checkSuiteId: suiteId,
    workflow: `check_suite:${suiteId}`,
    ...over,
  });

  it("indexes the head's workflow runs by check-suite id", () => {
    const index = readiness.workflowPathsBySuite([
      { check_suite_id: 93602180530, path: ".github/workflows/gates.yml" },
      { check_suite_id: 93601966667, path: ".github/workflows/gates.yml" },
      { check_suite_id: null, path: ".github/workflows/gates.yml" },
      { check_suite_id: 7, path: "" },
    ]);
    expect(index.get(93602180530)).toBe(".github/workflows/gates.yml");
    expect(index.get(93601966667)).toBe(".github/workflows/gates.yml");
    expect(index.get(7)).toBeUndefined();
    expect(index.size).toBe(2);
  });

  it("resolves a check run to its workflow path, and keeps the check-suite id when no run maps", () => {
    const [resolved, unmapped] = readiness.resolveCheckWorkflows(
      [suiteRun(1, 93602180530), suiteRun(2, 4242)],
      suiteIndex(),
    );
    expect(readiness.sourceOf(resolved)).toBe("github-actions:.github/workflows/gates.yml");
    expect(readiness.sourceOf(unmapped)).toBe("github-actions:check_suite:4242");
  });

  it("reads two check suites of ONE workflow at one head as one source, the latest run deciding", () => {
    const draftStub = suiteRun(103124792060, 93602180530, { conclusion: "failure", completedAt: "2026-09-11T01:49:00Z" });
    const ready = suiteRun(103124792061, 93601966667);
    const checks = readiness.resolveCheckWorkflows([draftStub, ready], suiteIndex());
    const r = evalPr([...greenChecks().filter((c) => c.name !== "build"), ...checks]);
    expect(r.failures).toEqual([]);
    expect(r.verdict).toBe("PASS");
    expect(r.reports.join("\n")).toMatch(/re-run \(the latest of 2 runs from one source decides\): 'build'/);
  });

  it("keeps duplicate-source when two DIFFERENT workflow paths report one context", () => {
    const checks = readiness.resolveCheckWorkflows(
      [suiteRun(1, 93602180530), suiteRun(2, 93601966999)],
      suiteIndex(),
    );
    const r = evalPr([...greenChecks().filter((c) => c.name !== "build"), ...checks]);
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join("\n")).toMatch(/duplicate-source: 'build' was reported 2 times from 2 source/);
  });

  it("reports untrusted-source when the resolved workflow path is not the inventory's for that context", () => {
    const [run] = readiness.resolveCheckWorkflows([suiteRun(1, 93601966999)], suiteIndex());
    const r = evalPr([...greenChecks().filter((c) => c.name !== "build"), run]);
    expect(r.verdict).toBe("FAIL");
    expect(r.failures.join("\n")).toMatch(
      /untrusted-source: 'build' was reported by workflow '\.github\/workflows\/source-leak-gate\.yml', but the inventory expects '\.github\/workflows\/gates\.yml'/,
    );
  });

  it("leaves an unresolved check run judged exactly as before", () => {
    const [run] = readiness.resolveCheckWorkflows([suiteRun(1, 4242)], new Map());
    const r = evalPr([...greenChecks().filter((c) => c.name !== "build"), run]);
    expect(r.failures).toEqual([]);
    expect(r.verdict).toBe("PASS");
  });
});

describe("fixed engine source and subprocess boundary", () => {
  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-source-"));
    const engine = path.join(root, readiness.QUEUE_ENGINE_DIRECTORY); fs.mkdirSync(engine);
    const calls = [], state = { pin: readiness.QUEUE_ENGINE_PIN, dirty: "", candidate: GROUP, output: JSON.stringify({ fixture: true }), afterPin: null };
    let sourceReads = 0;
    const execute = (command, args, options) => {
      calls.push({ command, args, options });
      if (command !== "git") { if (state.error) throw state.error; return state.output; }
      const cwd = args[args.indexOf("-C") + 1], op = args.slice(args.indexOf("-C") + 2);
      if (op.join(" ") === "rev-parse --show-toplevel") return engine + "\n";
      if (op.join(" ") === "rev-parse HEAD") {
        if (cwd === engine) { sourceReads++; return (sourceReads > 1 && state.afterPin ? state.afterPin : state.pin) + "\n"; }
        return state.candidate + "\n";
      }
      if (op[0] === "status") return state.dirty;
      throw new Error("unexpected fixture command");
    };
    return { root, engine, calls, state, reader: readiness.createQueueEngineReader(root, "fixture-token", execute),
      dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
  }
  it("uses only fixed engine entrypoints and bounded clean environment with no shell", () => {
    const f = fixture();
    try {
      expect(f.reader("boundary", ["--repo", REPO, "--pr", "7", "--head", HEAD], GROUP)).toEqual({ fixture: true });
      const call = f.calls.find(c => c.command !== "git");
      expect(call.command).toBe("python3");
      expect(call.args).toEqual([path.join(f.engine, "scripts/verification-boundary.py"), "--repo", REPO, "--pr", "7", "--head", HEAD]);
      expect(call.options).toMatchObject({ cwd: f.root, timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
        env: { GH_HOST: "github.com", GH_TOKEN: "fixture-token", GIT_NO_REPLACE_OBJECTS: "1", PYTHONDONTWRITEBYTECODE: "1" } });
      expect(call.options.shell).toBeUndefined();
      expect(call.options.env.GIT_DIR).toBeUndefined();
      expect(call.options.env.PYTHONPATH).toBeUndefined();
      expect(call.options.env.NODE_OPTIONS).toBeUndefined();
      expect(f.calls.filter(c => c.command === "git" && c.args.at(-1) === "HEAD")).toHaveLength(4);
    } finally { f.dispose(); }
  });
  it("refuses wrong or dirty source, wrong candidate, and a source change during execution", () => {
    for (const changes of [{ pin: "f".repeat(40) }, { dirty: "?? untrusted.py\n" }, { candidate: HEAD }, { afterPin: "f".repeat(40) }]) {
      const f = fixture();
      try { Object.assign(f.state, changes); expect(() => f.reader("boundary", [], GROUP)).toThrow(); }
      finally { f.dispose(); }
    }
    const f = fixture();
    try {
      fs.rmdirSync(f.engine); fs.symlinkSync(f.root, f.engine);
      expect(() => f.reader("boundary", [], GROUP)).toThrow(/fixed checkout/);
      expect(f.calls).toEqual([]);
    } finally { f.dispose(); }
  });
  it("rejects incomplete output and subprocess failure without exposing captured credentials", () => {
    const f = fixture();
    try {
      f.state.output = '{}\n::notice::annotation'; expect(() => f.reader("boundary", [], GROUP)).toThrow(/one JSON document/);
      f.state.error = new Error("fixture-token in captured process output");
      expect(() => f.reader("boundary", [], GROUP)).toThrow(/engine refused or could not complete/);
      expect(() => f.reader("boundary", [], GROUP)).not.toThrow(/fixture-token/);
    } finally { f.dispose(); }
  });
});

describe("coordinated immutable queue engine pins", () => {
  it("binds all consumer selections to the same full source SHA without widening events or grants", () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const read = name => fs.readFileSync(path.join(root, name), "utf8");
    const pin = readiness.QUEUE_ENGINE_PIN;
    expect(pin).toMatch(/^[0-9a-f]{40}$/);
    const suite = JSON.parse(read(".github/gate-suite.json"));
    const attribution = suite.requiredContexts.filter(c => c.context === "truthful-attribution-gate / truthful-attribution-gate");
    expect(attribution).toHaveLength(1); expect(attribution[0].pinned).toBe(pin);
    expect(attribution[0].allowedEvents).toEqual(["pull_request", "push", "merge_group"]);
    const caller = read(".github/workflows/truthful-attribution-gate.yml");
    expect(caller).toContain(`truthful-attribution-gate.yml@${pin}`);
    expect(caller).toMatch(new RegExp(`ref: ${pin}(?:\\s|$)`));
    expect(read(".github/workflows/attribution-record-reverify.yml")).toMatch(new RegExp(`ref: ${pin}(?:\\s|$)`));
    const workflow = read(".github/workflows/merge-readiness-reusable.yml");
    expect(workflow).toContain(`ref: ${pin}`);
    expect(workflow).toContain(`path: ${readiness.QUEUE_ENGINE_DIRECTORY}`);
    expect(workflow).toContain("fetch-depth: ${{ github.event_name == 'merge_group' && '0' || '1' }}");
    expect(workflow).not.toMatch(/(?:contents|checks|actions|pull-requests): write/);
    expect(workflow).toContain("timeout-minutes: 115");
  });
});
