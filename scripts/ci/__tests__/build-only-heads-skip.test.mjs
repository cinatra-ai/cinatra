// Every pull request workflow but the image build skips a build-only head —
// cinatra#3890.
//
// The merge tooling opens pull requests whose head branch, in this
// repository, starts with `merge-queue/` or `merge-batch/`: they exist only to
// run the image workflow on the exact tree main is about to carry and are
// never merged. A fork's branch of the same name is an ordinary head. This test
// reads EVERY file under .github/workflows/ and pins both sides of the one
// condition that skips them (scripts/ci/build-only-heads.mjs):
//
//   1. every workflow triggered by `pull_request`, except `build-image.yml`,
//      skips every one of its jobs on such a head:
//      each job carries the condition, or needs a job that is skipped there
//      and has no status function (always(), !cancelled(), failure(),
//      success()) that would let it run after a skipped need;
//   2. the condition skips the two build-only prefixes on a head of this
//      repository only; it runs for an ordinary head branch, for a fork's head
//      of any name, and for every event that is not a pull request (a push, a
//      merge queue group, a schedule, a run by hand: no head repository, an
//      empty head reference);
//   3. every context the branch rules require (read from the repository's own
//      records, never written here) resolves to the one job that produces it,
//      named as the platform names it, and that job and every job it needs
//      run on an ordinary branch as before: a required context skipped on an
//      ordinary pull request cannot pass this test (pinned by fixtures). The contexts produced by
//      `build-image.yml` stay free of the condition: that workflow's run on a
//      build-only head is the proof of the tree.
//
// The workflows are read line-based with the repository's own readers
// (parseTriggers / parseJobs / parseJobAttrs), as the other workflow tests
// read them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BUILD_ONLY_HEAD_CONDITION,
  IMAGE_WORKFLOW,
  evaluateHeadCondition,
  isBuildOnlyHead,
  splitBuildOnlyHeadGuard,
} from "../build-only-heads.mjs";
import {
  REQUIRED_CONTEXTS as COVERAGE_GUARD_CONTEXTS,
  displayNameOf,
  parseJobs,
  parseTriggers,
} from "../merge-group-coverage-guard.mjs";
import { SELF_CONTEXT, isConditional, parseJobAttrs } from "../merge-readiness-inventory.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");

const read = (file) => fs.readFileSync(path.join(WORKFLOWS_DIR, file), "utf8");
const workflowFiles = () =>
  fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();

/**
 * Workflows left out of the scope although a pull request starts them, each
 * with its reason. They are pinned to carry no head-branch condition.
 */
const LEFT_OUT = {
  [IMAGE_WORKFLOW]: "the image build must run on a build-only head — its run proves the tree",
  "files-hold.yml":
    "a pull_request_target workflow whose own test pins that its file names no pull request reference, github.head_ref included; it runs a short node script from the default branch",
};

/** The repository the workflows run in, as `github.repository` reads. */
const REPOSITORY = "cinatra-ai/cinatra";
const FORK = "someone/cinatra";

/**
 * Heads and whether the jobs run for them: the head branch, the head
 * repository (null on a push, which has no pull request) and this repository.
 */
const HEADS = [
  { label: "this repository's ordinary branch", headRef: "feat/x", headRepo: REPOSITORY, runs: true },
  { label: "this repository's merge-queue head", headRef: "merge-queue/cinatra-12-g1", headRepo: REPOSITORY, runs: false },
  { label: "this repository's merge-queue head", headRef: "merge-queue/x", headRepo: REPOSITORY, runs: false },
  { label: "this repository's merge-batch head", headRef: "merge-batch/x", headRepo: REPOSITORY, runs: false },
  { label: "a fork's ordinary branch", headRef: "feat/x", headRepo: FORK, runs: true },
  { label: "a fork's head named merge-queue/", headRef: "merge-queue/x", headRepo: FORK, runs: true },
  { label: "a fork's head named merge-batch/", headRef: "merge-batch/x", headRepo: FORK, runs: true },
  { label: "a push", headRef: "", headRepo: null, runs: true },
].map((h) => ({ ...h, repository: REPOSITORY }));

/** The heads a job must run for: every ordinary one, and a push. */
const ORDINARY = HEADS.filter((h) => h.runs);

/** A status function lets a job run after a skipped need. */
const STATUS_FUNCTION = /\b(always|cancelled|failure|success)\s*\(/;

/**
 * The workflow files whose contexts the repository rulesets require and that no
 * committed mirror lists. Their contexts are derived from the files, as the
 * platform names them; no context name is written here.
 */
const RULESET_CALLERS = ["actions-pinned-gate.yml", "gitignore-gate.yml", "secret-scan-gate.yml"];

/**
 * The contexts the branch rules of `main` require, read at test time from the
 * repository's own records: the branch-protection mirror, the gate suite, the
 * coverage guard's mirror, the merge readiness context and the contexts the
 * ruleset callers above produce. At least this many were required when the
 * rules were last read.
 */
const REQUIRED_AT_LEAST = 21;

/** Split a workflow's `jobs:` block into {job id -> the job's own lines}. */
function jobBlocks(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  const jobs = new Map();
  if (start === -1) return jobs;
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== "" && /^\S/.test(line)) break;
    const head = line.match(/^ {2}(['"]?)([A-Za-z_][\w-]*)\1:\s*(#.*)?$/);
    if (head) {
      current = [];
      jobs.set(head[2], current);
      continue;
    }
    if (current) current.push(line);
  }
  return jobs;
}

/** The job-level `needs:` in its inline, flow-list or block-list form. */
function needsOf(lines) {
  const at = lines.findIndex((l) => /^ {4}needs:/.test(l));
  if (at === -1) return [];
  const value = lines[at].replace(/^ {4}needs:\s*/, "").replace(/\s+#.*$/, "").trim();
  let raw;
  if (value === "") {
    raw = [];
    for (const l of lines.slice(at + 1)) {
      if (l.trim() === "" || /^\s*#/.test(l)) continue;
      const item = l.match(/^ {6,}-\s*(.+?)\s*$/);
      if (!item) break;
      raw.push(item[1]);
    }
  } else {
    raw = value.startsWith("[") ? value.replace(/^\[|\]$/g, "").split(",") : [value];
  }
  return raw.map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}

/** One workflow, read: its triggers and {job id -> { if, ifCount, needs, uses, name }}. */
function readWorkflow(text) {
  const blocks = jobBlocks(text);
  const attrs = parseJobAttrs(text);
  const jobs = new Map();
  for (const job of parseJobs(text)) {
    const lines = blocks.get(job.key) ?? [];
    jobs.set(job.key, {
      name: displayNameOf(job),
      if: attrs.get(job.key)?.if ?? null,
      ifCount: lines.filter((l) => /^ {4}if:/.test(l)).length,
      needs: needsOf(lines),
      uses: attrs.get(job.key)?.uses ?? null,
      parsedBlock: blocks.has(job.key),
    });
  }
  return { triggers: parseTriggers(text) ?? [], jobs };
}

const inScope = (file, triggers) => !(file in LEFT_OUT) && triggers.includes("pull_request");

/**
 * The jobs of a workflow that a build-only head skips: a job carrying the
 * condition, or a job with no status function that needs one of them.
 */
function skippedOnBuildHeads(jobs) {
  const memo = new Map();
  const visit = (id, seen) => {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return false;
    seen.add(id);
    const job = jobs.get(id);
    let result = false;
    if (job) {
      const split = splitBuildOnlyHeadGuard(job.if);
      if (split.carries) result = true;
      else if (!STATUS_FUNCTION.test(job.if ?? "")) result = job.needs.some((n) => visit(n, seen));
    }
    memo.set(id, result);
    return result;
  };
  return new Set([...jobs.keys()].filter((id) => visit(id, new Set())));
}

/** The form a workflow uses, for the messages: every job, or the first jobs only. */
function formOf(jobs) {
  const carrying = [...jobs.values()].filter((j) => splitBuildOnlyHeadGuard(j.if).carries).length;
  if (carrying === 0) return "no job carries the condition";
  return carrying === jobs.size ? "per job" : "first job";
}

/** Problems with the head reference in one job's `if:` (empty when none). */
function headRefProblems(file, id, job) {
  const problems = [];
  if (job.ifCount > 1) problems.push(`${file}: job \`${id}\` declares \`if:\` ${job.ifCount} times`);
  const split = splitBuildOnlyHeadGuard(job.if);
  if (split.carries) {
    if (split.existing?.includes("head_ref")) {
      problems.push(`${file}: job \`${id}\` reads the head branch in its own condition too: ${split.existing}`);
    }
  } else if (HEAD_READ.test(job.if ?? "")) {
    problems.push(`${file}: job \`${id}\` reads the pull request's head outside the one condition: ${job.if}`);
  }
  return problems;
}

/** A condition reading the pull request's head branch or head repository. */
const HEAD_READ = /head_ref|pull_request\.head/;

/**
 * The contexts one workflow produces, as the platform names them, each with
 * the job that produces it: a job's `name:` (else its key); a reusable call
 * `caller / called`, the called job read from a local file, and the caller's
 * own name twice for a remote one (the repository's convention for its callers).
 */
function contextsProduced(file, workflow, readLocal) {
  const out = [];
  for (const [job, attrs] of workflow.jobs) {
    if (attrs.uses?.startsWith("./")) {
      const called = readLocal(path.basename(attrs.uses));
      for (const inner of called?.jobs.values() ?? []) out.push({ context: `${attrs.name} / ${inner.name}`, file, job });
    } else if (attrs.uses) {
      out.push({ context: `${attrs.name} / ${attrs.name}`, file, job });
    } else {
      out.push({ context: attrs.name, file, job });
    }
  }
  return out;
}

/**
 * The problems of one required context against a set of workflows
 * ([{ file, triggers, jobs }]): it has exactly one producing job; that job and
 * every job it needs run on every ordinary head and on a push; outside the
 * image build, a build-only head skips it; in the image build, nothing skips it.
 */
function requiredContextProblems(context, workflows) {
  const byFile = new Map(workflows.map((w) => [w.file, w]));
  const producers = workflows
    .flatMap((w) => contextsProduced(w.file, w, (f) => byFile.get(f) ?? null))
    .filter((p) => p.context === context);
  if (producers.length !== 1) {
    return [`${context}: produced by ${producers.length} jobs (${producers.map((p) => `${p.file}#${p.job}`).join(", ")}), not exactly one`];
  }
  const [{ file, job }] = producers;
  const workflow = byFile.get(file);
  const problems = [];
  const chain = [];
  const walk = (id) => {
    if (chain.includes(id)) return;
    chain.push(id);
    for (const n of workflow.jobs.get(id)?.needs ?? []) walk(n);
  };
  walk(job);
  for (const id of chain) {
    const each = workflow.jobs.get(id);
    if (!each) {
      problems.push(`${file}: needed job \`${id}\` is missing`);
      continue;
    }
    problems.push(...headRefProblems(file, id, each));
    const split = splitBuildOnlyHeadGuard(each.if);
    if (file === IMAGE_WORKFLOW) {
      if (split.carries) problems.push(`${context}: ${file} job \`${id}\` must run on a build-only head`);
      continue;
    }
    if (!split.carries) continue;
    const inner = each.if.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, "");
    const condition = inner.slice(inner.length - BUILD_ONLY_HEAD_CONDITION.length);
    for (const head of ORDINARY) {
      if (!evaluateHeadCondition(condition, head)) {
        problems.push(`${context}: ${file} job \`${id}\` is skipped for ${head.label} ${JSON.stringify(head.headRef)}`);
      }
    }
  }
  if (file !== IMAGE_WORKFLOW && !skippedOnBuildHeads(workflow.jobs).has(job)) {
    problems.push(`${context}: ${file} job \`${job}\` runs on a build-only head`);
  }
  return problems;
}

const WORKFLOWS = workflowFiles().map((file) => ({ file, ...readWorkflow(read(file)) }));

describe("the condition itself", () => {
  it("is the one expression, written once", () => {
    expect(BUILD_ONLY_HEAD_CONDITION).toBe(
      "!(github.event.pull_request.head.repo.full_name == github.repository && (startsWith(github.head_ref, 'merge-queue/') || startsWith(github.head_ref, 'merge-batch/')))",
    );
  });

  for (const head of HEADS) {
    it(`${head.runs ? "runs" : "skips"} for ${head.label} ${JSON.stringify(head.headRef)}`, () => {
      expect(evaluateHeadCondition(BUILD_ONLY_HEAD_CONDITION, head)).toBe(head.runs);
      expect(isBuildOnlyHead(head)).toBe(!head.runs);
    });
  }

  it("reads the platform's startsWith and == without regard to case", () => {
    const head = { headRef: "Merge-Queue/x", headRepo: "Cinatra-AI/Cinatra", repository: REPOSITORY };
    expect(evaluateHeadCondition(BUILD_ONLY_HEAD_CONDITION, head)).toBe(false);
  });

  it("refuses an expression it does not know instead of taking it as true", () => {
    const head = HEADS[0];
    expect(() => evaluateHeadCondition("github.event_name == 'push'", head)).toThrow();
    expect(() => evaluateHeadCondition("!startsWith(github.base_ref, 'x')", head)).toThrow();
  });

  it("splits the two canonical forms and nothing else", () => {
    expect(splitBuildOnlyHeadGuard(`\${{ ${BUILD_ONLY_HEAD_CONDITION} }}`)).toEqual({ carries: true, existing: null });
    expect(splitBuildOnlyHeadGuard(`\${{ (always()) && ${BUILD_ONLY_HEAD_CONDITION} }}`)).toEqual({
      carries: true,
      existing: "always()",
    });
    // An unparenthesised `a || b` would bind the condition to `b` alone.
    expect(splitBuildOnlyHeadGuard(`\${{ a || b && ${BUILD_ONLY_HEAD_CONDITION} }}`).carries).toBe(false);
    expect(splitBuildOnlyHeadGuard(`\${{ (a) || (b) && ${BUILD_ONLY_HEAD_CONDITION} }}`).carries).toBe(false);
    expect(splitBuildOnlyHeadGuard("${{ !startsWith(github.head_ref, 'merge-queue/') }}").carries).toBe(false);
    expect(splitBuildOnlyHeadGuard(null)).toEqual({ carries: false, existing: null });
  });
});

describe("the merge readiness inventory reads the condition as no guard", () => {
  // A candidate never meets a build-only head, so the condition must not turn
  // a job that has to succeed into one whose `skipped` the readiness accepts.
  it("keeps a job with no other guard, always() or sole !cancelled() a job that must succeed", () => {
    expect(isConditional(`\${{ ${BUILD_ONLY_HEAD_CONDITION} }}`)).toBe(false);
    expect(isConditional(`\${{ (always()) && ${BUILD_ONLY_HEAD_CONDITION} }}`)).toBe(false);
    expect(isConditional(`\${{ (!cancelled()) && ${BUILD_ONLY_HEAD_CONDITION} }}`)).toBe(false);
  });

  it("keeps a job's own selection guard beside it skippable", () => {
    expect(isConditional(`\${{ (needs.changes.outputs.code == 'true') && ${BUILD_ONLY_HEAD_CONDITION} }}`)).toBe(true);
    expect(isConditional(`\${{ (always() && needs.detect.outputs.run == 'true') && ${BUILD_ONLY_HEAD_CONDITION} }}`)).toBe(true);
  });

  it("reads a head-branch test outside the canonical form as a guard", () => {
    expect(isConditional("${{ !startsWith(github.head_ref, 'merge-queue/') }}")).toBe(true);
  });
});

describe("the reading of a workflow's jobs", () => {
  const withCondition = `\${{ ${BUILD_ONLY_HEAD_CONDITION} }}`;
  const jobsOf = (text) => readWorkflow(text).jobs;

  it("counts a job as skipped when it needs a skipped first job without a status function", () => {
    const jobs = jobsOf(`on: pull_request
jobs:
  changes:
    if: ${withCondition}
    runs-on: x
  heavy:
    needs: [changes]
    if: \${{ needs.changes.outputs.code == 'true' }}
    runs-on: x
  later:
    needs:
      - heavy
    runs-on: x
`);
    expect([...skippedOnBuildHeads(jobs)].sort()).toEqual(["changes", "heavy", "later"]);
    expect(formOf(jobs)).toBe("first job");
  });

  it("refuses the first-job form when a dependent job runs after a skipped need", () => {
    for (const guard of ["${{ always() }}", "${{ !cancelled() }}", "${{ failure() }}"]) {
      const jobs = jobsOf(`on: pull_request
jobs:
  detect:
    if: ${withCondition}
    runs-on: x
  verdict:
    needs: detect
    if: ${guard}
    runs-on: x
`);
      expect(skippedOnBuildHeads(jobs).has("verdict"), guard).toBe(false);
    }
  });

  it("flags a head reference outside the one condition", () => {
    const jobs = jobsOf(`on: pull_request
jobs:
  a:
    if: \${{ startsWith(github.head_ref, 'feat/') }}
    runs-on: x
`);
    expect(headRefProblems("x.yml", "a", jobs.get("a"))).not.toEqual([]);
  });
});

describe("every pull request workflow but the image build skips a build-only head", () => {
  const scoped = WORKFLOWS.filter((w) => inScope(w.file, w.triggers));

  it("reads a non-empty set of pull request workflows, and the left-out ones exist", () => {
    expect(scoped.length).toBeGreaterThan(0);
    for (const file of Object.keys(LEFT_OUT)) expect(WORKFLOWS.map((w) => w.file)).toContain(file);
    expect(scoped.map((w) => w.file).filter((f) => f in LEFT_OUT)).toEqual([]);
  });

  for (const { file, jobs } of scoped) {
    it(`${file}: every job is skipped on a build-only head`, () => {
      expect(jobs.size, `${file}: no jobs read`).toBeGreaterThan(0);
      for (const [id, job] of jobs) {
        expect(job.parsedBlock, `${file}: job \`${id}\` is not a two-space job key this reader knows`).toBe(true);
      }
      const skipped = skippedOnBuildHeads(jobs);
      const missing = [...jobs.keys()].filter((id) => !skipped.has(id));
      expect(
        missing,
        `${file} (${formOf(jobs)}): these jobs run on a build-only head — give each \`if: \${{ ${BUILD_ONLY_HEAD_CONDITION} }}\`, joined as \`(EXISTING) && \` after a condition it already has, or let it need a job that carries it without always(), !cancelled(), failure() or success()`,
      ).toEqual([]);
    });

    it(`${file}: the condition is the one expression, and it runs as before on an ordinary branch and on a push`, () => {
      const problems = [];
      for (const [id, job] of jobs) {
        problems.push(...headRefProblems(file, id, job));
        const split = splitBuildOnlyHeadGuard(job.if);
        if (!split.carries) continue;
        const inner = job.if.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, "");
        const condition = inner.slice(inner.length - BUILD_ONLY_HEAD_CONDITION.length);
        for (const head of HEADS) {
          if (evaluateHeadCondition(condition, head) !== head.runs) {
            problems.push(`${file}: job \`${id}\` ${head.runs ? "skips" : "runs"} for ${head.label} ${JSON.stringify(head.headRef)}`);
          }
        }
      }
      expect(problems).toEqual([]);
    });
  }
});

describe("the workflows outside the scope are left alone", () => {
  for (const { file, triggers, jobs } of WORKFLOWS.filter((w) => !inScope(w.file, w.triggers))) {
    it(`${file} carries no head-branch condition`, () => {
      const offenders = [...jobs]
        .filter(([, job]) => splitBuildOnlyHeadGuard(job.if).carries || (job.if ?? "").includes("head_ref"))
        .map(([id]) => id);
      expect(
        offenders,
        file in LEFT_OUT
          ? `${file}: ${LEFT_OUT[file]}`
          : `${file} runs on ${triggers.join(", ")} only: the head branch is always empty there`,
      ).toEqual([]);
    });
  }
});

describe("the required-context check refuses a context skipped on an ordinary branch", () => {
  const cond = `\${{ ${BUILD_ONLY_HEAD_CONDITION} }}`;
  const wf = (file, body) => ({ file, ...readWorkflow(`on: pull_request\njobs:\n${body}`) });
  const image = wf(IMAGE_WORKFLOW, "  image-job:\n    name: image check\n    runs-on: x\n");

  it("passes a required job that carries the one condition", () => {
    const ok = wf("a.yml", `  req:\n    name: required check\n    if: ${cond}\n    runs-on: x\n`);
    expect(requiredContextProblems("required check", [ok, image])).toEqual([]);
    expect(requiredContextProblems("image check", [ok, image])).toEqual([]);
  });

  it("refuses a required job skipped on an ordinary branch by another head reading", () => {
    for (const guard of [
      "${{ !startsWith(github.head_ref, 'feat/') }}",
      "${{ github.event.pull_request.head.repo.full_name != github.repository }}",
    ]) {
      const bad = wf("a.yml", `  req:\n    name: required check\n    if: ${guard}\n    runs-on: x\n`);
      expect(requiredContextProblems("required check", [bad, image]), guard).not.toEqual([]);
    }
  });

  it("refuses a required job whose needed job is skipped on an ordinary branch", () => {
    const bad = wf(
      "a.yml",
      `  first:\n    if: \${{ startsWith(github.head_ref, 'merge-queue/') }}\n    runs-on: x\n  req:\n    name: required check\n    needs: first\n    if: ${cond}\n    runs-on: x\n`,
    );
    expect(requiredContextProblems("required check", [bad, image])).not.toEqual([]);
  });

  it("refuses a required job that still runs on a build-only head, and a condition in the image build", () => {
    const runs = wf("a.yml", "  req:\n    name: required check\n    runs-on: x\n");
    expect(requiredContextProblems("required check", [runs, image])).not.toEqual([]);
    const guarded = wf(IMAGE_WORKFLOW, `  image-job:\n    name: image check\n    if: ${cond}\n    runs-on: x\n`);
    expect(requiredContextProblems("image check", [guarded])).not.toEqual([]);
  });

  it("refuses a required context no job produces, or two jobs produce", () => {
    const one = wf("a.yml", `  req:\n    name: required check\n    if: ${cond}\n    runs-on: x\n`);
    const two = wf("b.yml", `  req:\n    name: required check\n    if: ${cond}\n    runs-on: x\n`);
    expect(requiredContextProblems("missing check", [one, image])).not.toEqual([]);
    expect(requiredContextProblems("required check", [one, two, image])).not.toEqual([]);
  });

  it("names a reusable call's context as the platform does", () => {
    const caller = wf("c.yml", `  outer:\n    if: ${cond}\n    uses: ./.github/workflows/d.yml\n`);
    const called = { file: "d.yml", ...readWorkflow("on: workflow_call\njobs:\n  inner:\n    name: inner check\n    runs-on: x\n") };
    const remote = wf("e.yml", `  far:\n    if: ${cond}\n    uses: some/where/.github/workflows/f.yml@0123456789012345678901234567890123456789\n`);
    expect(requiredContextProblems("outer / inner check", [caller, called, remote, image])).toEqual([]);
    expect(requiredContextProblems("far / far", [caller, called, remote, image])).toEqual([]);
  });
});

describe("every required context runs on an ordinary pull request", () => {
  const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"));
  const byFile = new Map(WORKFLOWS.map((w) => [w.file, w]));
  const rulesetContexts = RULESET_CALLERS.flatMap((file) => {
    const workflow = byFile.get(file);
    return workflow ? contextsProduced(file, workflow, (f) => byFile.get(f) ?? null).map((p) => p.context) : [];
  });
  const required = [
    ...new Set([
      ...readJson(".github/branch-protections.json").required_status_checks.contexts,
      ...readJson(".github/gate-suite.json").requiredContexts.map((c) => c.context),
      ...COVERAGE_GUARD_CONTEXTS,
      SELF_CONTEXT,
      ...rulesetContexts,
    ]),
  ].sort();

  it("reads the required contexts from the repository's records, no fewer than the rules held", () => {
    for (const file of RULESET_CALLERS) expect(byFile.has(file), `${file} is missing`).toBe(true);
    expect(rulesetContexts).toHaveLength(RULESET_CALLERS.length);
    expect(required.length).toBeGreaterThanOrEqual(REQUIRED_AT_LEAST);
  });

  for (const context of required) {
    it(`${context}: one producing job, run on every ordinary head and a push, skipped on a build-only head outside the image build`, () => {
      expect(requiredContextProblems(context, WORKFLOWS)).toEqual([]);
    });
  }
});
